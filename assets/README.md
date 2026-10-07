# 素材

`portrait.png`、`logo.png` 和 `idle.mp4` 由项目作者制作，作者已确认可随项目再分发，采用根目录 MIT 许可。待机视频为合成动画，不含用户通话录音。

客户端静态人物与 GPU 服务的 `portrait.png` 是独立文件。更换角色时，在两端使用同一张有权使用的图片并重新生成待机动画。GPU 接口不提供图片上传。

`idle.mp4` 可选，缺失时显示静态人物；`portrait.png` 和 `logo.png` 是构建必需文件。生成待机视频还需 GPU、ffmpeg 和 ffprobe，见 `docs/gpu.md`。
