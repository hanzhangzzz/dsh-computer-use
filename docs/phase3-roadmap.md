# Phase 3 roadmap — data-driven, not aspiration-driven

Every open item below carries: the current measured evidence, the signal that
justifies building it, and the estimated cost. Nothing here is scheduled —
items activate when their trigger fires, not before. This is the table the
harvester inherits alongside the 15-commit branch.

| # | Item | Current evidence | Activation signal | Cost |
|---|---|---|---|---|
| 1 | npm publish + GitHub remote | Three packages pack-verified, names free; `dsh-computer-use` name itself taken by an unrelated third party | Human picks npm account + repo home (huajuan404 vs hanzhangzzz), adds `repository` fields | Minutes (human-gated) |
| 2 | `navigate` fast-settle (waitUntil `domcontentloaded`, soft timeout) | **Shipped 2026-08-25.** Timeline analysis of the 223s hn task: four x.com attempts each burned exactly the 30s navigation timeout (goto waited for `load` while the site stalled post-document); `navigate` now settles on `domcontentloaded` — regressed on unit, build, and a live task | — |
| 3 | `computer_scroll` + viewport-aware screenshots | screenshot captures the viewport only; snapshot enumerates the full DOM and click auto-scrolls, so the core loop does not need it | A real task needs to *read* below-the-fold content (visual verification of lower regions) | Small–medium: `mouse.wheel`/`evaluate(scrollTo)` + settle; screenshot stays viewport-shaped |
| 4 | Coordinate fallback (`x,y` click) | E7: vision grounding 61.8%/60px median — usable only wrapped in verify-retry; structure path 15/15 across suites | First real task where the element index path fails on an element the model can see in the screenshot | Medium: schema dual-stance + verify loop; risk of mis-clicks without strict retry budget |
| 5 | Element-level diff snapshot | Click embeds a full post-action list; Wikipedia is 330 elements (~2.4k tok) after the −52% noise cut; unchanged pages already collapse | Multi-step tasks on partially-mutating heavy pages show token accumulation as the binding cost | Medium-high: diff semantics risk index misalignment — the single-handle-array invariant would need a careful extension |
| 6 | Large-list pagination/capping | 330 elements ≈ 2.4k tok single-shot, fine at 128k | A page's element list alone (post-noise-cut) exceeds ~10k tokens | Medium: offset/window parameter + model guidance |
| 7 | Approval seam (`on-sensitive`) | v1 is `approval: never` with the seam point reserved; no sensitive-page tasks in any suite | First deployment scenario touching payment/submit flows, or a user asks for human-in-the-loop | Medium: interaction-seam wiring + sensitive-page heuristics (Codex browser_use.rs is prior art) |
| 9 | Single published package (merge three packages at build time) | User feedback on install day (2026-08-25): one `plugin add` surfaces three unfamiliar entries in the plugin list, raising "are these all mine?"; dsh-diagram ships one entry | Fired by this user report — schedule when convenient | Medium: tsdown multi-entry into one tarball, keep three source dirs |
| 8 | E2B Desktop second provider | E5: E2B packages lack `@e2b/desktop`; local Chrome path validated end to end | Hosted/isolated-desktop deployment demand (no local Chrome), post-publish | High: new dependency + sandbox desktop bring-up + full provider test pass |

## Ordering principle

Measured pain first, everywhere: items 2–6 each cite the number that would
justify them, and none of those numbers is currently binding. The structure
path has not failed once in 15 scored tasks plus ad-hoc model runs; do not
build fallbacks for failures that have not happened.

## What would falsify this roadmap

- A scored task suite where index-addressing misfires on dynamic pages (SPAs
  re-rendering between snapshot and click) would promote item 4 immediately.
- Sustained multi-step sessions hitting compaction thresholds would promote
  items 5–6.
- A community user asking to install on a headless server promotes item 8
  ahead of items 2–6.
