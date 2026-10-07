# 开发与验证

Windows + Node.js 24，干净 checkout 执行 npm ci，执行 npm run setup:electron 下载 Electron 运行时，然后 typecheck、test、build、test:desktop、check:public。测试使用本机 HTTP/WebSocket，需允许 loopback。桌面测试启动 Electron，不调用模型或真实 dsh。

真实联调先准备测试应用、dsh 与可选 GPU：

```powershell
npx tsx scripts/probe-dsh.ts
npm run integration -- --multi-task
```

产生请求、费用、测试会话及 .cache/e2e-fixture 文件。其他 probe、截图、记忆、UI 脚本也可能访问真实服务，先读源码，不在敏感桌面或生产账户盲目运行。

## 发布

当前沿用源码版本 0.1.2，旧 Amadeus Soul 产物不是新版。

1. 干净目录检查，更新 package 与 lockfile 版本。
2. npm run package，验证导入、加密重启、无 GPU 通话与退出。
3. 隔离账户验收云端、GPU 与设备，记录未测项。
4. 检查源码/app.asar 凭据、许可与发布清单，不分发工作目录。
5. main 上创建 tag，手动发布 Release，CI 不访问真实服务或自动发布。

独立 GPU 部署与云端联调未在公开副本执行，离线验证不能代替它们。

新增 `npm run test:first-run` 覆盖首次配置选择、取消退出、无 GPU 默认值和旧记忆身份；`python gpu/test_service_options.py` 在没有 CUDA 依赖时检查参数与 loopback 边界。构建工具审计的未修复项见 SECURITY.md。

## 2026-10-07 本地公开准备记录

- 从私人仓库当前工作树创建独立副本，未带入旧历史、真实配置或个人运维资料。
- 类型检查和 83 项单元测试通过；Electron 首次导入/取消、加密存储、默认无 GPU、旧记忆身份和 dsh 生命周期检查通过。
- Python 服务语法与 2 项参数检查通过，帮助无需 CUDA 依赖；尚未验收独立 GPU 部署。
- Windows x64 便携构建通过；npm run test:package:offline 已验证解压启动、导入/重启、加密配置与 dsh 存活，不调用云端或 GPU。可执行文件采用默认 Electron 图标，窗口/托盘使用项目 Logo；未提供发布者签名。
- 配置值扫描覆盖公开源码、构建主文件和 app.asar，未发现私人仓库当前配置值。它不构成完整安全审计。
- 运行时依赖审计无已知漏洞；完整工具链仍有 SECURITY.md 记录的 moderate 项。部分 npm 包未附带许可文本，生成的清单明确标记。
- 未发布 GitHub、未访问真实阿里云应用或远程 GPU，凭据轮换仍需账户持有人完成。
