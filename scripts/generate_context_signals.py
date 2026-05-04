#!/usr/bin/env python3
"""Generate the 12 context-signal tile images for the Cursor x Thrads page.

Each tile is rendered as a tweet-card-style preview: dark background, accent
gradient stripe, handle, headline, and a small "X" mark in the corner. These
are placeholders meant to convey the topic at a glance — replace with real
screenshots when available.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT_DIR = Path(__file__).resolve().parent.parent / "cursor-hackathon-hcmc-2025" / "ui" / "static" / "context-signals"

W, H = 560, 320  # rendered at 2x then displayed at 280x160

# Thrad palette: warm orange ramp on near-black. Each tile alternates a tone in
# the same family so the strip reads as one brand, not a rainbow.
TILES = [
    ("01.png", "@Thrad_ai",     "Paid Ads in AI",                            "Real-time bidding inside LLM conversations.",                "#F26B3D"),
    ("02.png", "@OpenAI",       "Testing ads in ChatGPT",                    "Ads roll out to Free + Go users. Feb 2026.",                 "#FF8C5A"),
    ("03.png", "@sama",         "Ads do not bend the answer",                "ChatGPT keeps conversations private from advertisers.",      "#FFB997"),
    ("04.png", "@AnthropicAI",  "Ads are coming to AI.\nBut not to Claude.", "Super Bowl LX, ~$8M, 4 spots, one target.",                  "#E04E25"),
    ("05.png", "@sama",         "Funny, but clearly dishonest",              "Altman fires back at Anthropic on X.",                       "#F26B3D"),
    ("06.png", "@Adweek",       "$200K to advertise in ChatGPT",             "OpenAI's beta floor confirmed. The buy-side is in.",         "#FF8C5A"),
    ("07.png", "@verge",        "ChatGPT ads in the wild",                   "Expedia, Best Buy, Qualcomm — first conversational ads.",    "#FFB997"),
    ("08.png", "@Digiday",      "CPM → CPC: $3–$5 a click",                  "OpenAI cuts over to cost-per-click. Ten weeks in.",          "#E04E25"),
    ("09.png", "@adage",        "Omnicom + Dentsu plug in",                  "Holding companies move first into ChatGPT ads.",             "#F26B3D"),
    ("10.png", "Thrad newsroom","AWS × Thrad",                               "AWS picks Thrad as its agentic-ad-architecture case study.", "#FF8C5A"),
    ("11.png", "Thrad newsroom","BCG × Thrad",                               "First cross-industry report sizing paid ads in AI.",         "#FFB997"),
    ("12.png", "X search",      "“Last resort” → endgame",                   "2024 Altman: ads are last resort. 2026: ads are live.",      "#E04E25"),
]


def font(size: int, weight: str = "bold") -> ImageFont.FreeTypeFont:
    candidates_bold = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/HelveticaNeue.ttc",
        "/Library/Fonts/Arial Bold.ttf",
    ]
    candidates_reg = [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial.ttf",
    ]
    pool = candidates_bold if weight == "bold" else candidates_reg
    for p in pool:
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            continue
    return ImageFont.load_default()


def render_tile(path: Path, handle: str, headline: str, sub: str, accent: str) -> None:
    img = Image.new("RGB", (W, H), "#0b0b0d")
    d = ImageDraw.Draw(img)

    # Accent stripe top
    d.rectangle((0, 0, W, 6), fill=accent)
    # Hairline border
    d.rectangle((0, 0, W - 1, H - 1), outline="#1f1f24", width=2)

    # X bird-ish mark (use the literal letter)
    d.text((W - 38, 18), "𝕏", fill="#3a3a40", font=font(28))

    # Handle row (small dot avatar + handle)
    d.ellipse((28, 32, 60, 64), fill=accent)
    d.text((72, 36), handle, fill="#e5e5e7", font=font(22, "regular"))

    # Headline
    d.multiline_text((28, 92), headline, fill="#ffffff", font=font(34), spacing=6)

    # Subline
    sub_lines = []
    words = sub.split()
    cur = ""
    max_chars = 56
    for w in words:
        if len(cur) + len(w) + 1 > max_chars:
            sub_lines.append(cur.strip())
            cur = w + " "
        else:
            cur += w + " "
    if cur.strip():
        sub_lines.append(cur.strip())
    d.multiline_text((28, H - 90), "\n".join(sub_lines), fill="#9b9ba1", font=font(20, "regular"), spacing=4)

    # Footer line
    d.line((28, H - 40, W - 28, H - 40), fill="#1f1f24", width=1)
    d.text((28, H - 30), "Signal on X · illustrative", fill="#5a5a60", font=font(16, "regular"))

    img.save(path, "PNG", optimize=True)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, handle, headline, sub, accent in TILES:
        out = OUT_DIR / name
        render_tile(out, handle, headline, sub, accent)
        print(f"wrote {out.relative_to(OUT_DIR.parent.parent.parent.parent)}")


if __name__ == "__main__":
    main()
