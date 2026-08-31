#!/bin/bash
# What did we leave running?
#
# Computer use starts processes that have no window: helpers, cursor overlays,
# and applications launched in the background to be driven. Any of them can
# outlive the session that wanted it, and none of them is visible on screen —
# a Mac mini ran a hung Electron process at 99% CPU for a day and a half before
# the heat gave it away.
#
# This lists what is running, flags what looks stuck, and only ever reports.
# Killing is left to a person: some of these are the user's own applications
# doing legitimate work.
#
#   experiments/leak-check/check.sh          # report
#   experiments/leak-check/check.sh --ours   # only processes this project starts

set -uo pipefail
ours_only=false
[[ "${1:-}" == "--ours" ]] && ours_only=true

echo "load: $(uptime | sed 's/.*averages: //')"
echo

# Processes this project starts. These should never be running with no session
# attached; the helper watches for being orphaned and exits on its own.
#
# Matched by path and flag rather than by name: other computer-use tools ship
# binaries with similar names, and reporting one of those as our leak sends the
# reader after the wrong process. Shells and node processes are skipped too:
# a command line that merely mentions the helper is not the helper, and the
# script would otherwise report whatever shell invoked it.
echo "── ours ──"
found=0
while read -r pid cpu etime cmd; do
  [[ -z "${pid:-}" ]] && continue
  found=1
  ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  note=""
  [[ "$ppid" == "1" ]] && note="  ORPHANED (parent gone; should have exited on its own)"
  printf "  pid=%-7s cpu=%-6s up=%-12s %s%s\n" "$pid" "$cpu" "$etime" "${cmd:0:60}" "$note"
done < <(ps -axo pid=,pcpu=,etime=,command= \
  | grep -E "/dsh-computer-macos-helper|/dsh-computer-use-helper( |$)|--cursor-overlay|DSHComputerUseFixture\\.app" \
  | grep -v grep \
  | grep -vE "^\\s*[0-9]+\\s+[0-9.]+\\s+\\S+\\s+(/bin/(ba)?sh|/bin/zsh|node )" )
[[ $found -eq 0 ]] && echo "  none"

$ours_only && exit 0

# Applications we may have launched to drive. We cannot tell those apart from
# ones the user opened, so this only flags the shape of a hung one: burning a
# core while answering nothing.
echo
echo "── applications burning CPU with no window ──"
found=0
while read -r pid cpu etime cmd; do
  [[ -z "${pid:-}" ]] && continue
  # Below a core's worth of work is normal for an active application.
  awk -v c="$cpu" 'BEGIN { exit !(c > 80) }' || continue
  windows=$(osascript -e "tell application \"System Events\" to count windows of (first process whose unix id is $pid)" 2>/dev/null || echo "?")
  [[ "$windows" == "0" || "$windows" == "?" ]] || continue
  found=1
  printf "  pid=%-7s cpu=%-6s up=%-12s windows=%-3s %s\n" "$pid" "$cpu" "$etime" "$windows" "${cmd:0:50}"
done < <(ps -axo pid=,pcpu=,etime=,command= | grep -iE "Electron|Chromium" | grep -v grep)
if [[ $found -eq 0 ]]; then
  echo "  none"
else
  echo
  echo "  A process answering '?' for its window count is not responding to the"
  echo "  accessibility API at all, which is what a hung main thread looks like."
  echo "  Check it before killing: 'sample <pid> 3' shows where the time goes."
fi
