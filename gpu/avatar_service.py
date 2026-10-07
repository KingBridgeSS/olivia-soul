"""Single-GPU FlashHead worker. Run from the SoulX-FlashHead checkout.

Only synthetic idle animation is persisted. Call audio/video stays in bounded memory.
The service binds to loopback; access it through the application's SSH tunnel.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import io
import json
import logging
import os
import struct
import time
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path

def service_options(argv=None):
    parser = argparse.ArgumentParser(description="Olivia Soul single-client FlashHead GPU service (loopback only)")
    parser.add_argument("--flashhead-root", type=Path, default=Path(os.environ.get("FLASHHEAD_ROOT", os.getcwd())))
    parser.add_argument("--checkpoint", type=Path, default=Path("models/SoulX-FlashHead-1_3B"))
    parser.add_argument("--wav2vec", type=Path, default=Path("models/wav2vec2-base-960h"))
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--portrait", type=Path)
    parser.add_argument("--host", choices=["127.0.0.1", "::1"], default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    return args


# Parse help before importing GPU dependencies so --help works without CUDA/Python packages.
OPTIONS = service_options() if __name__ == "__main__" else service_options([])

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

log = logging.getLogger("avatar")
CHUNK_SAMPLES = 23040  # 24 frames / 25 fps, at the original 24 kHz playback rate.
MAX_AUDIO_BYTES = 24000 * 2 * 600
ROOT = OPTIONS.data_dir.resolve()
engine = None
occupied = False


class Engine:
    def __init__(self):
        import torch
        from flash_head.inference import get_pipeline, get_base_data, get_infer_params
        self.torch = torch
        self.pipeline = get_pipeline(
            world_size=1, ckpt_dir=str((OPTIONS.flashhead_root / OPTIONS.checkpoint).resolve()),
            model_type="lite", wav2vec_dir=str((OPTIONS.flashhead_root / OPTIONS.wav2vec).resolve()),
        )
        # Keep the top of the portrait (including hair) when fitting the square model input.
        # This matches object-position: center top in the browser's static portrait.
        from PIL import Image, ImageOps
        ROOT.mkdir(parents=True, exist_ok=True)
        with Image.open(OPTIONS.portrait or ROOT / "portrait.png") as portrait:
            ImageOps.fit(portrait.convert("RGB"), (512, 512), centering=(.5, 0)).save(ROOT / "portrait-square.png")
        get_base_data(self.pipeline, str(ROOT / "portrait-square.png"), 9999, False)
        self.params = get_infer_params()
        assert self.params["frame_num"] - self.params["motion_frames_num"] == 24
        self.timings = []
        self.reset()
        # Compile and warm up all inference paths before accepting a call.
        idle = []
        for _ in range(4):
            frames = self.generate(bytes(CHUNK_SAMPLES * 2))
            idle.extend(frames)
        self.write_idle(idle)
        self.reset()

    def reset(self):
        self.pipeline.reset_person_name()
        self.audio = deque([0.0] * (24000 * 8), maxlen=24000 * 8)

    def generate(self, pcm):
        from scipy.signal import resample_poly
        from PIL import Image
        from flash_head.inference import get_audio_embedding, run_pipeline
        start = time.monotonic()
        self.audio.extend((np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768).tolist())
        # Resample the complete bounded history to avoid independent-chunk filter edges.
        audio = resample_poly(np.asarray(self.audio, dtype=np.float32), 2, 3)
        embedding = get_audio_embedding(self.pipeline, audio, 200 - 33, 200)
        video = run_pipeline(self.pipeline, embedding)[self.params["motion_frames_num"]:]
        frames = video.to(self.torch.uint8).cpu().numpy()
        encoded = []
        for frame in frames:
            buf = io.BytesIO()
            Image.fromarray(frame).save(buf, format="JPEG", quality=82)
            encoded.append(buf.getvalue())
        seconds = time.monotonic() - start
        self.timings.append(seconds)
        self.timings = self.timings[-20:]
        log.warning("chunk: %.3fs, JPEG: %d bytes", seconds, sum(map(len, encoded)))
        return encoded

    def write_idle(self, frames):
        import av
        from PIL import Image
        # Ping-pong avoids a hard cut at the loop boundary. This is synthetic silence.
        with av.open(str(ROOT / "idle.mp4"), "w") as container:
            stream = container.add_stream("libx264", rate=25)
            stream.width = stream.height = 512
            stream.pix_fmt = "yuv420p"
            stream.options = {"crf": "22", "preset": "fast"}
            for jpeg in frames + frames[-2:0:-1]:
                frame = av.VideoFrame.from_image(Image.open(io.BytesIO(jpeg)))
                for packet in stream.encode(frame):
                    container.mux(packet)
            for packet in stream.encode():
                container.mux(packet)


@asynccontextmanager
async def lifespan(app):
    global engine
    engine = await asyncio.to_thread(Engine)
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)


@app.get("/health")
async def health():
    return {"ready": engine is not None, "busy": occupied,
            "chunk_seconds": engine.timings if engine else [], "chunk_duration": .96}


@app.get("/idle.mp4")
async def idle():
    return FileResponse(ROOT / "idle.mp4", media_type="video/mp4")


class Stream:
    def __init__(self, ws):
        self.ws = ws
        self.generation = None
        self.revision = 0
        self.buffer = bytearray()
        self.ended = False
        self.played = 0
        self.changed = asyncio.Event()

    async def receive(self):
        while True:
            event = await self.ws.receive()
            if event["type"] == "websocket.disconnect":
                return
            if event.get("bytes") is not None:
                data = event["bytes"]
                if len(data) < 4 or (len(data) - 4) % 2:
                    raise ValueError("Invalid PCM")
                generation, = struct.unpack_from("<I", data)
                if generation == self.generation and not self.ended:
                    if len(self.buffer) + len(data) - 4 > MAX_AUDIO_BYTES:
                        raise ValueError(
                            f"Audio backlog: buffered={len(self.buffer) / 48000:.2f}s "
                            f"incoming={(len(data) - 4) / 48000:.2f}s limit={MAX_AUDIO_BYTES / 48000:.0f}s"
                        )
                    self.buffer.extend(data[4:])
            else:
                data = json.loads(event.get("text") or "{}")
                kind = data.get("type")
                if kind in {"begin", "interrupt"}:
                    self.revision += 1
                    self.generation = data["generation"] if kind == "begin" else None
                    self.buffer.clear()
                    self.ended = False
                    self.played = 0
                elif data.get("generation") == self.generation:
                    if kind == "end":
                        self.ended = True
                    elif kind == "progress":
                        self.played = max(self.played, int(data["samples"]))
            self.changed.set()

    async def produce(self):
        revision = -1
        frame_index = 0
        while True:
            self.changed.clear()
            if self.revision != revision:
                revision = self.revision
                frame_index = 0
                await asyncio.to_thread(engine.reset)
                if self.revision != revision:
                    continue
            enough = len(self.buffer) >= CHUNK_SAMPLES * 2 or (self.ended and self.buffer)
            credit = frame_index * 960 < self.played + CHUNK_SAMPLES * 3
            if self.generation is None or not enough or not credit:
                await self.changed.wait()
                continue
            generation = self.generation
            pcm = bytes(self.buffer[:CHUNK_SAMPLES * 2])
            del self.buffer[:CHUNK_SAMPLES * 2]
            valid_frames = (len(pcm) // 2 + 959) // 960
            pcm += bytes(CHUNK_SAMPLES * 2 - len(pcm))
            # An in-flight CUDA call finishes before the next reset. Its output can be discarded.
            frames = await asyncio.to_thread(engine.generate, pcm)
            if self.revision != revision:
                continue
            for jpeg in frames[:valid_frames]:
                if self.revision != revision:
                    break
                await asyncio.wait_for(self.ws.send_bytes(struct.pack("<II", generation, frame_index) + jpeg), timeout=3)
                frame_index += 1


@app.websocket("/stream")
async def stream(ws: WebSocket):
    global occupied
    await ws.accept()
    if occupied:
        await ws.send_json({"type": "unavailable", "reason": "busy"})
        await ws.close()
        return
    occupied = True
    await ws.send_json({"type": "ready", "fps": 25, "width": 512, "height": 512})
    session = Stream(ws)
    tasks = [asyncio.create_task(session.receive(), name="receive"),
             asyncio.create_task(session.produce(), name="produce")]
    stage = "stream"
    try:
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            stage = task.get_name()
            task.result()
    except (WebSocketDisconnect, RuntimeError, ValueError, asyncio.TimeoutError):
        log.warning("Avatar stream failed: stage=%s generation=%s buffered=%.2fs",
                    stage, session.generation, len(session.buffer) / 48000, exc_info=True)
    finally:
        # Do not allow a new session to mutate the pipeline while CUDA is still running.
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        # A single dedicated executor serializes reset/generate, including cancelled awaits.
        await asyncio.to_thread(lambda: None)
        occupied = False
        with contextlib.suppress(Exception):
            await ws.close()


if __name__ == "__main__":
    import sys
    import uvicorn
    from concurrent.futures import ThreadPoolExecutor
    # FlashHead's global inference state must have one owner, including during teardown.
    async def serve():
        asyncio.get_running_loop().set_default_executor(ThreadPoolExecutor(max_workers=1))
        await uvicorn.Server(uvicorn.Config(app, host=OPTIONS.host, port=OPTIONS.port, log_level="info")).serve()
    OPTIONS.flashhead_root = OPTIONS.flashhead_root.resolve()
    OPTIONS.portrait = OPTIONS.portrait.resolve() if OPTIONS.portrait else None
    os.chdir(OPTIONS.flashhead_root)
    sys.path.insert(0, str(OPTIONS.flashhead_root))
    asyncio.run(serve())
