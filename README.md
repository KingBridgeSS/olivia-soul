# Olivia Soul

Windows 桌面陪伴宠物：语音与文字对话、音频驱动人物视频、后台电脑任务，以及开发模式的长期记忆管理。Electron + TypeScript；对话使用自己的阿里云百炼多模态应用，电脑任务连接自行运行的 DeepSeek Harness（dsh）。

**无需本机 GPU。** 默认使用本地待机动画。人物说话视频使用远程 Linux GPU 服务，地址也可指向本机。

## 支持范围

- Windows x64，Node.js 24、Electron 44.2.0，精确依赖固定在锁文件。Electron 44 将运行时下载改为显式安装，首次执行 setup:electron。
- dsh Remote 按 `0.1.5-alpha.1` 核对，不保证任意新版兼容；用户配置执行模型与工具。
- GPU：Linux + NVIDIA CUDA、SoulX-FlashHead Lite。独立部署指南需在新 GPU 环境验收；原生 Windows、WSL、CPU 推理未验证。
- 记忆管理仅开发运行支持，可选。便携包不包含 dsh、模型、CUDA 或凭据，未配置代码签名。

## 快速开始：无 GPU

先按 [云端配置](docs/cloud.md) 创建自己的应用，准备 `app_id`、`key`、`workspace_id`。安装固定版本 dsh，在用户主目录启动：

```powershell
npm install -g @deepseek-ai/dsh@0.1.5-alpha.1
Set-Location $env:USERPROFILE
dsh web --no-open --port 8766
```

保持运行，在另一个窗口进入本仓库：

```powershell
npm ci
npm run setup:electron
Copy-Item .env.example .env
```

填写 `.env` 的云端字段与完整 `dsh_url`，保留 `gpu_enabled=false`。`dsh_cwd` 可留空或指定已有绝对目录，然后 `npm start`。

电话开始通话，键盘展开文字输入；文字交互同样需要接通。麦克风和扬声器分别静音，右上查看任务与记忆，右下打开 dsh。关闭窗口收进托盘，通过托盘退出。

dsh 是必需服务。不要从包含 Soul `.env` 的目录启动 dsh，它会读取环境文件并拒绝 `DSH_*` 字段。重启 dsh 会生成新 token，更新配置后重启 Soul，或结束通话与任务后重新导入。

## GPU 与配置

按 [GPU 部署](docs/gpu.md) 准备服务和 SSH 隧道，再设 `gpu_enabled=true`。GPU 不可用时退回待机、音频继续，不自动启动、重启或抢占 GPU。

[配置与迁移](docs/configuration.md) 说明字段、凭据与便携包导入。旧 Amadeus Soul 数据不会自动读取，需沿用旧记忆时显式设置原 `user_id`。

## 开发与打包

```powershell
npm run typecheck
npm test
npm run build
npm run test:desktop
npm run check:public
npm run package
```

离线和桌面协议测试无需账户、GPU 或真实 dsh；真实联调会产生费用，见 [开发与验证](docs/development.md)。便携包位于 `release/Olivia-Soul-0.1.2-win-x64.exe`，首次打开选择已填写的配置文件。

[架构](docs/architecture.md) · [隐私](docs/privacy.md) · [贡献](CONTRIBUTING.md) · [第三方许可](THIRD_PARTY_NOTICES.md)

代码与作者默认素材采用 [MIT](LICENSE)，第三方依赖与模型保留各自许可。
