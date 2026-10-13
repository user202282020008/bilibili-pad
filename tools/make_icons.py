"""生成扩展图标（手柄剪影 + B 站蓝/粉）。

用法：python tools/make_icons.py
"""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
os.makedirs(OUT, exist_ok=True)

BG = (19, 22, 30, 255)       # 深色底
BLUE = (0, 174, 236, 255)    # B 站蓝
PINK = (251, 114, 153, 255)  # B 站粉
LIGHT = (255, 255, 255, 235) # 十字键


def rounded(img, size, ratio=0.22):
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1],
                                           radius=int(size * ratio), fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def make(size):
    img = Image.new("RGBA", (size, size), BG)
    d = ImageDraw.Draw(img)

    # 手柄主体：中间横条 + 左右两个握把
    w, h = size * 0.78, size * 0.38
    x, y = (size - w) / 2, size * 0.28
    d.rounded_rectangle([x, y, x + w, y + h], radius=h * 0.5, fill=BLUE)
    d.ellipse([x - size * 0.03, y + h * 0.42,
               x + size * 0.24, y + h * 0.42 + size * 0.28], fill=BLUE)
    d.ellipse([x + w - size * 0.24, y + h * 0.42,
               x + w + size * 0.03, y + h * 0.42 + size * 0.28], fill=BLUE)

    # 左侧十字方向键
    cw = max(1, size * 0.045)
    cx, cy = size * 0.265, y + h * 0.34
    d.rounded_rectangle([cx, cy + cw, cx + cw * 3, cy + cw * 2], radius=cw * 0.4, fill=LIGHT)
    d.rounded_rectangle([cx + cw, cy, cx + cw * 2, cy + cw * 3], radius=cw * 0.4, fill=LIGHT)

    # 右侧粉色圆键
    r = size * 0.075
    bx = size * 0.66
    by = y + h * 0.5
    d.ellipse([bx - r, by - r, bx + r, by + r], fill=PINK)

    return rounded(img, size)


for s in (16, 32, 48, 128):
    make(s).save(os.path.join(OUT, "icon%d.png" % s))
print("done ->", OUT)
