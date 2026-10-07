#!/usr/bin/env python3
"""Build Vayle's SVG masters and icons from their sources.

The symbol comes from src/mark.ts. The wordmark is "Vayle" set in Plus Jakarta Sans at weight 650
with -0.04 em tracking, shaped with HarfBuzz so the kerning is the font's own, then outlined, so no
master depends on a font being installed.

Requires Python 3.10+ with fonttools, brotli, uharfbuzz and cairosvg, and the cairo library:
  pip install fonttools brotli uharfbuzz cairosvg
  python scripts/build_masters.py
On macOS with Homebrew's cairo, run it with DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib.
"""
from __future__ import annotations

import io
import re
import shutil
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT.parent.parent / "apps" / "web" / "public"
FONT = next(
    (ROOT / "node_modules").glob("**/plus-jakarta-sans/files/plus-jakarta-sans-latin-wght-normal.woff2"),
    None,
) or next(
    (ROOT.parent.parent / "node_modules").glob(
        ".pnpm/@fontsource-variable+plus-jakarta-sans@*/node_modules/@fontsource-variable/plus-jakarta-sans/files/plus-jakarta-sans-latin-wght-normal.woff2"
    )
)
WORD = "Vayle"
WEIGHT = 650
TRACKING_EM = -0.04

INK = "#04060F"
WHITE = "#FFFFFF"
BLUE = "#253CEF"
# The held rung on dark grounds: blue-400, which keeps 5:1 on the dark sheet where blue-600 falls to 2.7:1.
BLUE_ON_DARK = "#6879FD"

# The symbol's height in a lockup, as a multiple of the wordmark's cap height, and the gap after it
# as a share of that height.
LOCKUP_SYMBOL_CAPS = 1.86
LOCKUP_GAP = 0.25
STACK_SYMBOL_CAPS = 2.6
STACK_GAP_CAPS = 0.7

# App icon tile: 64 units with a 22% corner radius, the 48-unit grid inset 18% on each side.
TILE = 64
TILE_RADIUS = 0.22
TILE_INSET = 0.18


class SourceMissing(Exception):
    pass


def mark_source() -> dict[str, str]:
    source = (ROOT / "src" / "mark.ts").read_text(encoding="utf-8")
    names = [
        "MARK_VIEWBOX",
        "MARK_BOUNDS_VIEWBOX",
        "MARK_PATH",
        "MARK_LADDER_PATH",
        "MARK_HELD_PATH",
        "MARK_SMALL_VIEWBOX",
        "MARK_SMALL_PATH",
    ]
    found = {}
    for name in names:
        match = re.search(rf'export const {name} =\s*"([^"]+)"', source)
        if match is None:
            raise SourceMissing(f"src/mark.ts must export {name}")
        found[name] = match.group(1)
    return found


def wordmark() -> tuple[str, float, float, float]:
    """Outlined wordmark path in font units with y down, plus its width, cap height and descent."""
    font = TTFont(str(FONT))
    instantiateVariableFont(font, {"wght": WEIGHT}, inplace=True)
    upm = font["head"].unitsPerEm
    buffer = io.BytesIO()
    font.flavor = None
    font.save(buffer)
    face = hb.Face(buffer.getvalue())
    hb_font = hb.Font(face)
    text = hb.Buffer()
    text.add_str(WORD)
    text.guess_segment_properties()
    hb.shape(hb_font, text, {"kern": True, "liga": True})
    glyph_order = font.getGlyphOrder()
    glyph_set = font.getGlyphSet()
    pen = SVGPathPen(glyph_set)
    bounds = BoundsPen(glyph_set)
    tracking = TRACKING_EM * upm
    x = 0.0
    infos, positions = text.glyph_infos, text.glyph_positions
    for i, (info, pos) in enumerate(zip(infos, positions)):
        name = glyph_order[info.codepoint]
        transform = (1, 0, 0, -1, x + pos.x_offset, -pos.y_offset)
        glyph_set[name].draw(TransformPen(pen, transform))
        glyph_set[name].draw(TransformPen(bounds, transform))
        x += pos.x_advance + (tracking if i < len(infos) - 1 else 0)
    cap = font["OS/2"].sCapHeight
    left, top, right, bottom = bounds.bounds
    return pen.getCommands(), right, cap, bottom


def svg(viewbox: str, body: str) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{viewbox}" role="img" aria-label="Vayle">'
        f"{body}</svg>\n"
    )


def symbol_body(mark: dict[str, str], ladder: str, held: str, transform: str = "") -> str:
    """The symbol in one colour as a single outline, or in two as the ladder with the held rung over it."""
    attr = f' transform="{transform}"' if transform else ""
    if ladder == held:
        return f'<path fill="{ladder}"{attr} d="{mark["MARK_PATH"]}"/>'
    return (
        f'<path fill="{ladder}"{attr} d="{mark["MARK_LADDER_PATH"]}"/>'
        f'<path fill="{held}"{attr} d="{mark["MARK_HELD_PATH"]}"/>'
    )


def main() -> None:
    out = ROOT / "source"
    out.mkdir(exist_ok=True)
    mark = mark_source()
    bx, by, bw, bh = map(float, mark["MARK_BOUNDS_VIEWBOX"].split())
    word, word_w, cap, descent = wordmark()

    word_box = f"0 {-cap:.0f} {word_w:.0f} {cap + descent:.0f}"

    # Horizontal lockup: the symbol's own bounds at 1.86 cap heights, centred on the caps.
    symbol_h = cap * LOCKUP_SYMBOL_CAPS
    scale = symbol_h / bh
    symbol_w = bw * scale
    gap = symbol_h * LOCKUP_GAP
    baseline = symbol_h / 2 + cap / 2
    lockup_place = f"scale({scale:.4f}) translate({-bx:g} {-by:g})"
    lockup_word = f"translate({symbol_w + gap:.1f} {baseline:.1f})"
    lockup_box = f"0 0 {symbol_w + gap + word_w:.0f} {max(symbol_h, baseline + descent):.0f}"

    # Stacked lockup: the symbol over the wordmark, both centred on their bounds.
    stack_h = cap * STACK_SYMBOL_CAPS
    stack_scale = stack_h / bh
    stack_symbol_w = bw * stack_scale
    stack_w = max(word_w, stack_symbol_w)
    stack_place = (
        f"translate({(stack_w - stack_symbol_w) / 2:.1f} 0) scale({stack_scale:.4f}) translate({-bx:g} {-by:g})"
    )
    stack_word = f"translate({(stack_w - word_w) / 2:.1f} {stack_h + cap * STACK_GAP_CAPS + cap:.1f})"
    stack_box = f"0 0 {stack_w:.0f} {stack_h + cap * STACK_GAP_CAPS + cap + descent:.0f}"

    # Each variant: ladder colour, held rung colour, wordmark colour.
    variants = {
        "": (INK, BLUE, INK),
        "-mono-black": (INK, INK, INK),
        "-mono-white": (WHITE, WHITE, WHITE),
        "-reversed": (WHITE, BLUE_ON_DARK, WHITE),
    }
    for suffix, (ladder, held, word_colour) in variants.items():
        (out / f"vayle-symbol{suffix}.svg").write_text(
            svg(mark["MARK_VIEWBOX"], symbol_body(mark, ladder, held)), encoding="utf-8"
        )
        (out / f"vayle-wordmark{suffix}.svg").write_text(
            svg(word_box, f'<path fill="{word_colour}" d="{word}"/>'), encoding="utf-8"
        )
        (out / f"vayle-lockup-horizontal{suffix}.svg").write_text(
            svg(
                lockup_box,
                symbol_body(mark, ladder, held, lockup_place)
                + f'<path fill="{word_colour}" transform="{lockup_word}" d="{word}"/>',
            ),
            encoding="utf-8",
        )
        (out / f"vayle-lockup-stacked{suffix}.svg").write_text(
            svg(
                stack_box,
                symbol_body(mark, ladder, held, stack_place)
                + f'<path fill="{word_colour}" transform="{stack_word}" d="{word}"/>',
            ),
            encoding="utf-8",
        )

    icon = app_icon(mark, rounded=True)
    (out / "vayle-app-icon.svg").write_text(icon, encoding="utf-8")
    print(f"wrote masters to {out}")
    export_icons(mark, icon)


def app_icon(mark: dict[str, str], rounded: bool) -> str:
    """The symbol in white on the brand blue. Square corners where the platform applies its own mask."""
    inset = TILE_INSET * TILE
    _, _, grid_w, _ = map(float, mark["MARK_VIEWBOX"].split())
    icon_scale = (TILE - 2 * inset) / grid_w
    radius = f' rx="{TILE * TILE_RADIUS:.2f}"' if rounded else ""
    body = (
        f'<rect width="{TILE}" height="{TILE}"{radius} fill="{BLUE}"/>'
        + symbol_body(mark, WHITE, WHITE, f"translate({inset:.2f} {inset:.2f}) scale({icon_scale:.4f})")
    )
    return svg(f"0 0 {TILE} {TILE}", body)


def small_icon(mark: dict[str, str]) -> str:
    """The pixel-drawn symbol on the blue tile, for 16 and 32 px."""
    _, _, size, _ = map(float, mark["MARK_SMALL_VIEWBOX"].split())
    body = (
        f'<rect width="{size:g}" height="{size:g}" rx="{size * TILE_RADIUS:.2f}" fill="{BLUE}"/>'
        f'<path fill="{WHITE}" d="{mark["MARK_SMALL_PATH"]}"/>'
    )
    return svg(mark["MARK_SMALL_VIEWBOX"], body)


# What the web app serves: the SVG favicon, an ICO for browsers and tools that ask for one, and the
# icons the manifest and iOS use.
PUBLIC_ICONS = [
    "favicon.svg",
    "favicon.ico",
    "apple-touch-icon.png",
    "icon-192.png",
    "icon-512.png",
    "icon-maskable-512.png",
]


def export_icons(mark: dict[str, str], icon: str) -> None:
    """Favicons and app icons, rendered from the masters and copied into the web app."""
    import cairosvg
    from PIL import Image

    favicon = ROOT / "favicon"
    favicon.mkdir(exist_ok=True)
    small = small_icon(mark)
    full_bleed = app_icon(mark, rounded=False)
    (favicon / "favicon.svg").write_text(small, encoding="utf-8")
    renders = {
        "favicon-16.png": (small, 16),
        "favicon-32.png": (small, 32),
        "favicon-48.png": (small, 48),
        # iOS and maskable icons get square corners: the platform cuts its own shape.
        "apple-touch-icon.png": (full_bleed, 180),
        "icon-maskable-512.png": (full_bleed, 512),
        "icon-192.png": (icon, 192),
        "icon-512.png": (icon, 512),
    }
    for name, (source, size) in renders.items():
        cairosvg.svg2png(
            bytestring=source.encode(), write_to=str(favicon / name), output_width=size, output_height=size
        )
    # The ICO carries the pixel-drawn 16, 32 and 48 px renders as they are, without resampling.
    # Pillow drops any size larger than the image it saves from, so the 48 px frame leads.
    frames = [Image.open(favicon / f"favicon-{size}.png") for size in (48, 32, 16)]
    frames[0].save(
        favicon / "favicon.ico",
        format="ICO",
        sizes=[frame.size for frame in frames],
        append_images=frames[1:],
    )
    for name in PUBLIC_ICONS:
        shutil.copyfile(favicon / name, PUBLIC / name)
    print(f"wrote icons to {favicon} and {PUBLIC}")


if __name__ == "__main__":
    main()
