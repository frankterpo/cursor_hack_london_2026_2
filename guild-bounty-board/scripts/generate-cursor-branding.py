#!/usr/bin/env python3
"""Recolor cursor-cube.png to Briefcase luminous teal (aligns with --primary-400 / #87d3e1).

Writes:
  - cursor-cube-briefcase.png (full res, UI / header)
  - cursor-cube-briefcase-32.png, cursor-cube-briefcase-16.png (favicons)
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "public" / "cursor-cube.png"
OUT_DIR = ROOT / "public"
CREDITS_PUBLIC = ROOT / "credits-portal" / "public"
HCMC_STATIC = ROOT.parent / "cursor-hackathon-hcmc-2025" / "ui" / "static"

# Matches HCMC / Briefcase CSS --primary-400 (#87d3e1) for line-art that reads luminous on dark.
TR, TG, TB = 135, 211, 225


def tint_rgba(r: int, g: int, b: int, a: int) -> tuple[int, int, int, int]:
    if a == 0:
        return (0, 0, 0, 0)
    # Perceived luminance 0..1
    y = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0
    # Lift mids so strokes read closer to primary-300/400 accents on the page
    y_v = min(1.0, max(0.0, y**0.45))
    k = 0.28 + 0.92 * y_v
    nr = int(min(255, TR * k * 1.08))
    ng = int(min(255, TG * k * 1.08))
    nb = int(min(255, TB * k * 1.08))
    return (nr, ng, nb, a)


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"Missing source cube: {SRC}")

    im = Image.open(SRC).convert("RGBA")
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            px[x, y] = tint_rgba(*px[x, y])

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    CREDITS_PUBLIC.mkdir(parents=True, exist_ok=True)
    if HCMC_STATIC.exists():
        HCMC_STATIC.mkdir(parents=True, exist_ok=True)

    main_path = OUT_DIR / "cursor-cube-briefcase.png"
    im.save(main_path, optimize=True)

    for size, name in ((32, "cursor-cube-briefcase-32.png"), (16, "cursor-cube-briefcase-16.png")):
        small = im.resize((size, size), Image.Resampling.LANCZOS)
        p = OUT_DIR / name
        small.save(p, optimize=True)
        small.save(CREDITS_PUBLIC / name, optimize=True)

    # Credits portal uses same hero/header asset
    im.save(CREDITS_PUBLIC / "cursor-cube-briefcase.png", optimize=True)

    if HCMC_STATIC.exists():
        im.save(HCMC_STATIC / "cursor-cube-briefcase.png", optimize=True)
        im.resize((32, 32), Image.Resampling.LANCZOS).save(
            HCMC_STATIC / "cursor-cube-briefcase-32.png", optimize=True
        )
        im.resize((16, 16), Image.Resampling.LANCZOS).save(
            HCMC_STATIC / "cursor-cube-briefcase-16.png", optimize=True
        )

    print("Wrote:", main_path, OUT_DIR / "cursor-cube-briefcase-32.png", CREDITS_PUBLIC / "cursor-cube-briefcase.png")


if __name__ == "__main__":
    main()
