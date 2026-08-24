# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "datasets>=2.19",
#   "pillow>=10",
#   "openai>=1.40",
# ]
# ///
"""ScreenSpot-v2 grounding accuracy benchmark for deepseek-v4-flash-vision-exp.

Phase 0 gate for dsh computer use: measures whether the DeepSeek vision model
can localize GUI elements accurately enough at its ~640k-pixel budget.

Modes:
  single   one-shot: full screenshot in, normalized click point out
  twostep  coarse point on full screenshot, then refine on a full-resolution
           crop around the coarse point (tests whether region zoom rescues
           accuracy — the read_image_region argument)

Usage:
  uv run bench.py --dry-run            # dataset sanity check, no API calls
  uv run bench.py --n 5                # smoke run
  uv run bench.py --n 200 --mode both  # full run

Outputs JSONL per sample and a summary JSON under results/.
"""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import io
import json
import math
import os
import random
import re
import sys
import time
from pathlib import Path

from PIL import Image

MODEL = "deepseek-v4-flash-vision-exp"
BASE_URL = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
PIXEL_BUDGET = 640_000  # DeepSeek vision encoding budget (~800x800)
CROP_FRACTION = 0.35  # two-step crop edge as fraction of the shorter image side
RESULTS_DIR = Path(__file__).parent / "results"

PROMPT = (
    "You are a GUI grounding model. Locate the UI element described below in the screenshot "
    "and reply with ONLY a JSON object giving the click point in normalized coordinates, "
    'where both x and y run from 0 to 1000 across the full image: {{"x": <int>, "y": <int>}}\n'
    "Element: {instruction}"
)


def load_samples(n: int, seed: int) -> list[dict]:
    """Load and subsample ScreenSpot-v2, returning normalized records."""
    from datasets import load_dataset

    splits = load_dataset("lmms-lab/ScreenSpot-v2")
    ds = splits[next(iter(splits))]

    idx = list(range(len(ds)))
    random.Random(seed).shuffle(idx)
    samples = []
    for i in idx[: n if n > 0 else len(ds)]:
        rec = ds[i]
        img = rec["image"]
        bbox = [float(v) for v in rec["bbox"]]
        samples.append(
            {
                "id": i,
                "image": img,
                "instruction": rec["instruction"],
                "bbox_raw": bbox,
                "data_type": rec.get("data_type", "?"),
                "platform": rec.get("data_source", rec.get("platform", "?")),
                "width": img.width,
                "height": img.height,
            }
        )
    return samples


def detect_bbox_format(samples: list[dict]) -> str:
    """Return 'xyxy' or 'xywh' by checking geometric consistency across samples."""
    xyxy_ok = all(
        s["bbox_raw"][2] > s["bbox_raw"][0] and s["bbox_raw"][3] > s["bbox_raw"][1]
        for s in samples
    )
    xywh_ok = all(
        s["bbox_raw"][0] + s["bbox_raw"][2] <= s["width"] * 1.02
        and s["bbox_raw"][1] + s["bbox_raw"][3] <= s["height"] * 1.02
        for s in samples
    )
    if xyxy_ok and not xywh_ok:
        return "xyxy"
    if xywh_ok and not xyxy_ok:
        return "xywh"
    # Both geometrically consistent: xyxy implies x2>x1 for every box, while under
    # xywh a left-anchored element (x < w) mimics it; a single sample with
    # bbox[2] < bbox[0] rules out xyxy definitively, checked above. Prefer xyxy,
    # the lmms-lab convention, and surface the ambiguity.
    print(f"[warn] bbox format ambiguous over {len(samples)} samples; assuming xyxy")
    return "xyxy"


def to_xyxy(bbox: list[float], fmt: str) -> list[float]:
    """Convert a raw bbox to [x1, y1, x2, y2]."""
    if fmt == "xyxy":
        return bbox
    x, y, w, h = bbox
    return [x, y, x + w, y + h]


def encode_image(img: Image.Image, pixel_budget: int | None = PIXEL_BUDGET) -> str:
    """Downscale to the pixel budget and return a base64 PNG data URL."""
    if pixel_budget and img.width * img.height > pixel_budget:
        scale = math.sqrt(pixel_budget / (img.width * img.height))
        img = img.resize(
            (max(1, round(img.width * scale)), max(1, round(img.height * scale))),
            Image.LANCZOS,
        )
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def parse_point(text: str) -> tuple[float, float] | None:
    """Extract {"x": .., "y": ..} from a model reply, tolerating fences and prose."""
    match = re.search(r'\{[^{}]*"x"[^{}]*\}', text, re.DOTALL)
    if not match:
        return None
    try:
        obj = json.loads(match.group(0))
        return float(obj["x"]), float(obj["y"])
    except (json.JSONDecodeError, KeyError, TypeError, ValueError):
        return None


def ask_point(client, img: Image.Image, instruction: str) -> tuple[tuple[float, float] | None, str]:
    """One grounding query; returns (normalized 0-1000 point or None, raw reply)."""
    resp = client.chat.completions.create(
        model=MODEL,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": encode_image(img)}},
                    {"type": "text", "text": PROMPT.format(instruction=instruction)},
                ],
            }
        ],
        temperature=0.0,
        max_tokens=2000,  # reasoning model: thinking tokens count against this budget
    )
    text = resp.choices[0].message.content or ""
    return parse_point(text), text


def norm_to_pixels(pt: tuple[float, float], width: int, height: int) -> tuple[float, float]:
    """Map a 0-1000 normalized point onto image pixel coordinates."""
    return pt[0] / 1000 * width, pt[1] / 1000 * height


def run_sample(client, sample: dict, bbox_fmt: str, mode: str) -> dict:
    """Evaluate one sample in one mode; returns the JSONL record."""
    img = sample["image"]
    bbox = to_xyxy(sample["bbox_raw"], bbox_fmt)
    record = {
        "id": sample["id"],
        "mode": mode,
        "instruction": sample["instruction"],
        "platform": sample["platform"],
        "data_type": sample["data_type"],
        "bbox": bbox,
        "width": sample["width"],
        "height": sample["height"],
    }
    try:
        coarse, raw = ask_point(client, img, sample["instruction"])
        record["raw_step1"] = raw
        if coarse is None:
            return {**record, "ok": False, "error": "parse_failure_step1"}
        px, py = norm_to_pixels(coarse, img.width, img.height)

        if mode == "twostep":
            edge = round(min(img.width, img.height) * CROP_FRACTION)
            left = min(max(0, round(px - edge / 2)), max(0, img.width - edge))
            top = min(max(0, round(py - edge / 2)), max(0, img.height - edge))
            crop = img.crop((left, top, min(left + edge, img.width), min(top + edge, img.height)))
            fine, raw2 = ask_point(client, crop, sample["instruction"])
            record["raw_step2"] = raw2
            record["crop"] = [left, top, crop.width, crop.height]
            if fine is None:
                return {**record, "ok": False, "error": "parse_failure_step2"}
            px = left + fine[0] / 1000 * crop.width
            py = top + fine[1] / 1000 * crop.height

        hit = bbox[0] <= px <= bbox[2] and bbox[1] <= py <= bbox[3]
        cx, cy = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
        record.update(
            {
                "ok": True,
                "hit": hit,
                "pred": [px, py],
                "err_px": math.dist((px, py), (cx, cy)),
                "err_norm": math.dist((px / img.width, py / img.height), (cx / img.width, cy / img.height)),
            }
        )
        return record
    except Exception as err:  # noqa: BLE001 - record API failures per sample, keep the run going
        return {**record, "ok": False, "error": f"{type(err).__name__}: {err}"}


def summarize(records: list[dict]) -> dict:
    """Aggregate accuracy overall and per mode/platform/data_type."""
    def acc(rs: list[dict]) -> dict:
        done = [r for r in rs if r.get("ok")]
        hits = [r for r in done if r["hit"]]
        return {
            "n": len(rs),
            "completed": len(done),
            "hits": len(hits),
            "accuracy": round(len(hits) / len(done), 4) if done else None,
            "median_err_px": round(sorted(r["err_px"] for r in done)[len(done) // 2], 1) if done else None,
        }

    modes = sorted({r["mode"] for r in records})
    out = {}
    for mode in modes:
        rs = [r for r in records if r["mode"] == mode]
        entry = {"overall": acc(rs)}
        for key in ("platform", "data_type"):
            entry[f"by_{key}"] = {
                val: acc([r for r in rs if r[key] == val]) for val in sorted({r[key] for r in rs})
            }
        out[mode] = entry
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--n", type=int, default=200, help="samples per mode")
    parser.add_argument("--mode", choices=["single", "twostep", "both"], default="single")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--dry-run", action="store_true", help="dataset check only, no API calls")
    args = parser.parse_args()

    samples = load_samples(args.n, args.seed)
    bbox_fmt = detect_bbox_format(samples)
    print(f"loaded {len(samples)} samples, bbox format: {bbox_fmt}")

    if args.dry_run:
        for s in samples[:5]:
            print(
                json.dumps(
                    {
                        "id": s["id"],
                        "instruction": s["instruction"][:80],
                        "bbox_raw": s["bbox_raw"],
                        "xyxy": to_xyxy(s["bbox_raw"], bbox_fmt),
                        "size": [s["width"], s["height"]],
                        "platform": s["platform"],
                        "data_type": s["data_type"],
                    },
                    ensure_ascii=False,
                )
            )
        return

    api_key = os.environ.get("DEEPSEEK_API_KEY")
    if not api_key:
        sys.exit("DEEPSEEK_API_KEY not set")
    from openai import OpenAI

    client = OpenAI(api_key=api_key, base_url=BASE_URL)

    modes = ["single", "twostep"] if args.mode == "both" else [args.mode]
    RESULTS_DIR.mkdir(exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    jsonl_path = RESULTS_DIR / f"run-{stamp}.jsonl"

    records = []
    with jsonl_path.open("w") as sink:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = [
                pool.submit(run_sample, client, s, bbox_fmt, mode)
                for mode in modes
                for s in samples
            ]
            for i, fut in enumerate(concurrent.futures.as_completed(futures), 1):
                rec = fut.result()
                rec.pop("image", None)
                records.append(rec)
                sink.write(json.dumps(rec, ensure_ascii=False) + "\n")
                sink.flush()
                if i % 20 == 0 or i == len(futures):
                    done = [r for r in records if r.get("ok")]
                    hits = sum(1 for r in done if r["hit"])
                    print(f"{i}/{len(futures)} done, running accuracy {hits}/{len(done)}")

    summary = summarize(records)
    summary_path = RESULTS_DIR / f"summary-{stamp}.json"
    summary_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False))
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    print(f"\nresults: {jsonl_path}\nsummary: {summary_path}")


if __name__ == "__main__":
    main()
