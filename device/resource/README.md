# 资源文件

对应设备上的 `/flash/kagura/resource/`。全部**可选**——缺失时代码自动降级
（打印一行日志后走纯色背景 / kaomoji），不影响功能。

## 文件清单

调用时不带扩展名，代码会自动按 `.jpg → .jpeg → .png → .bmp` 顺序查找：

| 基名 | 用途 | 缺失时 |
|---|---|---|
| `img_bg` | 统一背景（320×240） | 纯色 `0x0a0a0a` 背景 |
| `img_shake` | 摇晃彩蛋图 | 显示 kaomoji `(*/ω＼*)` |
| `img_recording` | 录音态背景 | 仅 `cfg.USE_STATE_IMAGES=True` 时使用 |
| `img_processing` | 思考态背景 | 同上 |
| `img_playing` | 播放态背景 | 同上 |

默认 `USE_STATE_IMAGES = False`：只用 `img_bg` 当统一背景，状态由中央的
环形动画表达。想恢复"每个状态换一张图"的旧观感，改成 `True`。

## 格式：PNG / BMP 也支持，但建议用 JPG

`ui.draw_image()` 做了能力探测，固件提供 `drawPng` / `drawBmp` 就能直接用
PNG / BMP，不支持的格式自动跳过。**但照片类图片强烈建议转成 JPG**，两个原因：

1. **UIFlow2 File Manager 单文件上传上限约 100KB。** 320×240 的照片存成 JPG
   （质量 85）约 20~30KB，存成 PNG 常常 150~250KB —— 直接超限传不上去。
   （纯色块 / 线条类图形的 PNG 很小，不受此限。）
2. **PNG 解码更慢更吃内存。** 这台设备堆很紧（代码里到处 `gc.collect()`），
   全屏 PNG 解码的峰值占用明显高于 JPG。

## 转换命令

ImageMagick：

```bash
magick input.png -resize 320x240^ -gravity center -extent 320x240 \
       -quality 85 img_bg.jpg
```

或者用 Python（仓库已依赖 pillow）：

```bash
python3 -c "
from PIL import Image
im = Image.open('input.png').convert('RGB')
im = im.resize((320, 240), Image.LANCZOS)
im.save('img_bg.jpg', quality=85)
"
```

图片不入库（见 `.gitignore`），自行用 UIFlow2 File Manager 上传到
`/flash/kagura/resource/`。
