"""Generate a 1200×630 Open Graph image from one of our 3x3 test outputs.
Mirrors the site's Japanese-aesthetic palette.

Usage: python3 make_og.py <source_3x3.png>
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).parent

BG = (250, 246, 242)          # --bg
ACCENT = (232, 165, 152)      # --accent
ACCENT_HOVER = (220, 144, 132)
TEXT = (61, 53, 48)
MUTED = (140, 133, 126)
SAGE = (168, 192, 159)

W, H = 1200, 630
GRID_SIZE = 520
GRID_X, GRID_Y = 60, (H - GRID_SIZE) // 2

FONT_BOLD = "/home/ct/.local/share/fonts/NotoSansTC-Bold.ttf"
FONT_REG = "/home/ct/.local/share/fonts/NotoSansTC-Light.ttf"


def rounded_corners(img: Image.Image, radius: int) -> Image.Image:
    mask = Image.new("L", img.size, 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle(((0, 0), img.size), radius=radius, fill=255)
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(img, (0, 0), mask=mask)
    return out


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit("usage: make_og.py <source_3x3.png>")
    src_path = Path(sys.argv[1])
    if not src_path.is_file():
        sys.exit(f"not found: {src_path}")

    src = Image.open(src_path).convert("RGB")
    canvas = Image.new("RGB", (W, H), BG)

    # Subtle radial-style decoration (big soft circles in corners)
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    od.ellipse((-200, -160, 260, 300), fill=(232, 165, 152, 28))
    od.ellipse((W - 260, H - 240, W + 200, H + 220), fill=(168, 192, 159, 24))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), overlay)

    # Grid image
    grid = src.resize((GRID_SIZE, GRID_SIZE), Image.LANCZOS)
    grid = rounded_corners(grid, 24)
    canvas.paste(grid, (GRID_X, GRID_Y), mask=grid)

    # Text column
    d = ImageDraw.Draw(canvas)
    text_x = GRID_X + GRID_SIZE + 60
    title_font = ImageFont.truetype(FONT_BOLD, 72)
    ja_font = ImageFont.truetype(FONT_REG, 28)
    sub_font = ImageFont.truetype(FONT_REG, 26)
    cta_font = ImageFont.truetype(FONT_BOLD, 24)

    # "kimochi slot" accent
    d.text((text_x, 165), "kimochi slot", fill=ACCENT, font=ja_font)
    # Title
    d.text((text_x, 205), "表情拉霸機", fill=TEXT, font=title_font)
    # Tagline (two lines)
    d.text(
        (text_x, 310),
        "把 3×3 表情圖做成",
        fill=MUTED,
        font=sub_font,
    )
    d.text(
        (text_x, 345),
        "可分享的 FB 拉霸影片",
        fill=MUTED,
        font=sub_font,
    )
    # CTA pill
    pill_y = 415
    pill_h = 54
    pill_w = 340
    d.rounded_rectangle(
        (text_x, pill_y, text_x + pill_w, pill_y + pill_h),
        radius=pill_h // 2,
        fill=ACCENT,
    )
    d.text(
        (text_x + 30, pill_y + 13),
        "點開，讓你的臉上場",
        fill=(255, 255, 255),
        font=cta_font,
    )

    # Sakura accent
    sakura_font = ImageFont.truetype(FONT_BOLD, 48)
    d.text((text_x - 40, 155), "✿", fill=(232, 165, 152, 180), font=sakura_font)

    canvas = canvas.convert("RGB")
    out_path = ROOT / "og.png"
    canvas.save(out_path, "PNG", optimize=True)
    print(f"saved {out_path} ({out_path.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
