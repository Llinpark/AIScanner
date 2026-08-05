"""Replace near-black PWA icon backgrounds with solid white; emit maskable variants."""
from __future__ import annotations

from collections import Counter
from pathlib import Path

from PIL import Image

PUBLIC = Path(__file__).resolve().parents[1] / "public"

# Near-black canvas only — leave navy brand ink (#0x1x2x-ish) alone.
BG_LUMA_MAX = 28
BG_CHROMA_MAX = 18


def is_black_bg(r: int, g: int, b: int, a: int) -> bool:
    if a < 8:
        return True
    luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
    chroma = max(r, g, b) - min(r, g, b)
    return luma <= BG_LUMA_MAX and chroma <= BG_CHROMA_MAX


def replace_black_with_white(im: Image.Image) -> Image.Image:
    rgba = im.convert("RGBA")
    pixels = list(rgba.getdata())
    out = []
    for r, g, b, a in pixels:
        if is_black_bg(r, g, b, a):
            out.append((255, 255, 255, 255))
        else:
            out.append((r, g, b, 255 if a > 200 else a))
    rgba.putdata(out)
    return rgba.convert("RGB").convert("RGBA")


def make_maskable(src: Image.Image, size: int) -> Image.Image:
    """Solid white canvas; logo scaled into ~80% safe zone (maskable spec ~66% min diameter)."""
    canvas = Image.new("RGBA", (size, size), (255, 255, 255, 255))
    logo = replace_black_with_white(src)
    # Trim excess white/black margins so content fills the safe zone better
    bbox = logo.getbbox()
    if bbox:
        logo = logo.crop(bbox)
    # Also trim near-white edges after bg swap
    logo = _trim_near_white(logo)

    safe = int(size * 0.72)
    logo.thumbnail((safe, safe), Image.Resampling.LANCZOS)
    x = (size - logo.width) // 2
    y = (size - logo.height) // 2
    canvas.paste(logo, (x, y), logo if logo.mode == "RGBA" else None)
    return canvas


def _trim_near_white(im: Image.Image, threshold: int = 250) -> Image.Image:
    rgba = im.convert("RGBA")
    w, h = rgba.size
    px = rgba.load()

    def row_empty(y: int) -> bool:
        for x in range(w):
            r, g, b, a = px[x, y]
            if a > 10 and (r < threshold or g < threshold or b < threshold):
                return False
        return True

    def col_empty(x: int) -> bool:
        for y in range(h):
            r, g, b, a = px[x, y]
            if a > 10 and (r < threshold or g < threshold or b < threshold):
                return False
        return True

    top = 0
    while top < h and row_empty(top):
        top += 1
    bottom = h - 1
    while bottom >= top and row_empty(bottom):
        bottom -= 1
    left = 0
    while left < w and col_empty(left):
        left += 1
    right = w - 1
    while right >= left and col_empty(right):
        right -= 1
    if left >= right or top >= bottom:
        return rgba
    return rgba.crop((left, top, right + 1, bottom + 1))


def save_png(im: Image.Image, path: Path) -> None:
    im.convert("RGBA").save(path, format="PNG", optimize=True)
    print(f"wrote {path.name} {im.size}")


def analyze(path: Path) -> None:
    im = Image.open(path).convert("RGBA")
    corners = [im.getpixel(p) for p in [(0, 0), (im.width - 1, 0), (0, im.height - 1), (im.width - 1, im.height - 1)]]
    dark = [p for p in im.getdata() if sum(p[:3]) < 40 and p[3] > 200]
    print(path.name, im.size, "corners", corners, "dark_count", len(dark), "top_dark", Counter(dark).most_common(2))


def main() -> None:
    for name in [
        "icon-512.png",
        "icon-192.png",
        "apple-touch-icon.png",
        "favicon-16x16.png",
        "favicon-32x32.png",
        "favicon-48x48.png",
    ]:
        analyze(PUBLIC / name)

    # Primary square icons: in-place black -> white
    for name in ["icon-512.png", "icon-192.png", "apple-touch-icon.png"]:
        path = PUBLIC / name
        src = Image.open(path)
        out = replace_black_with_white(src)
        # Ensure full canvas is white (no leftover transparency)
        solid = Image.new("RGBA", out.size, (255, 255, 255, 255))
        solid.paste(out, (0, 0), out)
        save_png(solid, path)

    # Favicons from processed 512 (or 192) for consistency at small sizes
    base = Image.open(PUBLIC / "icon-512.png")
    for size, name in [(16, "favicon-16x16.png"), (32, "favicon-32x32.png"), (48, "favicon-48x48.png")]:
        resized = base.resize((size, size), Image.Resampling.LANCZOS)
        save_png(resized, PUBLIC / name)

    # favicon.ico multi-size
    ico_sizes = [(16, 16), (32, 32), (48, 48)]
    ico_images = [base.resize(s, Image.Resampling.LANCZOS) for s in ico_sizes]
    ico_path = PUBLIC / "favicon.ico"
    ico_images[0].save(
        ico_path,
        format="ICO",
        sizes=ico_sizes,
        append_images=ico_images[1:],
    )
    print(f"wrote {ico_path.name}")

    # Maskable icons (safe zone + solid white)
    src512 = Image.open(PUBLIC / "icon-512.png")
    for size, name in [(192, "icon-192-maskable.png"), (512, "icon-512-maskable.png")]:
        save_png(make_maskable(src512, size), PUBLIC / name)

    # Verify corners are white
    for name in [
        "icon-512.png",
        "icon-192.png",
        "apple-touch-icon.png",
        "favicon-32x32.png",
        "icon-192-maskable.png",
        "icon-512-maskable.png",
    ]:
        analyze(PUBLIC / name)


if __name__ == "__main__":
    main()
