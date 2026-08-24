# dsh-computer-use

Computer use capability for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), packaged as an installable plugin (same distribution model as dsh-diagram: standalone npm package + `cordis.patch.yml` patch-layer bundle).

## Status: Phase 0 — grounding feasibility

The whole design gates on one unverified number: how accurately `deepseek-v4-flash-vision-exp` localizes GUI elements at its ~640k-pixel image budget. No public evidence exists (no OSWorld entry, nothing in the official docs), so we measure it ourselves on ScreenSpot-v2 before committing to an architecture.

```sh
cd experiments/screenspot-grounding
DEEPSEEK_API_KEY=sk-... uv run bench.py --n 200 --mode both
```

Modes: `single` (one-shot full-screenshot grounding) and `twostep` (coarse point, then refine on a full-resolution crop — measures whether a region-zoom tool rescues accuracy). Results land in `experiments/screenspot-grounding/results/` as per-sample JSONL plus a summary JSON.

## Planned phases

- **Phase 1** — mount Playwright-MCP through dsh's existing `mcp-client` to validate the screenshot→model→action loop end to end (config only, no new code).
- **Phase 2** — the plugin proper: a `computer` capability seam (Service Definition + provider + tool Consumer) with screenshot/click/type/scroll/key actions, E2B Desktop as the first provider, approval wired into dsh's interaction seam.
- **Phase 3** — structure-first second provider (accessibility/DOM element index, pixel fallback), demos, OSWorld sampling.

Design inputs and the full investigation (Codex architecture analysis, ecosystem survey, dsh readiness audit) live in the project discussion; conclusions get distilled into this README as they solidify.
