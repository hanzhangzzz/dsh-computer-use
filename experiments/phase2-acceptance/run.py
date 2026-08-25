#!/usr/bin/env python3
"""Phase 2 acceptance driver: run each task through `dsh --profile headless`
with the tracer overlay, capture stdout and the session log evidence, and
score mechanical pass criteria. Serial execution (one Chrome at a time).

Usage (from the deepseek-harness repo root):
  python3 ../dsh-computer-use/experiments/phase2-acceptance/run.py

Writes per-task JSON + a summary to results/ next to this script.
"""
import json
import pathlib
import subprocess
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
RESULTS = HERE / 'results'
OVERLAY = HERE.parent / 'phase2-tracer' / 'cordis.patch.yml'
DSH_ROOT = pathlib.Path('/Users/doing/Desktop/code/github/deepseek-harness')
SESSIONS = pathlib.Path.home() / '.dsh/sessions/--Users-doing-Desktop-code-github-deepseek-harness--'


def newest_session_dir() -> pathlib.Path:
    # Directory mtime does not update when nested files are written; rank by
    # the newest file inside each session dir instead.
    dirs = [p for p in SESSIONS.iterdir() if p.is_dir()]
    return max(dirs, key=lambda p: max(f.stat().st_mtime for f in p.glob('*')))


def session_events(path: pathlib.Path) -> list:
    import zstandard
    zst = next(path.glob('*.zstd'))
    # Session logs are appended as multiple zstd frames; stream across them.
    reader = zstandard.ZstdDecompressor().stream_reader(zst.open('rb'), read_across_frames=True)
    text = reader.read().decode()
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def run_task(task: dict) -> dict:
    start = time.time()
    proc = subprocess.run(
        ['pnpm', 'dsh', '--profile', 'headless', '--patch', str(OVERLAY), task['prompt']],
        cwd=DSH_ROOT, capture_output=True, text=True, timeout=420,
    )
    elapsed = round(time.time() - start, 1)
    events = session_events(newest_session_dir())

    tool_calls: list[str] = []
    image_blocks = 0
    click_urls: list[str] = []
    for e in events:
        message = e.get('data', {}).get('message', {})
        content = message.get('content', [])
        if not isinstance(content, list):
            continue
        for blk in content:
            if not isinstance(blk, dict):
                continue
            if blk.get('type') == 'tool-call' and str(blk.get('name', '')).startswith('computer_'):
                tool_calls.append(blk['name'])
                if blk['name'] == 'computer_click':
                    click_urls.append(str(blk.get('arguments', '')))
            # Image blocks live inside tool-result content arrays.
            for inner in blk.get('content', []) if isinstance(blk.get('content'), list) else []:
                if isinstance(inner, dict) and inner.get('type') == 'image':
                    image_blocks += 1

    output = proc.stdout
    criteria = task.get('pass', {})
    checks = {}
    if 'url_contains' in criteria:
        hit = any(criteria['url_contains'] in u or criteria['url_contains'] in output for u in click_urls) \
            or criteria['url_contains'] in output
        checks['url_contains'] = hit
    if 'min_clicks' in criteria:
        checks['min_clicks'] = len(click_urls) >= criteria['min_clicks']
    if 'tool' in criteria:
        checks['tool'] = criteria['tool'] in tool_calls
    if 'text_any' in criteria:
        lowered = output.lower()
        checks['text_any'] = any(t.lower() in lowered for t in criteria['text_any'])
    if 'image_block' in criteria:
        checks['image_block'] = image_blocks >= 1
    if 'error_handled' in criteria:
        checks['error_handled'] = 'err' in output.lower() or '失败' in output or '无法' in output or '不存在' in output

    passed = all(checks.values()) if checks else False
    return {
        'id': task['id'], 'passed': passed, 'checks': checks, 'elapsed_s': elapsed,
        'tool_calls': tool_calls, 'image_blocks': image_blocks,
        'exit': proc.returncode, 'output_tail': output[-600:],
    }


def main() -> None:
    args = sys.argv[1:]
    tasks_file = HERE / 'tasks.json'
    if args and args[0].endswith('.json'):
        tasks_file = pathlib.Path(args[0]).resolve()
        args = args[1:]
    tasks = json.loads(tasks_file.read_text())['tasks']
    only = args or None
    RESULTS.mkdir(exist_ok=True)
    results = []
    for task in tasks:
        if only and task['id'] not in only:
            continue
        print(f'== {task["id"]}', flush=True)
        try:
            result = run_task(task)
        except Exception as exc:  # noqa: BLE001 - record the failure mode
            result = {'id': task['id'], 'passed': False, 'error': str(exc)}
        results.append(result)
        (RESULTS / f'{task["id"]}.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
        print(f'   passed={result.get("passed")} checks={result.get("checks")}', flush=True)
    summary = {
        'total': len(results),
        'passed': sum(1 for r in results if r.get('passed')),
        'results': [{k: r[k] for k in ('id', 'passed', 'checks', 'elapsed_s')} for r in results],
    }
    (RESULTS / f'summary-{tasks_file.stem}.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print(json.dumps(summary['results'], ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
