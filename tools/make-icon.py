"""
生成「智答」扩展图标。
设计：圆角方形 + 蓝紫渐变底 + 白色对话气泡 + 气泡内对勾（作答语义），
右上角一颗四角星（AI 语义）。先在 2048 上绘制再降采样，保证小尺寸干净。

python tools/make-icon.py
"""
from PIL import Image, ImageDraw
import os

S = 2048            # 绘制尺寸
MASTER = 1024       # 主图
TARGETS = [16, 32, 48, 96, 128, 256]
OUT_DIR = os.path.join("public", "icon")

C_TOP_LEFT = (37, 99, 235)      # #2563EB 蓝
C_BOT_RIGHT = (124, 58, 237)    # #7C3AED 紫
CHECK_COLOR = (37, 99, 235)
BUBBLE = (255, 255, 255)


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def gradient(size, c1, c2):
    """对角线性渐变：先生成小图再放大，平滑且快"""
    small = Image.new("RGB", (64, 64))
    px = small.load()
    for y in range(64):
        for x in range(64):
            t = (x + y) / (2 * 63)
            px[x, y] = lerp(c1, c2, t)
    return small.resize((size, size), Image.BICUBIC)


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def draw_check(d, box, width, color):
    """在 box 内画一个粗对勾（圆角端点）"""
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    p1 = (x0, y0 + h * 0.52)
    p2 = (x0 + w * 0.38, y0 + h * 0.88)
    p3 = (x1, y0 + h * 0.12)
    d.line([p1, p2], fill=color, width=int(width), joint="curve")
    d.line([p2, p3], fill=color, width=int(width), joint="curve")
    r = width / 2
    for p in (p1, p2, p3):
        d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=color)


def draw_sparkle(d, cx, cy, r, color, inner_ratio=0.30):
    """四角星（AI 闪光）：8 顶点交替外径/内径，形成凹边星形"""
    import math

    pts = []
    for i in range(8):
        ang = -math.pi / 2 + i * (math.pi / 4)
        rad = r if i % 2 == 0 else r * inner_ratio
        pts.append((cx + rad * math.cos(ang), cy + rad * math.sin(ang)))
    d.polygon(pts, fill=color)


def build():
    """生成两个版本：
    - full   ：气泡 + 对勾 + 独立四角星（48px 以上用）
    - simple ：气泡 + 更粗的对勾，去掉星（16/32px 用，小尺寸下细节反而糊成一团）
    """
    base = gradient(S, C_TOP_LEFT, C_BOT_RIGHT).convert("RGBA")
    base.putalpha(rounded_mask(S, int(S * 0.225)))

    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    # ── 白色对话气泡（略偏左下，给右上角的星留出独立空间）──
    bx0, by0 = S * 0.185, S * 0.265
    bx1, by1 = S * 0.775, S * 0.700
    d.rounded_rectangle([bx0, by0, bx1, by1], radius=S * 0.115, fill=BUBBLE)
    # 气泡尾巴（左下角小三角）
    d.polygon(
        [
            (S * 0.300, by1 - S * 0.02),
            (S * 0.285, S * 0.815),
            (S * 0.460, by1 - S * 0.02),
        ],
        fill=BUBBLE,
    )

    full = Image.alpha_composite(base, layer.copy())
    simple = Image.alpha_composite(base, layer.copy())

    # ── full 版：对勾 + 独立的四角星（完全在气泡外，不与勾尖相连）──
    df = ImageDraw.Draw(full)
    draw_check(df, (S * 0.270, S * 0.330, S * 0.690, S * 0.615), S * 0.060, CHECK_COLOR)
    draw_sparkle(df, S * 0.845, S * 0.175, S * 0.085, (255, 255, 255, 255))

    # ── simple 版：只有更粗的对勾，无星 ──
    ds = ImageDraw.Draw(simple)
    draw_check(ds, (S * 0.255, S * 0.325, S * 0.705, S * 0.625), S * 0.085, CHECK_COLOR)

    master_full = full.resize((MASTER, MASTER), Image.LANCZOS)
    master_simple = simple.resize((MASTER, MASTER), Image.LANCZOS)

    os.makedirs(OUT_DIR, exist_ok=True)
    for size in TARGETS:
        src = master_simple if size <= 32 else master_full
        src.resize((size, size), Image.LANCZOS).save(
            os.path.join(OUT_DIR, f"{size}.png")
        )
    master_full.save("tools/_icon-master.png")
    print("已生成:", ", ".join(f"{s}px" for s in TARGETS), "→", OUT_DIR)
    print("  16/32px 用简化版（无星、勾更粗），48px+ 用完整版")


if __name__ == "__main__":
    build()
