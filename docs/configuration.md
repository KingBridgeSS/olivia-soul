# 配置与迁移

开发读取根 `.env`，同名进程变量优先。便携版读取导入的加密配置，或完整核心进程变量。首次无配置选择已填写文件，取消正常退出；也可传 `--import-env 文件绝对路径`。无效配置或 dsh 连接报错退出。

| 字段 | 用途 |
| --- | --- |
| app_id / workspace_id / key | 必填，百炼应用、空间与对话 Key |
| voice_id | 可选，留空沿用云端音色 |
| user_id | 默认 olivia-soul，1–36 字符，多用户使用不同 ID |
| dsh_url | 必填，本机 HTTP 根地址和本次启动 token，仅 loopback |
| dsh_cwd | 可选，已有绝对目录；留空用 Documents/home |
| gpu_enabled | true 或 false，默认 false |
| gpu_url | HTTP/HTTPS 根地址，默认 http://127.0.0.1:8765 |
| ALIBABA_CLOUD_ACCESS_KEY_ID/SECRET | 可选 RAM 凭据，仅开发记忆管理 |
| ALIBABA_CLOUD_SECURITY_TOKEN | 临时 STS 凭据需要 |
| LANGFUSE_* | 可选观测，默认关闭，见 langfuse.md |

对话 Key、RAM AccessKey、CLI 登录态和 dsh token 不能互相替代。RAM 凭据不随便携版持久化。

云端配置与 dsh URL 使用 Windows DPAPI，绑定 Windows 用户。目录 `%APPDATA%/olivia-soul`，偏好与窗口位置为普通 JSON。`--user-data-dir=绝对路径` 可隔离。GPU URL 是普通偏好，不放秘密。不分发配置或用户目录。

## 旧版迁移

品牌、appId、数据目录与工具域 olivia_soul 独立，不自动读取或修改旧版。

1. 保留原项目及 `%APPDATA%/amadeus-soul`，新版重新导入。跨机器不复制旧加密文件。
2. 同一云端应用沿用旧记忆时设 `user_id=amadeus-soul`。新默认 ID 是独立范围，不迁移或删除旧记忆。CLI 跟随配置，`--user` 可覆盖。
3. 推荐新测试应用；复用时在控制台停用旧 amadeus_soul 域重复绑定，再绑定新版。脚本不删除旧域或工具。
4. 按需重设窗口与设备。通话任务不迁移，dsh 历史由 dsh 保留。

失败先核对服务、完整 URL、当前 token 和版本；GPU 问题先关闭视频；解密失败使用当前 Windows 用户重新导入。
