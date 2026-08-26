/**
 * How much does the structure path miss?
 *
 * The plugin's ceiling hinges on one unmeasured number: of everything a user
 * could click on a page, what fraction does `interactiveHandles` enumerate?
 * Whatever it misses has to fall back to visual grounding, which this repo
 * measured at 61.8% (ScreenSpot-v2, Phase 0). So this ratio decides whether
 * that 61.8% is a footnote or the binding constraint.
 *
 * Baseline mirrors the provider exactly (INTERACTIVE_SELECTOR plus the
 * aria-hidden and interlanguage-anchor filters). The candidate set adds
 * computed `cursor: pointer`, the CSS signal a developer gives a human to mean
 * "this is clickable" — the hypothesis behind roadmap #4 layer 1.
 *
 * Run from the repo root (playwright-core must resolve):
 *     node experiments/enumeration-coverage/measure.mjs
 */

import { chromium } from 'playwright-core'
import { writeFileSync, mkdirSync } from 'node:fs'

const PAGES = [
  ['wikipedia', 'https://en.wikipedia.org/wiki/Main_Page'],
  ['hn', 'https://news.ycombinator.com'],
  ['github', 'https://github.com/openai/codex'],
  ['react-docs', 'https://react.dev'],
  ['mdn', 'https://developer.mozilla.org/en-US/'],
  ['example', 'https://example.com'],
]

/** Exactly the provider's selector, kept in sync by hand. */
const INTERACTIVE_SELECTOR = 'a, button, input, select, textarea, [role], [onclick], [contenteditable="true"]'

/**
 * Runs in the page. Returns the baseline count plus the pointer-cursor
 * elements the baseline misses, each classified by objective proxies for
 * "a user could meaningfully click this".
 */
function analyze(selector) {
  const docLang = document.documentElement.lang || ''

  const passesProviderFilters = (el) => {
    if (el.closest('[aria-hidden="true"]') !== null) return false
    const elLang = el.getAttribute('lang')
    if (el instanceof HTMLAnchorElement && elLang !== null && elLang !== '' && elLang !== docLang) return false
    return true
  }

  const baseline = Array.from(document.querySelectorAll(selector)).filter(passesProviderFilters)
  const baselineSet = new Set(baseline)

  // Everything the user could plausibly click, by the CSS signal developers
  // actually use to say so.
  //
  // `cursor` inherits, so every svg/path/span inside a clickable control also
  // computes to `pointer`. Those are internals of one target, not targets. An
  // earlier version of this script counted them and reported a bogus 19.8%
  // "coverage hole"; inspecting the instances showed they were SVG innards of
  // buttons that were already enumerated. Only treat pointer-ness as a signal
  // where the element introduces it — i.e. the parent does not already have it.
  const pointer = Array.from(document.querySelectorAll('*')).filter((el) => {
    if (baselineSet.has(el)) return false
    if (!passesProviderFilters(el)) return false
    if (getComputedStyle(el).cursor !== 'pointer') return false
    const parent = el.parentElement
    return parent === null || getComputedStyle(parent).cursor !== 'pointer'
  })

  const viewportArea = innerWidth * innerHeight
  const isVisible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 8 || r.height < 8) return false
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05
  }
  const inViewport = (el) => {
    const r = el.getBoundingClientRect()
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth
  }
  // Objective clickability proxy: the element (or a descendant) is what the
  // browser would actually hit at its own centre.
  const isTopmostAtCentre = (el) => {
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2, y = r.top + r.height / 2
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return null // untestable off-screen
    const hit = document.elementFromPoint(x, y)
    return hit !== null && (hit === el || el.contains(hit))
  }
  const hasText = (el) => ((el.textContent ?? '').trim().length > 0)
    || el.getAttribute('aria-label') !== null || el.getAttribute('title') !== null

  // A pointer element whose pointer-ness is inherited from a pointer ancestor
  // that is itself a candidate is a duplicate, not a new target.
  const pointerSet = new Set(pointer)
  const isRedundantNesting = (el) => {
    let p = el.parentElement
    while (p !== null) {
      if (pointerSet.has(p) || baselineSet.has(p)) return true
      p = p.parentElement
    }
    return false
  }

  const classified = pointer.map((el) => ({
    visible: isVisible(el),
    inViewport: inViewport(el),
    topmost: isTopmostAtCentre(el),
    hasText: hasText(el),
    nested: isRedundantNesting(el),
    tag: el.tagName.toLowerCase(),
    sizeRatio: (el.getBoundingClientRect().width * el.getBoundingClientRect().height) / viewportArea,
  }))

  // The genuinely-new targets: visible, not a nesting duplicate, not a giant
  // wrapper, and actually the hit target at its own centre.
  const genuine = classified.filter(c =>
    c.visible && !c.nested && c.sizeRatio < 0.5 && c.topmost === true && c.hasText)

  // Why each candidate was rejected, first failing rule wins. Without this the
  // headline "0 new targets" cannot be told apart from "my filters are too
  // strict", which is the difference between a finding and a bug.
  const rejection = { invisible: 0, nested: 0, giant: 0, offscreen: 0, notTopmost: 0, noText: 0, kept: 0 }
  for (const c of classified) {
    if (!c.visible) rejection.invisible++
    else if (c.nested) rejection.nested++
    else if (c.sizeRatio >= 0.5) rejection.giant++
    else if (c.topmost === null) rejection.offscreen++
    else if (c.topmost === false) rejection.notTopmost++
    else if (!c.hasText) rejection.noText++
    else rejection.kept++
  }

  const baselineVisible = baseline.filter(el => isVisible(el) && inViewport(el))

  // "Nested" is not the same as "reachable". Clicking an enumerated ancestor
  // dispatches at that ancestor's centre, so a wrapper holding several distinct
  // clickable children collapses them into one ambiguous target: the model can
  // reach the wrapper but cannot choose which child. That is the real coverage
  // hole, and it is invisible in the headline "0 new targets".
  const nearestEnumeratedAncestor = (el) => {
    let p = el.parentElement
    while (p !== null) {
      if (baselineSet.has(p)) return p
      p = p.parentElement
    }
    return null
  }
  // A pointer child that itself contains an enumerated descendant is still
  // reachable through that descendant's own index, so it is not lost. Counting
  // those as lost would inflate the hole.
  const containsEnumerated = (el) => el.querySelector(selector) !== null
    && Array.from(el.querySelectorAll(selector)).some(d => baselineSet.has(d))

  const childrenPerWrapper = new Map()
  for (const el of pointer) {
    if (!isVisible(el)) continue
    if (containsEnumerated(el)) continue
    const ancestor = nearestEnumeratedAncestor(el)
    if (ancestor === null) continue
    childrenPerWrapper.set(ancestor, (childrenPerWrapper.get(ancestor) ?? 0) + 1)
  }
  const ambiguousWrappers = [...childrenPerWrapper.values()].filter(n => n > 1)
  const lostToAmbiguity = ambiguousWrappers.reduce((sum, n) => sum + n, 0)

  return {
    baselineTotal: baseline.length,
    baselineInViewport: baselineVisible.length,
    pointerExtra: pointer.length,
    pointerVisible: classified.filter(c => c.visible).length,
    pointerNested: classified.filter(c => c.nested).length,
    genuineNew: genuine.length,
    ambiguousWrappers: ambiguousWrappers.length,
    lostToAmbiguity,
    rejection,
    genuineTags: genuine.reduce((acc, c) => ({ ...acc, [c.tag]: (acc[c.tag] ?? 0) + 1 }), {}),
  }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 2000 } })
const page = await context.newPage()
page.setDefaultNavigationTimeout(30_000)

const rows = []
for (const [name, url] of PAGES) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(1500) // let SPA hydration settle
    const r = await page.evaluate(analyze, INTERACTIVE_SELECTOR)
    const missRate = r.baselineTotal + r.genuineNew === 0
      ? 0
      : r.genuineNew / (r.baselineTotal + r.genuineNew)
    rows.push({ name, url, ...r, missRate })
    console.log(
      `${name.padEnd(12)} baseline=${String(r.baselineTotal).padStart(4)} `
      + `(viewport ${String(r.baselineInViewport).padStart(3)})  `
      + `pointer-extra=${String(r.pointerExtra).padStart(4)} `
      + `visible=${String(r.pointerVisible).padStart(3)} nested=${String(r.pointerNested).padStart(3)}  `
      + `GENUINELY-NEW=${String(r.genuineNew).padStart(3)}  miss=${(missRate * 100).toFixed(1)}%`,
    )
    console.log(`${' '.repeat(14)}拒绝原因: ${JSON.stringify(r.rejection)}`)
    console.log(`${' '.repeat(14)}歧义包装元素: ${r.ambiguousWrappers} 个，吞掉 ${r.lostToAmbiguity} 个可见可点子元素`)
    if (r.genuineNew > 0) console.log(`${' '.repeat(14)}new-by-tag: ${JSON.stringify(r.genuineTags)}`)
  } catch (error) {
    console.log(`${name.padEnd(12)} FAILED: ${String(error.message).split('\n')[0].slice(0, 90)}`)
    rows.push({ name, url, error: String(error.message).slice(0, 200) })
  }
}

await browser.close()

const ok = rows.filter(r => r.error === undefined)
const totalBaseline = ok.reduce((n, r) => n + r.baselineTotal, 0)
const totalNew = ok.reduce((n, r) => n + r.genuineNew, 0)
console.log('\n=== 汇总 ===')
console.log(`页面 ${ok.length}/${rows.length} 成功`)
console.log(`baseline 枚举总数 ${totalBaseline}，pointer 启发式新增真实目标 ${totalNew}`)
console.log(`整体漏枚举率(pointer 启发式口径) = ${(totalNew / (totalBaseline + totalNew) * 100).toFixed(1)}%`)
const totalLost = ok.reduce((n, r) => n + r.lostToAmbiguity, 0)
const totalWrappers = ok.reduce((n, r) => n + r.ambiguousWrappers, 0)
console.log(`歧义包装：${totalWrappers} 个包装元素吞掉 ${totalLost} 个可见可点子元素`)
console.log(`若按"子元素本应各自可寻址"计，覆盖漏洞 = ${(totalLost / (totalBaseline + totalLost) * 100).toFixed(1)}%`)

mkdirSync(new URL('./results', import.meta.url), { recursive: true })
writeFileSync(
  new URL('./results/coverage.json', import.meta.url),
  JSON.stringify({ pages: rows, totalBaseline, totalNew }, null, 2),
)
console.log('结果已写入 experiments/enumeration-coverage/results/coverage.json')
