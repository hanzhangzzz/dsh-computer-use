# dsh-computer-use

Computer use capability for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), packaged as an installable plugin (same distribution model as dsh-diagram: standalone npm package + `cordis.patch.yml` patch-layer bundle).

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

Remaining before this phase closes: Consumer-level composition test, the 10-task acceptance suite (E8), snapshot token-cost measurement, packaging (npm publish + relative-path patch).

## Planned phases

- **Phase 2** — the plugin proper: a `computer` capability seam (Service Definition + provider + tool Consumer) with screenshot/click/type/scroll/key actions, E2B Desktop as the first provider, approval wired into dsh's interaction seam.
- **Phase 3** — structure-first second provider (accessibility/DOM element index, pixel fallback), demos, OSWorld sampling.

Design inputs and the full investigation (Codex architecture analysis, ecosystem survey, dsh readiness audit) live in the project discussion; conclusions get distilled into this README as they solidify.
