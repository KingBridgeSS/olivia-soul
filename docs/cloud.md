# 云端应用与执行端

需要自己的账户和应用，实际调用按提供方计费。

## 阿里云

1. 开通百炼多模态交互应用，取得应用/空间 ID 与对话 Key。须支持实时 multimodal-dialog，普通文本应用不能代替。
2. 启用识别、合成和文本模型，配置音色；启用工具意图识别，截图需图片输入支持。以 [官方配置](https://help.aliyun.com/zh/model-studio/multimodal-app-configuration) 为准。
3. 可用 olivia-system-prompt.txt 人设示例，脚本不设置人设、模型或音色。
4. 填写 .env、发布应用；按 computer-task.json 绑定工具再发布。源定义 src/shared/task-tools.ts，见 [自定义指令](https://help.aliyun.com/zh/model-studio/custom-directive)。

按 [百炼 CLI](https://github.com/modelstudioai/cli) 安装并执行 `bl auth login --console`。脚本读取用户 .bailian/config.json，可用 BAILIAN_CONFIG_DIR 改目录。

```powershell
npm run cloud:configure -- --schema-only  # 仅生成本地 schema
npm run cloud:configure                 # 修改绑定并立即发布
```

第二个命令写入真实应用，先核对 ID，建议独立测试应用。保留 prompt、模型和音色，使用 olivia_soul 域，不创建应用或删除旧域。CLI 控制台网关可能变化，失败可按 schema 手动配置。

## dsh 与记忆

安装 README 固定版本，按 [上游](https://github.com/deepseek-ai/deepseek-harness) 配置模型、凭据、插件和操作工具。Soul 只提交目标与观察结果，不覆盖配置，不启动或关闭 dsh。审批和提问在 dsh Web 处理。

长期记忆由应用维护；开发管理另需 RAM 与空间权限，见 [记忆 API](https://help.aliyun.com/zh/model-studio/long-term-memory-api)。便携版不支持管理凭据导入。

```powershell
npm run memory -- list
npm run memory -- profile
npm run memory -- create '用户喜欢雨天'
npm run memory -- update 指定节点ID '新的完整内容'
npm run memory -- delete 指定节点ID
```

修改和删除影响真实记忆，先查询节点 ID。--user 优先于 user_id。
