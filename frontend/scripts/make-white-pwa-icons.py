"""Build solid-white, opaque (no alpha) PWA icons for Windows/Chrome installs.

Windows often paints transparent PNG corners black on desktop shortcuts.
Source artwork is composited onto a full #FFFFFF square and saved as RGB PNG.
"""
from __future__ import annotations

from collections import Counter
from pathlib import Path

from PIL import Image

PUBLIC = Path(__file__).resolve().parents[1] / "public"
WHITE = (255, 255, 255)


def _trim_content(im: Image.Image, threshold: int = 248) -> Image.Image:
    """Crop near-white / transparent margins so logo fills the safe zone."""
    rgba = im.convert("RGBA")
    w, h = rgba.size
    px = rgba.load()

    def empty_row(y: int) -> bool:
        for x in range(w):
            r, g, b, a = px[x, y]
            if a > 12 and (r < threshold or g < threshold or b < threshold):
                return False
        return True

    def empty_col(x: int) -> bool:
        for y in range(h):
            r, g, b, a = px[x, y]
            if a > 12 and (r < threshold or g < threshold or b < threshold):
                return False
        return True

    top = 0
    while top < h and empty_row(top):
        top += 1
    bottom = h - 1
    while bottom >= top and empty_row(bottom):
        bottom -= 1
    left = 0
    while left < w and empty_col(left):
        left += 1
    right = w - 1
    while right >= left and empty_col(right):
        right -= 1
    if left >= right or top >= bottom:
        return rgba
    return rgba.crop((left, top, right + 1, bottom + 1))


def load_logo_source() -> Image.Image:
    """Prefer logo-1.png artwork; fall back to existing icon-512."""
    logo = PUBLIC / "logo-1.png"
    if logo.exists():
        im = Image.open(logo).convert("RGBA")
        # Flatten any near-black plate leftovers onto transparency before white composite
        pixels = []
        for r, g, b, a in im.getdata():
            luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
            chroma = max(r, g, b) - min(r, g, b)
            if a < 8 or (luma <= 18 and chroma <= 12):
                pixels.append((0, 0, 0, 0))
            else:
                pixels.append((r, g, b, a))
        im.putdata(pixels)
        return _trim_content(im)

    return _trim_content(Image.open(PUBLIC / "icon-512.png").convert("RGBA"))


def make_square_icon(logo: Image.Image, size: int, fill_ratio: float = 0.72) -> Image.Image:
    """Solid opaque white square; logo centered with padding. Returns RGB (no alpha)."""
    canvas = Image.new("RGB", (size, size), WHITE)
    work = logo.convert("RGBA")
    safe = max(1, int(size * fill_ratio))
    work.thumbnail((safe, safe), Image.Resampling.LANCZOS)
    # Paste via alpha onto white, then flatten to RGB
    layer = Image.new("RGBA", (size, size), (*WHITE, 255))
    x = (size - work.width) // 2
    y = (size - work.height) // 2
    layer.paste(work, (x, y), work)
    return layer.convert("RGB")


def save_rgb_png(im: Image.Image, path: Path) -> None:
    rgb = im.convert("RGB")
    rgb.save(path, format="PNG", optimize=True)
    print(f"wrote {path.name} {rgb.size} mode={rgb.mode}")


def analyze(path: Path) -> None:
    im = Image.open(path)
    rgba = im.convert("RGBA")
    w, h = rgba.size
    corners = [rgba.getpixel(p) for p in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]]
    data = list(rgba.getdata())
    transparent = sum(1 for p in data if p[3] < 255)
    white = sum(1 for p in data if p[:3] == (255, 255, 255) and p[3] == 255)
    print(
        f"{path.name}: mode={im.mode} size={im.size} corners={corners} "
        f"transparent={transparent} white={white}/{len(data)} "
        f"top={Counter(data).most_common(2)}"
    )


def main() -> None:
    logo = load_logo_source()
    print(f"logo source trimmed size={logo.size}")

    icons_dir = PUBLIC / "icons"
    icons_dir.mkdir(exist_ok=True)

    # Install / PWA icons — solid white, opaque RGB (legacy root + cache-busted /icons/*-v3)
    outputs: list[tuple[int, str, float]] = [
        (512, "icon-512.png", 0.78),
        (192, "icon-192.png", 0.78),
        (180, "apple-touch-icon.png", 0.78),
        (512, "icon-512-maskable.png", 0.70),
        (192, "icon-192-maskable.png", 0.70),
        (48, "favicon-48x48.png", 0.82),
        (32, "favicon-32x32.png", 0.82),
        (16, "favicon-16x16.png", 0.90),
    ]
    v3_aliases = {
        "icon-512.png": "pwa-512-v3.png",
        "icon-192.png": "pwa-192-v3.png",
        "icon-512-maskable.png": "pwa-512-maskable-v3.png",
        "icon-192-maskable.png": "pwa-192-maskable-v3.png",
        "apple-touch-icon.png": "apple-touch-v3.png",
        "favicon-32x32.png": "favicon-32-v3.png",
        "favicon-16x16.png": "favicon-16-v3.png",
    }
    for size, name, ratio in outputs:
        im = make_square_icon(logo, size, ratio)
        save_rgb_png(im, PUBLIC / name)
        alias = v3_aliases.get(name)
        if alias:
            save_rgb_png(im, icons_dir / alias)

    # Multi-size ICO — write largest first so Windows has a usable 48px frame
    base = Image.open(PUBLIC / "icon-512.png").convert("RGBA")
    ico_images = []
    for s in (48, 32, 16):
        frame = Image.new("RGBA", (s, s), (*WHITE, 255))
        scaled = base.resize((s, s), Image.Resampling.LANCZOS)
        frame.paste(scaled, (0, 0))
        ico_images.append(frame)
    ico_path = PUBLIC / "favicon.ico"
    ico_images[0].save(ico_path, format="ICO", append_images=ico_images[1:])
    print(f"wrote {ico_path.name} bytes={ico_path.stat().st_size}")
    ico_v3 = icons_dir / "favicon-v3.ico"
    ico_images[0].save(ico_v3, format="ICO", append_images=ico_images[1:])
    print(f"wrote icons/{ico_v3.name} bytes={ico_v3.stat().st_size}")

    print("\n=== verify ===")
    for name in [
        "icon-512.png",
        "icon-192.png",
        "icon-512-maskable.png",
        "icon-192-maskable.png",
        "apple-touch-icon.png",
        "favicon-32x32.png",
        "favicon.ico",
        "icons/pwa-512-v3.png",
        "icons/pwa-512-maskable-v3.png",
        "icons/favicon-v3.ico",
    ]:
        analyze(PUBLIC / name)


if __name__ == "__main__":
    main()
