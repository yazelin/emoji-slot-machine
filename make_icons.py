"""Generate PWA icons for 表情拉霸機.

Takes one face photo (or one 3x3 grid, auto-cropped to a single tile) and
renders it as if viewed through a 3x3 rounded-tile mask — single image,
nine tiles, peachy gaps between.

Usage:
  python3 make_icons.py <face_or_3x3.png>

Outputs:
  icon-192.png / icon-512.png     — standard, full-bleed
  icon-maskable.png               — 80% safe-zone for Android adaptive icons
  apple-touch-icon.png            — 180×180, rounded corners
  favicon.ico                     — 16 / 32 / 48
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).parent

CREAM = (250, 246, 242)        # warm cream (site bg)
WHITE = (255, 255, 255)
SHADOW = (145, 120, 95)        # warm-gray shadow tint

FONT_BOLD = "/home/ct/.local/share/fonts/NotoSansTC-Bold.ttf"


def square_crop(img: Image.Image) -> Image.Image:
    w, h = img.size
    s = min(w, h)
    return img.crop(((w - s) // 2, (h - s) // 2, (w + s) // 2, (h + s) // 2))


def face_focused_crop(img: Image.Image, face_ratio: float = 0.55) -> Image.Image:
    """Crop a square centred on the face for typical selfie framing.

    Selfies usually have the face in the upper third of the frame. A pure
    centre crop keeps most of the T-shirt and only a sliver of forehead.
    Instead: take a square of side = face_ratio × min(w,h), centred
    horizontally and biased toward the top.
    """
    w, h = img.size
    s = int(min(w, h) * face_ratio)
    left = (w - s) // 2
    # Top quarter of the image is where the eyes usually land.
    top = int(h * 0.08)
    top = max(0, min(top, h - s))
    return img.crop((left, top, left + s, top + s))


def auto_prepare_face(img: Image.Image) -> tuple[Image.Image, bool]:
    """Returns (prepared_image, is_grid).

    If the input is already a 3×3 grid we use it as-is — icon will show
    all 9 complete expressions. Otherwise square-crop toward the face so
    the icon is a clean single portrait.
    """
    w, h = img.size
    if abs(w - h) < 16 and w >= 600:
        return img, True
    return face_focused_crop(img), False


def is_3x3_grid(img: Image.Image) -> bool:
    """Rough heuristic: check if the pixels along the 1/3 and 2/3 horizontal
    cut lines are nearly uniform in colour (seam between tiles)."""
    from statistics import pstdev

    small = img.convert("RGB").resize((300, 300), Image.LANCZOS)
    px = small.load()
    for y in (100, 200):
        row = [px[x, y] for x in range(300)]
        variance = sum(pstdev(chan) for chan in zip(*row)) / 3
        if variance > 25:
            return False
    return True


def tile_mask(size: int, inner: int, gap: int, radius_ratio: float = 0.14) -> Image.Image:
    """A 3x3 grid of rounded-square holes."""
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    ix = (size - inner) // 2
    iy = (size - inner) // 2
    tile = (inner - 2 * gap) // 3
    radius = max(2, int(tile * radius_ratio))
    for r in range(3):
        for c in range(3):
            x = ix + c * (tile + gap)
            y = iy + r * (tile + gap)
            d.rounded_rectangle(
                (x, y, x + tile, y + tile),
                radius=radius,
                fill=255,
            )
    return mask


def tile_positions(size: int, inner: int, gap: int):
    ix = (size - inner) // 2
    iy = (size - inner) // 2
    tile = (inner - 2 * gap) // 3
    radius = max(2, int(tile * 0.14))
    for r in range(3):
        for c in range(3):
            x = ix + c * (tile + gap)
            y = iy + r * (tile + gap)
            yield (x, y, tile, radius)


def draw_icon(
    source: Image.Image,
    is_grid: bool,
    size: int,
    safe_fraction: float = 1.0,
    background: tuple | None = None,
) -> Image.Image:
    """Japanese-minimalist icon.

    is_grid=True  → source is already a 3×3 of 9 faces. Apply tile mask
                    aligned to existing tile boundaries so each tile
                    shows one COMPLETE face with soft gaps between.
    is_grid=False → single-portrait icon: rounded square of the face.
    Transparent background by default; pass CREAM for opaque variants.
    """
    canvas = (
        Image.new("RGBA", (size, size), background + (255,))
        if background
        else Image.new("RGBA", (size, size), (0, 0, 0, 0))
    )

    inner = int(size * safe_fraction)
    ix = (size - inner) // 2
    iy = (size - inner) // 2

    if not is_grid:
        return draw_single_portrait(canvas, source, size, inner, ix, iy)

    # 3×3 grid path: align mask with the source image's tile boundaries.
    gap = max(2, int(inner * 0.018))
    positions = list(tile_positions(size, inner, gap))

    # Soft drop-shadow under every tile
    shadow_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow_layer)
    shadow_offset = max(1, int(size * 0.005))
    for (x, y, tile, radius) in positions:
        sd.rounded_rectangle(
            (x + shadow_offset, y + shadow_offset * 2,
             x + tile + shadow_offset, y + tile + shadow_offset * 2),
            radius=radius,
            fill=SHADOW + (24,),
        )
    try:
        from PIL import ImageFilter
        shadow_layer = shadow_layer.filter(
            ImageFilter.GaussianBlur(radius=max(2, size // 120))
        )
    except Exception:
        pass
    canvas = Image.alpha_composite(canvas, shadow_layer)

    # Paint each source tile into its slot. Because the source is already a
    # 3×3 grid of complete faces, each slot is a full tile crop resized.
    src = source.convert("RGBA")
    sw, sh = src.size
    src_tile_w = sw / 3
    src_tile_h = sh / 3

    for idx, (x, y, tile, radius) in enumerate(positions):
        r = idx // 3
        c = idx % 3
        src_box = (
            int(c * src_tile_w),
            int(r * src_tile_h),
            int((c + 1) * src_tile_w),
            int((r + 1) * src_tile_h),
        )
        tile_img = src.crop(src_box).resize((tile, tile), Image.LANCZOS)
        # Round corners via per-tile mask
        tmask = Image.new("L", (tile, tile), 0)
        ImageDraw.Draw(tmask).rounded_rectangle(
            (0, 0, tile, tile), radius=radius, fill=255
        )
        tile_img.putalpha(tmask)
        canvas.alpha_composite(tile_img, (x, y))

    return canvas


def draw_single_portrait(
    canvas: Image.Image, face: Image.Image, size: int, inner: int, ix: int, iy: int
) -> Image.Image:
    """Single rounded-square portrait (no chopping)."""
    radius = max(4, int(inner * 0.18))
    portrait = face.resize((inner, inner), Image.LANCZOS).convert("RGBA")
    mask = Image.new("L", (inner, inner), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, inner, inner), radius=radius, fill=255
    )
    portrait.putalpha(mask)
    canvas.alpha_composite(portrait, (ix, iy))
    return canvas


def round_to_circle(img: Image.Image) -> Image.Image:
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).ellipse((0, 0, *img.size), fill=255)
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(img, (0, 0), mask=mask)
    return out


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit("usage: make_icons.py <face_or_3x3.png>")
    src = Image.open(sys.argv[1]).convert("RGB")
    source, is_grid = auto_prepare_face(src)

    def render(size, safe=1.0, bg=None):
        return draw_icon(source, is_grid, size, safe_fraction=safe, background=bg)

    render(192).save(ROOT / "icon-192.png", "PNG", optimize=True)
    render(512).save(ROOT / "icon-512.png", "PNG", optimize=True)

    # Maskable: cream background, content in 80% safe zone
    render(512, safe=0.82, bg=CREAM).save(
        ROOT / "icon-maskable.png", "PNG", optimize=True
    )

    # Apple touch icon (iOS rounds it for us)
    apple = render(360, bg=CREAM).resize((180, 180), Image.LANCZOS).convert("RGB")
    apple.save(ROOT / "apple-touch-icon.png", "PNG", optimize=True)

    # Favicon
    favi = render(256, bg=CREAM)
    favi.save(ROOT / "favicon.ico", format="ICO", sizes=[(16, 16), (32, 32), (48, 48)])

    for name in ("icon-192.png", "icon-512.png", "icon-maskable.png",
                 "apple-touch-icon.png", "favicon.ico"):
        p = ROOT / name
        print(f"saved {name} ({p.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
