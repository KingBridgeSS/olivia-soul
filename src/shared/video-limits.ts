export const VIDEO_FPS = 25;
export const FRAME_SAMPLES = 960;
export const GPU_CHUNK_FRAMES = 24;
// The server checks a 3-chunk lookahead BEFORE producing a complete chunk.
// A partially played chunk can therefore admit almost 4 chunks (96 frames).
// Keep one extra chunk for the current frame, decoding and IPC delivery jitter.
export const MAX_VIDEO_FRAMES = GPU_CHUNK_FRAMES * 5;
