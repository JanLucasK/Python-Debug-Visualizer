#!/usr/bin/env python3
"""Draw the extension icon.

Committed as a script rather than only as a PNG, so the icon can be adjusted
and regenerated instead of being an opaque binary nobody dares touch.

    python packages/extension/scripts/make-icon.py

Design constraints, in the order they mattered:

- **Legible at 42 pixels.** That is the size the Marketplace list shows, and it
  is where most extension icons turn to mush. Hence very few shapes, one heavy
  stroke, and no text.
- **No transparency.** The Marketplace recommends against it, and an icon with
  transparent corners looks broken on the light theme and fine on the dark one,
  so the mistake is easy to miss.
- **Says what the tool does.** A plotted line for the data, and a marker on it
  for the point the debugger is stopped at -- which is the whole idea:
  a value, seen at one moment in a run.

Rendered at 4x and downsampled, because Pillow's shape drawing is not
antialiased; scaling down is what produces clean edges.
"""

from __future__ import annotations

import pathlib

from PIL import Image, ImageDraw

SIZE = 128
SCALE = 4
CANVAS = SIZE * SCALE

OUTPUT = pathlib.Path(__file__).resolve().parent.parent / "assets" / "icon.png"

# Slightly deeper than VS Code's editor background, so the icon keeps its own
# edge against a dark theme instead of dissolving into it.
BACKGROUND = (24, 28, 36)
AXIS = (63, 71, 86)
LINE = (57, 135, 229)  # the palette's first categorical slot
MARKER = (235, 104, 52)  # the second, so the two are distinguishable in every CVD mode

#: Fractions of the plot area. Four points, not six: at 32 pixels every extra
#: segment is one more thing to turn into a smudge, and the shape has to read as
#: "a plotted line" from its silhouette alone.
SHAPE = [
    (0.00, 0.78),
    (0.30, 0.46),
    (0.58, 0.66),
    (1.00, 0.10),
]

#: Which vertex carries the marker. The middle trough, so it sits inside the
#: shape rather than on its edge, where a small icon would clip it.
MARKER_AT = 2


def main() -> None:
    image = Image.new("RGB", (CANVAS, CANVAS), BACKGROUND)
    draw = ImageDraw.Draw(image)

    # Generous bleed: at list size the icon is mostly margin otherwise.
    left, right = 0.16 * CANVAS, 0.86 * CANVAS
    top, bottom = 0.16 * CANVAS, 0.78 * CANVAS

    points = [
        (left + fx * (right - left), top + fy * (bottom - top)) for fx, fy in SHAPE
    ]

    # A baseline only. A full pair of axes was tested and lost: at 32 pixels the
    # vertical one crowds the line's left end into an indistinct blob, and the
    # reading "this is a plot" survives perfectly well without it.
    draw.line(
        [(left - 0.03 * CANVAS, bottom + 0.10 * CANVAS), (right + 0.03 * CANVAS, bottom + 0.10 * CANVAS)],
        fill=AXIS,
        width=max(1, int(0.022 * CANVAS)),
    )

    stroke = int(0.085 * CANVAS)
    draw.line(points, fill=LINE, width=stroke, joint="curve")
    # Round the ends by hand; Pillow has no cap style.
    for point in (points[0], points[-1]):
        _dot(draw, point, stroke / 2, LINE)

    # The breakpoint: a filled marker ringed in the background colour, so it
    # stays a distinct object where the line passes underneath it.
    marker = points[MARKER_AT]
    _dot(draw, marker, 0.105 * CANVAS, BACKGROUND)
    _dot(draw, marker, 0.075 * CANVAS, MARKER)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    image.resize((SIZE, SIZE), Image.LANCZOS).save(OUTPUT, "PNG", optimize=True)
    print(f"wrote {OUTPUT} ({SIZE}x{SIZE})")


def _dot(draw: ImageDraw.ImageDraw, centre: tuple[float, float], radius: float, fill) -> None:
    x, y = centre
    draw.ellipse([x - radius, y - radius, x + radius, y + radius], fill=fill)


if __name__ == "__main__":
    main()
