# 可选 Langfuse

默认关闭，启用会记录对话与工具参数、结果，先读隐私说明。

Windows 需 WSL Docker Compose，现有 override 使用 mirrored networking，其他模式未验证。

```powershell
npm run langfuse:up
npm run langfuse:status
npm run langfuse:logs
npm run langfuse:stop
```

首次 up 在 infra/langfuse/.env 生成随机凭据，登录说明在 .cache/langfuse-login.txt，补充根 .env 的本地 API 配置；远程地址不切换。UI http://localhost:3300，凭据不入 Git。

stop 保留卷，UI/媒体仅 loopback，数据库不公开端口。镜像未全部按 digest 固定，复现实验记录实际镜像。

npm run eval:seed 和 npm run eval:tools -- --name baseline 调用真实阿里云、产生费用；工具在内存模拟。评测显式开启 tracing，日常需 LANGFUSE_ENABLED=true；便携版仅进程变量，不随导入持久化。

设 LANGFUSE_ENABLED=false 并重启关闭，不删除旧记录。
