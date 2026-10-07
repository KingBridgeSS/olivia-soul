# 第三方组件

项目代码与作者默认素材采用 MIT，第三方组件保留各自许可。

| 组件 | 用途 | 来源与许可 |
| --- | --- | --- |
| Electron | 桌面运行时 | https://github.com/electron/electron ，MIT；保留发行包自带的 Chromium 等许可 |
| DeepSeek Harness | 外部执行端，不随包分发 | https://github.com/deepseek-ai/deepseek-harness ，MIT |
| SoulX-FlashHead | 外部 GPU 推理，不随包分发 | https://github.com/Soul-AILab/SoulX-FlashHead ，Apache-2.0 |
| FlashHead 模型 | 使用者自行下载 | https://huggingface.co/Soul-AILab/SoulX-FlashHead-1_3B ，以实际模型许可为准 |
| wav2vec2 模型 | 使用者自行下载 | https://huggingface.co/facebook/wav2vec2-base-960h ，以实际模型许可为准 |

Node.js 依赖的精确版本见 `package-lock.json`。构建收集实际打入 bundle 的依赖许可到 `dist/THIRD-PARTY-LICENSES.txt` 并纳入应用资源。分发时保留 Electron 的 LICENSE 与 LICENSES.chromium.html；Python 依赖保留各自许可。模型、工具与云端服务不随项目 MIT 授权重新许可。

部分上游 npm tarball 没有随包附带许可/版权文本。生成清单保留其 manifest 声明、包链接和 SPDX 参考，并明确标记缺失；这不表示我们补齐或核实了所有上游版权归属。正式分发前应核对这些包的上游许可文件。构建过程不从网络自动抓取或猜测归属。
