"""Generate the 3x3 layout scaffold used as Gemini's positional reference.

Produces a 600x600 PNG with nine cells, each marked with a big letter
A..I. The Worker attaches this as a second inlineData reference image so
Gemini has a visual anchor for which description goes in which cell.

Outputs:
  layout_scaffold.png  (for human inspection / git)
  layout_scaffold.b64  (base64 blob you can paste into the Worker)
"""

import base64
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).parent
SIZE = 600
CELL = SIZE // 3

FONT_BOLD = "/home/ct/.local/share/fonts/NotoSansTC-Bold.ttf"

LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H", "I"]


def main() -> None:
    # Background: warm gray so the cell contents stand out
    img = Image.new("RGB", (SIZE, SIZE), (224, 226, 229))
    d = ImageDraw.Draw(img)

    # White cells with a thin gap
    gap = 6
    for r in range(3):
        for c in range(3):
            x0 = c * CELL + gap
            y0 = r * CELL + gap
            x1 = (c + 1) * CELL - gap
            y1 = (r + 1) * CELL - gap
            d.rounded_rectangle((x0, y0, x1, y1), radius=14, fill=(255, 255, 255))

    # Big bold letter centred in each cell
    font = ImageFont.truetype(FONT_BOLD, 130)
    for i, letter in enumerate(LETTERS):
        r, c = divmod(i, 3)
        cx = c * CELL + CELL // 2
        cy = r * CELL + CELL // 2
        bbox = d.textbbox((0, 0), letter, font=font)
        w = bbox[2] - bbox[0]
        h = bbox[3] - bbox[1]
        d.text(
            (cx - w // 2 - bbox[0], cy - h // 2 - bbox[1]),
            letter,
            font=font,
            fill=(70, 80, 95),
        )

    out_png = ROOT / "layout_scaffold.png"
    img.save(out_png, "PNG", optimize=True)

    raw = out_png.read_bytes()
    b64 = base64.b64encode(raw).decode()
    (ROOT / "layout_scaffold.b64").write_text(b64)
    print(f"saved {out_png.name} ({len(raw) // 1024} KB)")
    print(f"saved layout_scaffold.b64 ({len(b64)} chars)")


if __name__ == "__main__":
    main()
