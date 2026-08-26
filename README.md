# dsh-computer-use

Computer use for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): one
installable plugin that lets the model drive a browser and, on macOS, desktop applications.

Structure-first by design. The model reads a list of interactive elements and addresses them by
index; screenshots are for verification, not for aiming. That is a measured choice rather than a
stylistic one — this model's single-shot visual grounding is 61.8% on ScreenSpot-v2, far too low
to be a primary targeting path. Every number and how to reproduce it: [docs/EVIDENCE.md](docs/EVIDENCE.md).

## Install

```sh
npx -y @deepseek-ai/dsh@latest plugin --profile web add dsh-tool-computer
```

One command installs the seam, the browser provider, and the `computer_*` tools. Start with
`npx -y @deepseek-ai/dsh@latest web`. The agent model must declare image input for
`computer_screenshot` to reach it; `deepseek-v4-flash-vision-exp` does.

## What it does

**Browser** — launches a local Chrome, or attaches over CDP to an already-running Chromium
application (any Electron app started with `--remote-debugging-port`).

```
computer_navigate   computer_snapshot   computer_click(index | x,y)
computer_type       computer_press_key  computer_screenshot
computer_surfaces   computer_focus
```

**macOS desktop** (`packages/computer-macos`, not yet wired into the published bundle) — drives
native and Electron applications through the Accessibility API: reads a window's controls, text
content, geometry and available actions; presses by index or by hit-tested coordinate; moves
windows. Every action works on a background window without taking focus or moving the cursor.

Two guards, both from incidents rather than theory. An action carries the identity its caller
expected and is refused when the live element no longer matches, because a wrong press on a
desktop cannot be undone. An attached application that disconnects is a terminal state: every
later call answers "report this and wait, do not restart the host yourself".

## Known limits

- **No freeform drag.** The accessibility vocabulary has no drag action, and no public API can
  synthesise a mouse event that a background window will accept. Window moves, scrolling,
  steppers and context menus have non-drag equivalents; dragging one thing onto another does not.
- **Coverage varies by application.** Of 18 running applications with a window on the test
  machine, 11 expose 20 or more actionable elements. Self-drawn UIs that reject
  `AXManualAccessibility` — WeChat, the Codex app — stay out of reach.
- Browser enumeration does not pierce shadow DOM and does not enter iframes.
- No scroll tool on the browser side yet.

## Development

Requires a sibling checkout of `deepseek-harness`: root `devDependencies` use `link:` paths into
it, so clone both under one parent or `pnpm install` fails on the links.

```sh
pnpm run build:helper                            # Swift helper, needs Command Line Tools
pnpm run typecheck && pnpm run test && pnpm run build
python3 experiments/desktop-acceptance/run.py    # desktop capability acceptance
```

## Documentation

| | |
|---|---|
| [docs/HANDOFF.md](docs/HANDOFF.md) | What to build next, the invariants, and how work is accepted |
| [docs/EVIDENCE.md](docs/EVIDENCE.md) | Every measured conclusion, with how to reproduce it |
| `AGENTS.md` | Repository layout and the invariants that are not visible in the code |
| `DO.md` | Working log and incident post-mortems |

Published as `dsh-tool-computer` (npm). Repository: hanzhangzzz/dsh-computer-use.
