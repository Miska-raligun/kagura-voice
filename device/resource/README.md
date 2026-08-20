# 资源文件

这些文件对应设备上的 `/flash/kagura/resource/`，全部**可选**——缺失时代码会
自动降级（打印一行日志后走纯色背景 / kaomoji），不影响功能。

| 文件 | 用途 | 缺失时 |
|---|---|---|
| `img_bg.jpg` | 统一背景（320×240） | 纯色 `0x0a0a0a` 背景 |
| `img_shake.jpg` | 摇晃彩蛋图 | 显示 kaomoji `(*/ω＼*)` |
| `img_recording.jpg` | 录音态背景 | 仅 `cfg.USE_STATE_IMAGES=True` 时使用 |
| `img_processing.jpg` | 思考态背景 | 同上 |
| `img_playing.jpg` | 播放态背景 | 同上 |

默认 `USE_STATE_IMAGES = False`：只用 `img_bg.jpg` 当统一背景，状态由中央
的环形动画表达。想恢复"每个状态换一张图"的旧观感，把它改成 `True`。

图片不入库（见 `.gitignore`），自行用 UIFlow2 File Manager 上传。
