"""生成图标预览图：实际尺寸贴在浅色/深色底上，检查小尺寸辨识度。"""
from PIL import Image
import os

SIZES = [16, 32, 48, 96, 128]
ICON_DIR = os.path.join("public", "icon")


def sheet(bg, out):
    pad, gap = 20, 18
    h = max(SIZES) + pad * 2
    w = pad * 2 + sum(SIZES) + gap * (len(SIZES) - 1)
    canvas = Image.new("RGBA", (w, h), bg)
    x = pad
    for s in SIZES:
        ic = Image.open(os.path.join(ICON_DIR, f"{s}.png")).convert("RGBA")
        y = pad + (max(SIZES) - s)
        canvas.alpha_composite(ic, (x, y))
        x += s + gap
    canvas.convert("RGB").save(out)
    print("预览:", out, canvas.size)


sheet((255, 255, 255, 255), "tools/_icon-preview-light.png")
sheet((32, 33, 36, 255), "tools/_icon-preview-dark.png")
