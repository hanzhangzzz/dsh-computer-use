/**
 * Are the names in a snapshot good enough to pick a target by?
 *
 * The model addresses elements by index, but it chooses the index by reading
 * the name. So a snapshot where a third of the names are duplicates hands the
 * model a list it cannot disambiguate from text alone -- it has to guess from
 * DOM order, or fall back to the screenshot and the 61.8% grounding path.
 * That makes naming quality a grounding problem wearing a structure costume,
 * and it is far cheaper to fix than grounding itself.
 *
 * Mirrors `describeElement`'s current name resolution exactly, then measures:
 *   - unnamed: how many elements render as `role ""`
 *   - salvageable: how many of those have a name available elsewhere
 *     (title, img[alt], svg <title>, aria-labelledby, href tail)
 *   - duplicated: how many share their name with at least one other element
 *
 * Run from the repo root: node experiments/enumeration-coverage/naming.mjs
 */

import { chromium } from 'playwright-core'

const PAGES = [
  ['wikipedia', 'https://en.wikipedia.org/wiki/Main_Page'],
  ['hn', 'https://news.ycombinator.com'],
  ['github', 'https://github.com/openai/codex'],
  ['mdn', 'https://developer.mozilla.org/en-US/'],
]

const INTERACTIVE_SELECTOR = 'a, button, input, select, textarea, [role], [onclick], [contenteditable="true"]'

/** Runs in the page; mirrors the provider's filters and naming. */
function audit(selector) {
  const docLang = document.documentElement.lang || ''
  const elements = Array.from(document.querySelectorAll(selector)).filter((el) => {
    if (el.closest('[aria-hidden="true"]') !== null) return false
    const lang = el.getAttribute('lang')
    if (el instanceof HTMLAnchorElement && lang !== null && lang !== '' && lang !== docLang) return false
    return true
  })

  // Exactly describeElement's chain today.
  const currentName = (el) => {
    const ariaLabel = el.getAttribute('aria-label')
    if (ariaLabel !== null) return ariaLabel
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value || el.placeholder
    if (el instanceof HTMLSelectElement) return el.value
    return (el.textContent ?? '').trim()
  }

  // Sources the chain does not consult yet.
  const fallbackName = (el) => {
    const labelledBy = el.getAttribute('aria-labelledby')
    return el.getAttribute('title')
      ?? el.querySelector('img[alt]')?.getAttribute('alt')
      ?? el.querySelector('svg title')?.textContent
      ?? (labelledBy !== null ? document.getElementById(labelledBy)?.textContent : undefined)
      ?? (el instanceof HTMLAnchorElement ? el.getAttribute('href') : undefined)
  }

  const names = elements.map(el => String(currentName(el)).slice(0, 200))
  const unnamed = names.filter(n => n === '').length
  const salvageable = elements.filter((el, i) =>
    names[i] === '' && String(fallbackName(el) ?? '').trim() !== '').length

  const counts = new Map()
  for (const name of names) {
    if (name !== '') counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const duplicated = [...counts.values()].filter(c => c > 1).reduce((sum, c) => sum + c, 0)

  return { total: elements.length, unnamed, salvageable, duplicated }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()

const totals = { total: 0, unnamed: 0, salvageable: 0, duplicated: 0 }
for (const [name, url] of PAGES) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(1200)
    const r = await page.evaluate(audit, INTERACTIVE_SELECTOR)
    for (const key of Object.keys(totals)) totals[key] += r[key]
    console.log(
      `${name.padEnd(10)} elements=${String(r.total).padStart(4)}`
      + `  unnamed=${String(r.unnamed).padStart(3)} (${(r.unnamed / r.total * 100).toFixed(1)}%)`
      + `  salvageable=${r.salvageable}`
      + `  duplicated=${String(r.duplicated).padStart(3)} (${(r.duplicated / r.total * 100).toFixed(1)}%)`,
    )
  } catch (error) {
    console.log(`${name.padEnd(10)} FAILED: ${String(error.message).slice(0, 70)}`)
  }
}
await browser.close()

console.log(
  `\ntotal ${totals.total} elements: unnamed ${totals.unnamed}`
  + ` (${(totals.unnamed / totals.total * 100).toFixed(1)}%, ${totals.salvageable} of them salvageable),`
  + ` duplicated ${totals.duplicated} (${(totals.duplicated / totals.total * 100).toFixed(1)}%)`,
)
console.log(`
Reading: roughly a third of a snapshot's names are not unique, and on a dense
app page it approaches half. Duplicate names do not stop the model from acting
-- it still has an index -- but they remove the evidence it would use to pick
the right index, which is how a structure-path task quietly degrades into a
visual one.`)
