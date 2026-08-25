# dsh-computer-use

Computer use capability for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), packaged as an installable plugin (same distribution model as dsh-diagram: standalone npm package + `cordis.patch.yml` patch-layer bundle).

## Development prerequisites (read before cloning)

This repo develops against a local checkout of the harness: root `devDependencies` use `link:../deepseek-harness/...` for `@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, and the `dsh-tools`/`dsh-llm`/`dsh-attachment`/`dsh-system-prompt` packages. Clone the two repos side by side (any parent directory) or `pnpm install` will fail on the links. The tracer/acceptance overlays under `experiments/` pin absolute plugin paths for this machine — after a publish they are replaced by the package-name patch in `packages/tool-computer/cordis.patch.yml`, which is the portable form.

## Status: Phase 1 complete — loop validated

The whole design gates on one unverified number: how accurately `deepseek-v4-flash-vision-exp` localizes GUI elements at its ~640k-pixel image budget. No public evidence exists (no OSWorld entry, nothing in the official docs), so we measured it ourselves on ScreenSpot-v2 (200 samples, 2026-08-24, results in `experiments/screenspot-grounding/results/`):

| mode | accuracy | median error | parse/API failures |
|---|---|---|---|
| single-shot | **61.8%** (118/191) | 60 px | 9/200 |
| two-step region refine | 53.5% (93/174) | 80 px | 26/200 |

Read: far above non-grounding generalist models (o3-class coordinate output sits near 23% on comparable tasks), well below specialized grounders (UI-TARS class, 85%+). Two-step refine is a net loss as naively implemented — the crop rescued 27 misses but broke 42 hits, mostly by losing global context. Consequence for the design: vision-only grounding cannot be the primary click path; the plugin leads with structure-first targeting (accessibility tree / DOM element index) and uses vision coordinates as the fallback, which the measured 62% supports well when wrapped in a screenshot-verify-retry loop.

```sh
cd experiments/screenspot-grounding
DEEPSEEK_API_KEY=sk-... uv run bench.py --n 200 --mode both
```

Modes: `single` (one-shot full-screenshot grounding) and `twostep` (coarse point, then refine on a full-resolution crop — measures whether a region-zoom tool rescues accuracy). Results land in `experiments/screenspot-grounding/results/` as per-sample JSONL plus a summary JSON.

## Phase 1 complete — screenshot→model→action loop works, config only

Mounted Playwright-MCP (0.0.79, system Chrome headless) through dsh's `mcp-client` and drove a real browser task to completion: navigate → screenshot → describe visual details → click a link → screenshot again → describe the new layout. Proof of the image path (2026-08-24, `experiments/phase1-playwright/`):

- The session log records durable `image` content blocks (sha256 attachment refs, 1280x800 PNG) for every screenshot — the model actually saw them, and its answers contained purely visual facts (green IANA logo, gray pill button, footer link columns) that the accessibility tree cannot express.
- Structure-first works as designed: `browser_snapshot`-driven clicks need no vision at all; screenshots enter only for visual verification and description.

```sh
# from the deepseek-harness repo root (needs DEEPSEEK_API_KEY in its .env)
pnpm dsh --profile headless --patch <this-repo>/experiments/phase1-playwright/cordis.patch.yml "<task>"
```

Two findings that cost debugging time, both now fixed by configuration:

1. **Playwright-MCP returns an image block only when `browser_take_screenshot` is called without `filename`**; passing a filename saves the PNG to disk and returns a text link, which silently bypasses the whole image path. Models pass `filename` readily — prompt for empty-args calls, or make Phase 2's tool Consumer not expose the parameter at all.
2. **`~/.dsh/settings.yaml` overrides the adapter's model catalog** and the vision model entry there lacked `inputModalities`, so dsh's MCP image admission correctly rejected screenshots (`[image unavailable: … does not declare image input]`) despite the source default declaring them. Any host reusing this overlay needs `inputModalities: [text, image]` on the model entry.

## Phase 2 in progress — the plugin exists and closes the loop

The design review (docs/phase2-design-review.md) overturned the original provider order: Playwright/CDP local Chrome is the first provider (fast feedback loop, interface defined on mature semantics), E2B Desktop deferred. The tracer bullet is real and green (2026-08-24):

- Three packages: `dsh-computer` (Service Definition, mirrors dsh-web selection semantics), `dsh-computer-playwright` (lazy headless Chrome over playwright-core, structure-first snapshot indices), `dsh-tool-computer` (`computer_navigate/snapshot/click/screenshot`; the no-code-analysis-of-screenshots rule is baked into tool descriptions).
- `pnpm run typecheck` aligns against the main repo's real types via `link:` devDependencies; `pnpm run test` drives real Chrome through the seam (navigate → snapshot → click by index → screenshot, 5.5s).
- Full model loop proven with the plugin loaded by absolute path (`experiments/phase2-tracer/cordis.patch.yml`): the session log shows `computer_navigate → computer_snapshot → computer_click{index:0} → computer_screenshot` and a durable image block; the model's answer contains purely visual facts (teal IANA logo) unreachable from the accessibility tree.

Remaining before this phase closes: packaging (npm publish + relative-path patch). Prior-knowledge shortcut behavior was not observed in the clean acceptance run (the earlier "model fabricated answers" reading was a scorer bug, not model behavior); treat it as a live risk only if it shows up again.

## Acceptance: 10-task suite (E8) — 10/10, 2026-08-24

`experiments/phase2-acceptance/` runs ten real-browser tasks through the assembled plugin and scores mechanical criteria from the session log (tool calls, click URLs, image blocks) plus output text. Clean-run results (summary in `results/summary.json`):

- 10/10 tasks completed the intended action; every real click/snapshot/navigate in every run was correct, including multi-hop (example.com → IANA → footer About) and a hostile-403 landing reported honestly.
- Re-run in full on the final 11-commit state (2026-08-25, after `computer_type`/`computer_press_key`/race-retry landed): 10/10 again, and zero "Execution context was destroyed" occurrences across all ten session logs.
- Long-chain stress suite (5 tasks with 2+ clicks or form input, `longchain-tasks.json`): 5/5 pass. Fastest 21s (two-hop IANA), slowest 223s (HN two-story: hostile external sites cost six navigate retries that the model absorbed by switching strategy — environment resilience, not a plugin defect; zero race errors).
- Median elapsed ~16s per task (headless Chrome + vision model).
- Structure-first held throughout: no task needed coordinates; every click came from a snapshot index.

Two driver bugs produced a false "model fabricated answers without calling tools" reading before the clean run — the scorer missed tool calls because (a) `json.dumps` renders `"type": "tool-call"` with a space the matcher lacked, and (b) session logs are multi-frame zstd and one-shot decompress stops at frame one. Both fixed in `run.py`; lesson recorded: **log-derived verdicts need the same adversarial checking as model claims**.

## Snapshot token cost (measured from acceptance logs, 2026-08-24)

The flat element-list projection costs, per `computer_snapshot` call:

| page | elements | bytes | ~tokens |
|---|---|---|---|
| example.com | 1 | 59 B | 14 |
| iana.org help page | 31 | 0.8 KB | 205 |
| news.ycombinator.com | 227 | 6 KB | 1.5k |
| go.dev/doc | 241 | 7.6 KB | 1.9k |
| en.wikipedia.org Main Page | 833 | 22 KB | 5.2k |

Single calls are fine at a 128k window, but repeat snapshots of an unchanged heavy page repeat the full cost (observed: 3× 5.2k on one Wikipedia task) and break KV reuse. A measured noise source is also gone: interlanguage switcher links were 51% of the Wikipedia Main Page element list (349/688); enumeration now skips `aria-hidden` regions and `a[lang]` links differing from the document language, cutting that snapshot to 330 elements (−52%) while click/type/snapshot share one filtered handle array — index alignment stays exact (two-click Wikipedia walk re-verified). Two further mitigations shipped (Phase 3):

1. **Unchanged-page collapse**: the provider fingerprints each full snapshot (URL + element role/name list); a repeat snapshot of an identical page returns `unchanged since snapshot #N` with empty elements and a guarantee that prior indices remain valid — verified at the model level.
2. **Post-click snapshot**: `computer_click` embeds the post-click element list (after `domcontentloaded` + settle), so the click loop needs no separate snapshot round trip — the model chains clicks straight off the returned list. Verified on the two-hop acceptance task: both clicks returned their full post-click lists and the second click targeted an element from the first's embedded list.

Still open: element-level diffs for partially changed pages, and capping/paginating very large lists.

## Action surface

`computer_navigate`, `computer_snapshot`, `computer_click`, `computer_type` (index-addressed fill with the post-input snapshot embedded), `computer_press_key` (added 2026-08-25; Enter-submit verified on a live Wikipedia search — four tool calls straight to the article), `computer_screenshot`. Snapshot enumeration now retries once on the navigation race that used to surface "Execution context was destroyed" as a tool error. Scroll and coordinate fallback remain open.

## Packaging (local, publish-ready)

Three packages, all names free on npm as of 2026-08-24: `dsh-computer`, `dsh-computer-playwright`, `dsh-tool-computer`. The latter carries the bundle manifest (`dsh.bundle.patch` → `cordis.patch.yml`, package-name entries) and is what users install; `pnpm -r pack --dry-run` shows each tarball carrying `lib/` + LICENSE + README (+ patch). Note: the npm name `dsh-computer-use` itself is taken by an unrelated third-party plugin (jerryweizhihao, screen-coordinate-style computer use) — independent signal that this niche is active.

Human steps left before publish: pick the npm account and GitHub remote (huajuan404 vs hanzhangzzz), add `repository` fields, `pnpm -r publish`, then users install with `dsh plugin --profile <name> add dsh-tool-computer`.

## Planned phases

- **Phase 2** — the plugin proper: a `computer` capability seam (Service Definition + provider + tool Consumer) with screenshot/click/type/scroll/key actions, E2B Desktop as the first provider, approval wired into dsh's interaction seam.
- **Phase 3** — structure-first second provider (accessibility/DOM element index, pixel fallback), demos, OSWorld sampling.

Design inputs and the full investigation (Codex architecture analysis, ecosystem survey, dsh readiness audit) live in the project discussion; conclusions get distilled into this README as they solidify.
