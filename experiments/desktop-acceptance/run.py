#!/usr/bin/env python3
"""Capability acceptance for the macOS desktop path.

Two things make this different from the browser suite, both learned from its
failures.

First, every criterion reads the target application's own state back through
the accessibility tree. The browser suite let seven of fifteen tasks pass on
words that appeared in their own prompt, and one passed by matching the "1" in
a numbered list while the answer it was checking said zero. A criterion here
either observes the application changing or it fails.

Second, the co-driving invariant is checked per action rather than asserted
once in a design document. Every action reports whether it moved the cursor or
took focus, and any true fails the case no matter what else went right.

No model runs here. This asks whether the mechanism works, which is the
precondition for asking whether a model can use it. Model-level acceptance is a
separate suite and, per the repository's unattended rules, needs a human
present.

    python3 experiments/desktop-acceptance/run.py            # all cases
    python3 experiments/desktop-acceptance/run.py --case press-by-index
    python3 experiments/desktop-acceptance/run.py --list
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

HELPER = Path(__file__).resolve().parents[2] / "packages/computer-macos/helper/dsh-computer-macos-helper"
CALCULATOR = "com.apple.calculator"
# The WeChat devtools; Chromium applications report this bundle id.
ELECTRON = "com.github.Electron"
RESULTS = Path(__file__).resolve().parent / "results"


class Helper:
    """One helper process, spoken to over its stdio protocol."""

    def __init__(self, path: Path) -> None:
        self.proc = subprocess.Popen(
            [str(path)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1,
        )
        self.next_id = 1

    def call(self, method: str, **params) -> dict:
        request = {"id": self.next_id, "method": method}
        if params:
            request["params"] = params
        self.next_id += 1
        assert self.proc.stdin is not None and self.proc.stdout is not None
        self.proc.stdin.write(json.dumps(request) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("the helper closed its output")
        return json.loads(line)

    def close(self) -> None:
        try:
            assert self.proc.stdin is not None
            self.proc.stdin.close()
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


@dataclass
class Case:
    name: str
    intent: str
    run: object
    needs: str = CALCULATOR


@dataclass
class Outcome:
    name: str
    passed: bool
    detail: str
    checks: dict = field(default_factory=dict)


# ---------------------------------------------------------------- utilities

def launch_background(bundle_id: str) -> None:
    """Start an application without bringing it forward.

    The -g matters: the whole point is driving something the user is not
    looking at, so a case that raises its own target proves nothing.
    """
    subprocess.run(["open", "-g", "-b", bundle_id], check=False)
    time.sleep(1.5)


def quit_app(bundle_id: str) -> None:
    name = {"com.apple.calculator": "Calculator"}.get(bundle_id)
    if name:
        subprocess.run(["osascript", "-e", f'tell application "{name}" to quit'],
                       check=False, capture_output=True)


def display_text(helper: Helper) -> str:
    """The calculator's readout, read from the window's own content.

    Deliberately not the window title: a title is the same before and after
    every action, so a criterion built on it can never fail and can never
    detect anything. The first version of this suite made that mistake and two
    cases passed nothing while looking green.
    """
    response = helper.call("snapshot", bundleId=CALCULATOR)
    if "error" in response:
        return f"<error {response['error']['code']}>"
    return " | ".join(response["result"].get("text", []))


def find(elements: list[dict], name: str) -> dict | None:
    return next((e for e in elements if e.get("name") == name), None)


def undisturbed(result: dict) -> tuple[bool, str]:
    """The invariant, read off whatever the helper reported for this action."""
    stolen = result.get("focusStolen")
    moved = result.get("cursorMoved")
    ok = stolen is False and moved is False
    return ok, f"focusStolen={stolen} cursorMoved={moved}"


# ------------------------------------------------------------------- cases

def case_enumerate(helper: Helper) -> Outcome:
    """A background window must be readable at all, with usable names."""
    response = helper.call("snapshot", bundleId=CALCULATOR)
    if "error" in response:
        return Outcome("enumerate", False, f"snapshot failed: {response['error']}")
    elements = response["result"]["elements"]
    digits = [str(d) for d in range(10)]
    found = [d for d in digits if find(elements, d)]
    checks = {
        "elements_present": len(elements) > 0,
        "all_digits_named": len(found) == 10,
        "geometry_present": any(e.get("rect") for e in elements),
        "actions_reported": any(e.get("actions") for e in elements),
    }
    return Outcome("enumerate", all(checks.values()),
                   f"{len(elements)} elements, digits found {len(found)}/10", checks)


def case_press_by_index(helper: Helper) -> Outcome:
    """The core loop: press a control and see the application change.

    Two presses and an equals, so the witness is arithmetic rather than a
    single digit that could echo a stale value.
    """
    # Clear first. A case that assumes the calculator starts empty is a case
    # that fails whenever anything ran before it -- which is what happened when
    # a unit test began leaving "77" on the display. State a case depends on,
    # it should establish.
    snapshot = helper.call("snapshot", bundleId=CALCULATOR)["result"]
    for clear_label in ("全部清除", "清除", "AC", "C"):
        target = find(snapshot["elements"], clear_label)
        if target is not None:
            helper.call("press", bundleId=CALCULATOR, index=target["index"],
                        expectRole=target["role"], expectName=target["name"])
            break

    before = display_text(helper)
    steps = []
    for label in ["7", "乘", "6", "等于"]:
        snapshot = helper.call("snapshot", bundleId=CALCULATOR)["result"]
        target = find(snapshot["elements"], label)
        if target is None:
            return Outcome("press-by-index", False, f"no control named {label}")
        response = helper.call("press", bundleId=CALCULATOR, index=target["index"],
                               expectRole=target["role"], expectName=target["name"])
        if "error" in response:
            return Outcome("press-by-index", False, f"press {label}: {response['error']['message']}")
        ok, note = undisturbed(response["result"])
        steps.append((label, ok, note))

    after = display_text(helper)
    checks = {
        "state_changed": before != after,
        "result_is_42": "42" in after,
        "never_disturbed": all(ok for _, ok, _ in steps),
    }
    return Outcome("press-by-index", all(checks.values()),
                   f"display {before!r} -> {after!r}; " + "; ".join(f"{l}:{n}" for l, _, n in steps),
                   checks)


def case_identity_guard(helper: Helper) -> Outcome:
    """An action whose target no longer matches must be refused, not performed.

    This is the guard that matters most on a desktop: a wrong press cannot be
    undone the way a wrong click in a browser can.
    """
    snapshot = helper.call("snapshot", bundleId=CALCULATOR)["result"]
    target = find(snapshot["elements"], "7")
    if target is None:
        return Outcome("identity-guard", False, "no 7 key to aim at")
    before = display_text(helper)
    response = helper.call("press", bundleId=CALCULATOR, index=target["index"],
                           expectRole="AXButton", expectName="this element does not exist")
    after = display_text(helper)
    checks = {
        "refused": "error" in response,
        "named_the_mismatch": "error" in response and "take a fresh snapshot" in response["error"]["message"],
        "nothing_happened": before == after,
    }
    detail = response.get("error", {}).get("message", "no error returned")
    return Outcome("identity-guard", all(checks.values()), detail[:120], checks)


def case_coordinate_hit_test(helper: Helper) -> Outcome:
    """A coordinate must resolve to a named element before anything is pressed."""
    snapshot = helper.call("snapshot", bundleId=CALCULATOR)["result"]
    target = find(snapshot["elements"], "5")
    if target is None or not target.get("rect"):
        return Outcome("coordinate-hit-test", False, "no 5 key with geometry")
    rect = target["rect"]
    before = display_text(helper)
    response = helper.call("pressAt", bundleId=CALCULATOR,
                           x=rect["x"] + rect["width"] / 2, y=rect["y"] + rect["height"] / 2)
    if "error" in response:
        return Outcome("coordinate-hit-test", False, response["error"]["message"])
    result = response["result"]
    ok, note = undisturbed(result)
    after = display_text(helper)
    checks = {
        "resolved_to_the_key": '"5"' in result.get("acted", ""),
        "reported_what_it_hit": "resolvedFrom" in result,
        "state_changed": before != after,
        "never_disturbed": ok,
    }
    return Outcome("coordinate-hit-test", all(checks.values()),
                   f"{result.get('acted')} from {result.get('resolvedFrom')}; {note}", checks)


def case_coordinate_mismatch(helper: Helper) -> Outcome:
    """Aiming at the wrong thing must be caught before the press, not after."""
    snapshot = helper.call("snapshot", bundleId=CALCULATOR)["result"]
    target = find(snapshot["elements"], "5")
    if target is None or not target.get("rect"):
        return Outcome("coordinate-mismatch", False, "no 5 key with geometry")
    rect = target["rect"]
    before = display_text(helper)
    response = helper.call("pressAt", bundleId=CALCULATOR,
                           x=rect["x"] + rect["width"] / 2, y=rect["y"] + rect["height"] / 2,
                           expectName="9")
    after = display_text(helper)
    checks = {
        "refused": "error" in response,
        "said_nothing_was_pressed": "error" in response and "nothing was pressed" in response["error"]["message"],
        "nothing_happened": before == after,
    }
    return Outcome("coordinate-mismatch", all(checks.values()),
                   response.get("error", {}).get("message", "no error")[:120], checks)


def case_electron_target(helper: Helper) -> Outcome:
    """The class of application this is actually for.

    Every other case drives Calculator, which is native, well behaved, and the
    friendliest target on the machine. It proves the mechanism and nothing
    about the real world. Most desktop software worth automating is Chromium,
    which exposes no tree at all until asked and is where the interesting
    failures live.

    Skips rather than fails when the target is not running: an absent
    application is not a defect in the code under test.
    """
    probe = helper.call("snapshot", bundleId=ELECTRON)
    if "error" in probe and probe["error"].get("code") == "MACOS_APP_NOT_RUNNING":
        return Outcome("electron-target", True, "skipped: the WeChat devtools are not running",
                       {"skipped": True})
    if "error" in probe:
        return Outcome("electron-target", False, probe["error"]["message"])
    result = probe["result"]
    elements = result["elements"]
    named = [e for e in elements if e.get("name")]
    checks = {
        # Zero would mean the tree never got built, which is the failure mode
        # the settle-wait exists to prevent.
        "tree_was_built": len(elements) > 0,
        "names_resolved": len(named) > 0,
        "geometry_present": any(e.get("rect") for e in elements),
    }
    return Outcome("electron-target", all(checks.values()),
                   f"{len(elements)} elements, {len(named)} named, window {result.get('title','')!r}",
                   checks)


def case_window_geometry(helper: Helper) -> Outcome:
    """Moving a window is the one drag that needs no pointer. Restore it after."""
    start = helper.call("window", bundleId=CALCULATOR)
    if "error" in start:
        return Outcome("window-geometry", False, start["error"]["message"])
    origin = start["result"]
    moved = helper.call("window", bundleId=CALCULATOR, x=origin["x"] + 120, y=origin["y"] + 60)["result"]
    back = helper.call("window", bundleId=CALCULATOR, x=origin["x"], y=origin["y"])["result"]
    ok_moved, note_moved = undisturbed(moved)
    checks = {
        "moved": (moved["x"], moved["y"]) != (origin["x"], origin["y"]),
        "restored": (back["x"], back["y"]) == (origin["x"], origin["y"]),
        "never_disturbed": ok_moved,
    }
    return Outcome("window-geometry", all(checks.values()),
                   f"({origin['x']},{origin['y']}) -> ({moved['x']},{moved['y']}) -> "
                   f"({back['x']},{back['y']}); {note_moved}", checks)


def case_stale_index(helper: Helper) -> Outcome:
    """An index past the end of the list must be refused with guidance."""
    response = helper.call("press", bundleId=CALCULATOR, index=9999)
    checks = {
        "refused": "error" in response,
        "guided": "error" in response and "fresh snapshot" in response["error"]["message"],
    }
    return Outcome("stale-index", all(checks.values()),
                   response.get("error", {}).get("message", "no error")[:100], checks)


def case_missing_app(helper: Helper) -> Outcome:
    """A target that is not running must say so rather than fail obscurely."""
    response = helper.call("snapshot", bundleId="com.example.not.installed")
    checks = {
        "refused": "error" in response,
        "correct_code": response.get("error", {}).get("code") == "MACOS_APP_NOT_RUNNING",
    }
    return Outcome("missing-app", all(checks.values()),
                   response.get("error", {}).get("message", "no error")[:100], checks)


CASES = [
    Case("enumerate", "a background window is readable, named, and carries geometry", case_enumerate),
    Case("press-by-index", "pressing controls changes the application, undisturbed", case_press_by_index),
    Case("identity-guard", "a stale target is refused before acting", case_identity_guard),
    Case("coordinate-hit-test", "a coordinate resolves to a named element", case_coordinate_hit_test),
    Case("coordinate-mismatch", "a wrong aim is caught before the press", case_coordinate_mismatch),
    Case("electron-target", "a Chromium application exposes a built tree", case_electron_target),
    Case("window-geometry", "a window moves and restores without a pointer", case_window_geometry),
    Case("stale-index", "an out-of-range index is refused with guidance", case_stale_index),
    Case("missing-app", "an absent application is named, not swallowed", case_missing_app),
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--case", action="append", help="run only these cases")
    parser.add_argument("--list", action="store_true")
    args = parser.parse_args()

    if args.list:
        for case in CASES:
            print(f"  {case.name:22} {case.intent}")
        return 0

    if not HELPER.exists():
        print(f"helper not built: {HELPER}\n  pnpm run build:helper")
        return 2

    selected = [c for c in CASES if not args.case or c.name in args.case]
    launch_background(CALCULATOR)
    helper = Helper(HELPER)
    outcomes: list[Outcome] = []
    try:
        for case in selected:
            try:
                outcome = case.run(helper)
            except Exception as error:  # a crashing case is a failing case
                outcome = Outcome(case.name, False, f"raised {type(error).__name__}: {error}")
            outcomes.append(outcome)
            mark = "PASS" if outcome.passed else "FAIL"
            print(f"{mark}  {outcome.name:22} {outcome.detail}")
            if not outcome.passed and outcome.checks:
                for key, value in outcome.checks.items():
                    if not value:
                        print(f"        failed check: {key}")
    finally:
        helper.close()
        quit_app(CALCULATOR)

    passed = sum(1 for o in outcomes if o.passed)
    print(f"\n{passed}/{len(outcomes)} passed")

    RESULTS.mkdir(exist_ok=True)
    (RESULTS / "summary.json").write_text(json.dumps(
        {"passed": passed, "total": len(outcomes),
         "cases": [{"name": o.name, "passed": o.passed, "detail": o.detail, "checks": o.checks}
                   for o in outcomes]},
        indent=2, ensure_ascii=False))
    return 0 if passed == len(outcomes) else 1


if __name__ == "__main__":
    sys.exit(main())
