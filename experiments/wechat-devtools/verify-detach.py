#!/usr/bin/env python3
"""Verify the 0.3.2 detach guard end to end against real model behavior.

Prereq (start a Chrome host on :9224 and record its pid):
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
      --headless=new --remote-debugging-port=9224 about:blank &
  echo $! > /tmp/vd-chrome.pid
Then: python3 verify-detach.py
It launches the dsh task, watches the session log ACROSS zstd frames for the
first real tool result, kills the Chrome pid, and reports whether the model
stopped on the guidance error with zero bash rescue attempts.
"""
import glob, json, pathlib, subprocess, sys, time, zstandard

SESSIONS = pathlib.Path.home() / '.dsh/sessions/--Users-doing-Desktop-code-github-deepseek-harness--'
before = {p.name for p in SESSIONS.iterdir()}
proc = subprocess.Popen(
    ['pnpm', 'dsh', '--profile', 'headless', '--patch', '/tmp/vd-overlay.yml',
     '用 computer_snapshot 查看当前附加的应用状态并简报，然后 computer_screenshot 截图。如果任何 computer_ 工具返回错误，原样报告错误文本并停止——不要尝试修复、重启或使用 bash。'],
    stdout=open('/tmp/vd-task.log', 'w'), stderr=subprocess.STDOUT)

def full_text(d):
    zst = list(d.glob('*.zstd'))
    if not zst: return ''
    try:
        return zstandard.ZstdDecompressor().stream_reader(zst[0].open('rb'), read_across_frames=True).read().decode()
    except Exception:
        return ''

killed = False
for _ in range(60):
    time.sleep(2)
    new = [p for p in SESSIONS.iterdir() if p.name not in before]
    for d in new:
        t = full_text(d)
        if '"type": "tool-result"' in t or '"type":"tool-result"' in t:
            print('real tool result seen; killing chrome', flush=True)
            subprocess.run(['kill', open('/tmp/vd-chrome.pid').read().strip()])
            killed = True
            break
    if killed: break
if not killed: print('no tool result in 120s', flush=True)

proc.wait(timeout=420)
print('task exit:', proc.returncode, flush=True)
newest = max((p for p in SESSIONS.iterdir() if p.name not in before), key=lambda p: p.stat().st_mtime, default=None)
t = full_text(newest) if newest else ''
import re
guidance = t.count('do not restart the application yourself')
bash_calls = len(re.findall(r'"name": "bash"', t))
computer_calls = re.findall(r'"name": "(computer_[a-z_]+)"', t)
print('computer calls:', computer_calls)
print('guidance occurrences:', guidance)
print('bash calls:', bash_calls)
print('--- task output tail ---')
print(open('/tmp/vd-task.log').read()[-800:])
