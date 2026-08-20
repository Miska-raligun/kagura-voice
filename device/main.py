"""烧录到 /flash/main.py —— 只负责把 src 目录加进 sys.path 并启动。

设备目录布局：
    /flash/main.py               本文件
    /flash/kagura/src/*.py       代码
    /flash/kagura/resource/*.jpg 图片资源（自行上传）
    /flash/kagura/data/*         运行时状态（自动创建）
"""

import sys

sys.path.insert(0, "/flash/kagura/src")

import app

app.main()
