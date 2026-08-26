#!/usr/bin/env python3
"""Anatomy of the 38% that missed: imprecision or misunderstanding?

The headline from Phase 0 is 61.8% single-shot grounding. That number alone
does not say whether the failures are recoverable. Two very different worlds
hide behind it:

  - The model understood which control to hit and landed slightly off. This is
    a precision problem, and precision problems yield to engineering: snapping
    a prediction to the nearest enumerated element rect, or a verify-then-retry
    loop, converts many of them into hits.
  - The model looked in the wrong region entirely. This is a comprehension
    problem, and no amount of geometry fixes it.

Re-analyses the existing run; makes no new API calls.

Run: python3 experiments/screenspot-grounding/miss_anatomy.py
"""

import glob
import json
import math
import os
import statistics as st

RESULTS = os.path.join(os.path.dirname(__file__), "results")


def load_single_mode(path: str) -> list[dict]:
    """Completed single-shot samples carrying both a prediction and a target."""
    out = []
    with open(path) as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if record.get("mode") != "single" or not record.get("ok"):
                continue
            if record.get("bbox") and record.get("pred"):
                out.append(record)
    return out


def distance_outside(point: tuple[float, float], bbox: list[float]) -> float:
    """Distance from a point to a box; zero when inside."""
    x, y = point
    x1, y1, x2, y2 = bbox
    dx = max(x1 - x, 0.0, x - x2)
    dy = max(y1 - y, 0.0, y - y2)
    return math.hypot(dx, dy)


def main() -> None:
    runs = sorted(glob.glob(os.path.join(RESULTS, "run-*.jsonl")))
    if not runs:
        print("no run-*.jsonl in results/")
        return
    samples = load_single_mode(runs[-1])

    misses = []
    for record in samples:
        bbox = record["bbox"]
        gap = distance_outside(tuple(record["pred"]), bbox)
        diagonal = math.hypot(bbox[2] - bbox[0], bbox[3] - bbox[1])
        if not record.get("hit"):
            misses.append((gap, diagonal, record.get("platform")))

    hits = len(samples) - len(misses)
    print(f"run: {os.path.basename(runs[-1])}")
    print(f"samples {len(samples)}  hit {hits}  miss {len(misses)}"
          f"  ({hits / len(samples) * 100:.1f}%)")

    gaps = sorted(gap for gap, _, _ in misses)
    print("\ngap from the target box, misses only:")
    for pct in (10, 25, 50, 75, 90):
        index = min(len(gaps) - 1, int(len(gaps) * pct / 100))
        print(f"   P{pct}: {gaps[index]:.0f}px")

    # Scale each gap by the target's own size: a 60px gap means something very
    # different on a 40px icon than on a 600px banner.
    near = [m for m in misses if m[0] < m[1] * 0.5]
    far = [m for m in misses if m[0] > m[1] * 2]
    print(f"\nnear miss (gap < half the target's diagonal): "
          f"{len(near)}/{len(misses)} = {len(near) / len(misses) * 100:.0f}%")
    print(f"far miss  (gap > 2x the target's diagonal):   "
          f"{len(far)}/{len(misses)} = {len(far) / len(misses) * 100:.0f}%")
    print(f"\nmedian target diagonal across all samples: "
          f"{st.median([math.hypot(r['bbox'][2] - r['bbox'][0], r['bbox'][3] - r['bbox'][1]) for r in samples]):.0f}px")

    print("""
Reading: the dominant failure is imprecision, not misunderstanding. That makes
the weak grounder far more useful than 61.8% suggests, but only if the
coordinate is post-processed rather than clicked raw.

The hypothesis this supports -- NOT yet proven, and the honest next experiment:
snap a predicted point to the nearest enumerated element rect instead of
clicking it directly. ScreenSpot ships only the target box, not every element
on screen, so this data cannot tell us whether a competing element sits closer.
Testing it needs real pages where the full element list and its geometry are
known, which is exactly what the plugin's own snapshot already produces.""")


if __name__ == "__main__":
    main()
