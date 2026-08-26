#!/usr/bin/env python3
"""What the model actually sees after the image pixel budget is applied.

The DeepSeek route caps one request image at DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET
= 640_000 px (deepseek-harness: packages/llm/llm-deepseek/src/adapter.ts:142)
and downscales isotropically to fit:

    scale = min(1, sqrt(maxPixels / (width * height)))
    -- deepseek-harness: packages/attachment/attachment-local/src/request-image.ts:51

That reduction is invisible in the tool output, so it is easy to reason about
grounding as if the model saw the screenshot at capture resolution. It does
not: on a 4K display a 20px button lands on the model's retina at 5.6px.

What this does NOT explain -- a correction worth recording, because the
tempting causal story is wrong. The Phase 0 per-platform scores are not driven
by downscaling:

  - Windows samples are 960x540 (0.52M px), so scale = 1.000, no downscaling
    at all -- and Windows scored WORST of all platforms at 52.0%.
  - shop and tool samples are both 2560x1440, identical scale 0.417, yet score
    48.7% and 80.0% -- a 31-point spread at the same resolution.

So the binding factor in the measured data is UI density and target size, not
the pixel budget. The budget is a separate, additive risk that the Phase 0
sample never exercised: nothing in ScreenSpot-v2 is as punishing as a 4K
full-screen capture (scale 0.278).

Design consequence, from both facts at once: capture per window, never the
full screen -- and do not expect a per-window capture to rescue grounding on
dense desktop UI, because density hurts independently.

Run: python3 experiments/pixel-budget/budget.py
"""

import math

BUDGET = 640_000

CASES = [
    ("plugin default viewport (launch)", 1280, 800),
    ("attached Electron window (Retina)", 1800, 1026),
    ("MacBook built-in display", 3024, 1964),
    ("4K external display", 3840, 2160),
    ("5K iMac / Studio Display", 5120, 2880),
    ("single app window, 1200x800 @2x", 2400, 1600),
]


def projected(width: int, height: int, budget: int = BUDGET) -> tuple[float, int, int]:
    """Scale factor and resulting dimensions after the budget is applied."""
    scale = min(1.0, math.sqrt(budget / (width * height)))
    return scale, int(width * scale), int(height * scale)


def main() -> None:
    header = f"{'capture':<36}{'source':>12}{'scale':>7}{'model sees':>13}{'20px btn':>10}{'12px icon':>11}"
    print(header)
    print("-" * len(header))
    for name, width, height in CASES:
        scale, out_w, out_h = projected(width, height)
        print(
            f"{name:<36}{f'{width}x{height}':>12}{scale:>7.3f}"
            f"{f'{out_w}x{out_h}':>13}{f'{20 * scale:.1f}px':>10}{f'{12 * scale:.1f}px':>11}"
        )
    print()
    print("Rule of thumb: below ~8px a target is not reliably localizable by a")
    print("general (non-grounding-specialized) vision model, so full-screen")
    print("desktop capture is outside the usable envelope at this budget.")


if __name__ == "__main__":
    main()
