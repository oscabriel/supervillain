#!/usr/bin/env python3
"""Bake the MEKMODE glyph atlas (ADR-0007 as amended by ADR-0021).

Hand-run, rarely. Rasterizes the MEKMODE Text and Dings OTFs into 1-bit 8x12
bitmaps and emits the generated modules under ../src/generated/ with ADR-0011
provenance headers. Deterministic: re-running against the same OTFs produces
byte-identical output.

The raw OTFs are private (informal permission from MEK.txt, no written terms —
ADR-0021) and are never committed; this script reads them from a local path.

Usage:
    python3 bake.py <MEKMODE-Text.otf> <MEKMODE-Dings.otf>

Requires Python >= 3.14 (Unicode 16 character names) with fonttools and
freetype-py installed (e.g. in a venv).

Method (established and validated 2026-07-30, see ADR-0021):
    MEKMODE outlines sit on an exact 100-units-per-pixel lattice inside a
    1000-unit em; glyphs span x 0..800, y -300..+900. Rasterizing at 10 ppem
    with mono rendering and no hinting recovers the author's 8x12 pixels
    exactly (verified pixel-for-pixel against MEK.txt's published specimen).
"""

import hashlib
import json
import sys
import unicodedata
from pathlib import Path

import freetype
from fontTools.ttLib import TTFont

GLYPH_WIDTH = 8
GLYPH_HEIGHT = 12
PPEM = 10
BASELINE_ROW = 9  # y=+900 font units = row 0; baseline sits at the top of row 9
ACCESSED = "2026-07-30"  # the date the OTFs were obtained from MEK.txt
LICENSE = (
    "informal permission from MEK.txt, no written terms (2026-07-30) — ADR-0021"
)
SOURCE_URL = "https://www.mek.gallery/mekmode-otf"
OUT_DIR = Path(__file__).resolve().parent.parent / "src" / "generated"

# Octant cell numbering (Unicode convention): 2 columns x 4 rows, row-major —
# cell 1 = top-left ... cell 8 = bottom-right. Pattern bit i = cell i+1.
OCTANT_EXCEPTIONS = {
    frozenset(): " ",
    frozenset(range(1, 9)): "\u2588",
    frozenset({1, 2, 3, 4}): "\u2580",
    frozenset({5, 6, 7, 8}): "\u2584",
    frozenset({1, 3, 5, 7}): "\u258c",
    frozenset({2, 4, 6, 8}): "\u2590",
    frozenset({1, 2}): "\U0001fb82",
    frozenset({7, 8}): "\u2582",
    frozenset({1, 2, 3, 4, 5, 6}): "\U0001fb85",
    frozenset({3, 4, 5, 6, 7, 8}): "\u2586",
    frozenset({1, 3}): "\u2598",
    frozenset({2, 4}): "\u259d",
    frozenset({5, 7}): "\u2596",
    frozenset({6, 8}): "\u2597",
    frozenset({1, 3, 6, 8}): "\u259a",
    frozenset({2, 4, 5, 7}): "\u259e",
    frozenset({1, 2, 3, 4, 5, 7}): "\u259b",
    frozenset({1, 2, 3, 4, 6, 8}): "\u259c",
    frozenset({1, 3, 5, 6, 7, 8}): "\u2599",
    frozenset({2, 4, 5, 6, 7, 8}): "\u259f",
    frozenset({1}): "\U0001cea8",
    frozenset({2}): "\U0001ceab",
    frozenset({7}): "\U0001cea3",
    frozenset({8}): "\U0001cea0",
    frozenset({3, 5}): "\U0001fbe6",
    frozenset({4, 6}): "\U0001fbe7",
}


def octant_chars():
    chars = []
    for pattern in range(256):
        cells = frozenset(i + 1 for i in range(8) if pattern & (1 << i))
        char = OCTANT_EXCEPTIONS.get(cells)
        if char is None:
            name = "BLOCK OCTANT-" + "".join(str(c) for c in sorted(cells))
            char = unicodedata.lookup(name)
        chars.append(char)
    if len(set(chars)) != 256:
        raise SystemExit("octant table is not bijective")
    return chars


def extract(path):
    """All cmap-mapped glyphs as {codepoint: 12 row bytes}, MSB = leftmost px."""
    cmap = TTFont(path).getBestCmap()
    face = freetype.Face(str(path))
    face.set_pixel_sizes(PPEM, PPEM)
    load_flags = freetype.FT_LOAD_NO_HINTING | freetype.FT_LOAD_TARGET_MONO

    glyphs = {}
    for codepoint in sorted(cmap):
        index = face.get_char_index(codepoint)
        if index == 0:
            raise SystemExit(f"U+{codepoint:04X} is cmap-mapped but has no glyph")
        face.load_glyph(index, load_flags)
        face.glyph.render(freetype.FT_RENDER_MODE_MONO)
        bitmap = face.glyph.bitmap
        left, top = face.glyph.bitmap_left, face.glyph.bitmap_top

        frame = [0] * GLYPH_HEIGHT
        for by in range(bitmap.rows):
            fy = (BASELINE_ROW - top) + by
            for bx in range(bitmap.width):
                byte = bitmap.buffer[by * bitmap.pitch + bx // 8]
                if not (byte >> (7 - bx % 8)) & 1:
                    continue
                fx = left + bx
                if not (0 <= fy < GLYPH_HEIGHT and 0 <= fx < GLYPH_WIDTH):
                    raise SystemExit(
                        f"U+{codepoint:04X} px ({fx},{fy}) outside the 8x12 frame"
                    )
                frame[fy] |= 1 << (7 - fx)
        glyphs[codepoint] = bytes(frame)
    return glyphs


def font_version(path):
    return TTFont(path)["name"].getDebugName(5)


def provenance_header(mode, path, sha256, version):
    return f"""// GENERATED FILE — do not edit. Regenerate with packages/atlas/bake/bake.py.
// Provenance (ADR-0011, generated-data header):
//   data: 1-bit 8x12 glyph bitmaps — every cmap-mapped glyph of MEKMODE {mode}
//   work: MEKMODE ({mode} mode)
//   version: {version}
//   author: MEK.txt
//   license: {LICENSE}
//   sourceUrl: {SOURCE_URL}
//   accessed: {ACCESSED}
//   sourceSha256: {sha256} ({path.name})
//   bake: FreeType {PPEM} ppem, mono render, no hinting; frame x=0, baseline at top of row {BASELINE_ROW}
"""


def emit_atlas(mode, const_name, path, glyphs):
    sha256 = hashlib.sha256(path.read_bytes()).hexdigest()
    lines = [provenance_header(mode, path, sha256, font_version(path))]
    lines.append(
        f"/** MEKMODE {mode} glyphs keyed by the character each one depicts;"
        " values are 12 row bytes (MSB = leftmost pixel) as 24 hex chars. */"
    )
    lines.append(f"export const {const_name}: Readonly<Record<string, string>> = {{")
    for codepoint, rows in glyphs.items():
        key = json.dumps(chr(codepoint), ensure_ascii=True)
        lines.append(f'\t{key}: "{rows.hex()}",')
    lines.append("};")
    out = OUT_DIR / f"{mode.lower()}.ts"
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {out} ({len(glyphs)} glyphs)")


def emit_octants():
    chars = octant_chars()
    lines = [
        "// GENERATED FILE — do not edit. Regenerate with packages/atlas/bake/bake.py.",
        f"// Unicode octant characters (Unicode {unicodedata.unidata_version}),"
        " indexed by 2x4 pixel pattern:",
        "// bit i = cell i+1, cells numbered row-major, 2 columns x 4 rows,"
        " cell 1 = top-left.",
        "",
        "/** The 256 octant characters; index with an 8-bit 2x4 pixel pattern. */",
        "export const OCTANT_CHARS: readonly string[] = [",
    ]
    for char in chars:
        lines.append(f"\t{json.dumps(char, ensure_ascii=True)},")
    lines.append("];")
    out = OUT_DIR / "octants.ts"
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {out} (256 chars)")


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    text_otf, dings_otf = Path(sys.argv[1]), Path(sys.argv[2])
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    emit_atlas("Text", "TEXT_ATLAS", text_otf, extract(text_otf))
    emit_atlas("Dings", "DINGS_ATLAS", dings_otf, extract(dings_otf))
    emit_octants()


if __name__ == "__main__":
    main()
