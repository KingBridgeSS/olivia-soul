# GPU 部署

首版支持 Windows 客户端 + 远程 Linux NVIDIA GPU，也可配置本机服务地址。无 GPU 时设置 `gpu_enabled=false`，使用本地待机动画，语音与任务照常。CPU、原生 Windows CUDA、WSL 推理未验证。

## 服务环境

服务使用 SoulX-FlashHead Lite，单 GPU、单客户端。原部署记录为 RTX 4090；这里不将其当成最低显存保证，也不承诺其他卡实时性能。新用户安装步骤尚未在独立 GPU 环境实测。

以下固定上游源码为准备时的 `9bc03de06bb0de82cd6bc477804512ae06144bf2`。它是本次公开准备核对的源码，不代表与原私人部署的依赖完全相同。上游 requirements 有版本范围，CUDA 和完整 Python 环境并未完全锁定；成功部署后保存 `pip freeze`、驱动版本、模型 revision 和推理时长。

在 Linux 准备两个相邻目录 `olivia-soul` 与 `SoulX-FlashHead`：

```bash
git clone https://github.com/Soul-AILab/SoulX-FlashHead.git
cd SoulX-FlashHead
git checkout 9bc03de06bb0de82cd6bc477804512ae06144bf2
conda create -n olivia-avatar python=3.10
conda activate olivia-avatar
python -m pip install torch==2.7.1 torchvision==0.22.1 --index-url https://download.pytorch.org/whl/cu128
python -m pip install -r requirements.txt
python -m pip install ninja
python -m pip install flash_attn==2.8.0.post2 --no-build-isolation
python -m pip install -r ../olivia-soul/gpu/requirements-service.txt
python -m pip check
conda install -c conda-forge ffmpeg=7
```

FlashAttention 编译需要匹配的 CUDA 工具链；具体 wheel、驱动要求与可选 SageAttention 参见 [上游安装说明](https://github.com/Soul-AILab/SoulX-FlashHead/tree/9bc03de06bb0de82cd6bc477804512ae06144bf2)。适配依赖文件仅固定 FastAPI/uvicorn/PyAV，不是完整 CUDA 锁文件。如依赖冲突，按上游调整并记录，勿宣称未经测试的组合已验证。

自行下载模型，保留它们各自的许可：

```bash
python -m pip install huggingface_hub
hf download Soul-AILab/SoulX-FlashHead-1_3B --local-dir models/SoulX-FlashHead-1_3B
hf download facebook/wav2vec2-base-960h --local-dir models/wav2vec2-base-960h
```

上述模型命令使用仓库当前 revision；可加 `--revision` 固定自己验收的模型提交。模型不进入本项目仓库或便携包。

## 启动

在 FlashHead checkout 目录中运行，人物使用公开仓库默认素材，也可以传入自有图片：

```bash
CUDA_VISIBLE_DEVICES=0 python ../olivia-soul/gpu/avatar_service.py \
  --flashhead-root "$PWD" \
  --portrait ../olivia-soul/assets/portrait.png \
  --data-dir ../olivia-soul/.cache/avatar \
  --port 8765
```

脚本参数还支持 `--checkpoint` 和 `--wav2vec`；相对模型路径基于 FlashHead root。数据目录保存方形人物与合成待机视频，需要可写。`--help` 无需安装模型依赖。用脚本入口启动，以确保全局推理状态使用单线程 executor；不要启动多个 uvicorn worker。

服务预热完成后才能接收连接：

```bash
curl http://127.0.0.1:8765/health
```

`ready=true` 表示可用；`busy=true` 表示客户端占用，不要因此重启。检查显卡空闲和许可后使用；服务不调度共享 GPU。主进程与隧道由用户管理，不随 Soul 启停。

## Windows SSH 隧道

替换自己的 SSH 主机别名。密钥和远程用户名可以配置在用户 `.ssh/config`，不放进仓库：

```powershell
ssh -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=20 -o ServerAliveCountMax=3 -L 127.0.0.1:8765:127.0.0.1:8765 YOUR_GPU_HOST
Invoke-RestMethod http://127.0.0.1:8765/health
```

保持隧道运行，配置 `gpu_enabled=true` 和 `gpu_url=http://127.0.0.1:8765`。Ctrl+C 只停止隧道，服务仍在远端。端口可自行更改，两端一致即可。

服务只允许 loopback 监听，没有公网鉴权，勿直接公开端口。本机 GPU 服务同样使用 loopback URL，但本机安装及性能尚未验收。

## 人物与待机

客户端图片和服务人物独立，更换时两端保持一致。可在 GPU 空闲时用 `npx tsx scripts/generate-idle.ts` 生成客户端待机，Windows 还需 ffmpeg/ffprobe。生成脚本默认访问 8765，也支持 `SOUL_IDLE_GPU_URL`。

验收至少包括健康检查、首帧与推理速度、10 分钟回复、打断、busy 降级、断线重连、隧道退出以及服务退出后的显存释放。当前公开准备只验证语法、帮助参数和客户端本地协议，不代替 GPU 实测。
