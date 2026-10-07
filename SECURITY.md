# 安全问题

请勿在公开 issue、PR 或讨论中粘贴 Key、token、签名 URL、云端记忆、真实截图或原始日志。

首次公开前，维护者应启用 GitHub Private Vulnerability Reporting。启用后使用仓库 Security 页的 “Report a vulnerability” 私下报告；未启用时只发布不含利用细节与敏感信息的联系方式请求。

凭据暴露后先撤销或轮换，再清理文件和历史。删除文件或补 `.gitignore` 不会清除历史、日志或已下载副本。

目前仅维护 `main`，不承诺旧便携版本的安全回补。

## 2026-10-07 依赖检查

已更新可在当前版本范围内修复的传递依赖。生产依赖审计无已知漏洞，完整审计仍报告构建工具链的 8 个 moderate 受影响包，来自同一条 `electron-builder → @electron/get → global-agent → roarr → sprintf-js` 链，见 [上游通告](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)。该链未打入应用 JavaScript bundle。npm 提议强制降级 electron-builder，当前未执行这一破坏性变更。

构建仍使用受控本地配置；不要向打包工具输入不可信格式字符串。发布前重新运行完整审计，必要时独立升级或替换工具链并验证打包。CI 拒绝 high/critical 级别的完整依赖审计失败；moderate 不作为自动通过的安全保证。
