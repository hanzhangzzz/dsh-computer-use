# dsh-computer-use

Computer use for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): one
installable plugin that lets the model drive a browser and Chromium-based desktop apps through
CDP. The native macOS Accessibility provider is an experimental source package and is not part
of the published plugin bundle.

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

**Published browser provider** — launches a local Chrome, or attaches over CDP to an already-running
Chromium application. CDP attach was verified against WeChat DevTools; other Electron/Chromium
applications must expose a compatible remote-debugging endpoint and have not been verified here.

```
computer_navigate   computer_snapshot   computer_click(index | x,y)
computer_type       computer_press_key  computer_screenshot
computer_surfaces   computer_focus
```

**Native macOS desktop (experimental, source only)** — `packages/computer-macos` drives native and
Electron applications through the Accessibility API. It is built and tested from this repository,
but it is not wired into `dsh-tool-computer` and is absent from the npm tarball. Installing the
published plugin therefore does not provide native macOS Accessibility control.

Two guards protect different surfaces. In the experimental native provider, an action carries
the identity its caller expected and is refused when the live element no longer
matches, because a wrong press on a desktop cannot be undone. For the published CDP provider, an
attached application that disconnects is a terminal state: every later call answers "report this
and wait, do not restart the host yourself".

## Known limits

- **Native macOS has no freeform drag.** The experimental provider's accessibility vocabulary has
  no drag action, and no public API can synthesise a mouse event that a background window will
  accept. Window moves, scrolling, steppers and context menus have non-drag equivalents; dragging
  one thing onto another does not.
- **Native macOS coverage varies by application.** This limitation applies to the experimental
  source provider, not to the published bundle. Of 18 running applications with a window on the
  test machine, 11 expose 20 or more actionable elements. Self-drawn UIs that reject
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

Published as `dsh-tool-computer` (npm). As checked on 2026-09-20, npm `latest` is `0.4.0` while
the newest GitHub Release is `v0.3.2`; the release page therefore does not describe every change
in the npm package. Repository: hanzhangzzz/dsh-computer-use.
