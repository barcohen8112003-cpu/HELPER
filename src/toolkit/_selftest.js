// node src/toolkit/_selftest.js            offline checks only
// node src/toolkit/_selftest.js --network  also runs tests of tools marked network: true
// Never calls a model, never touches the live data folder (HELPER_DATA_DIR is pointed at a temp folder).
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

process.env.HELPER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-toolkit-'))
const withNetwork = process.argv.includes('--network')

const { extendedTools, categories, loadErrors } = await import('./registry.js')
const fs2 = await import('node:fs')
const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

let failed = 0
const fail = (msg) => {
  failed++
  console.log(`FAIL  ${msg}`)
}

for (const e of loadErrors) fail(`לא נטען: ${e}`)

for (const t of extendedTools) {
  if (!/^[a-z][a-z0-9_]*$/.test(t.name)) fail(`${t.name}: שם לא תקין`)
  if (!t.description || t.description.length < 8) fail(`${t.name}: חסר תיאור`)
  if (t.description && t.description.length > 220) fail(`${t.name}: תיאור ארוך מדי (${t.description.length})`)
  if (t.parameters?.type !== 'object') fail(`${t.name}: parameters חייב להיות object`)
  if (typeof t.run !== 'function') fail(`${t.name}: אין run`)
  for (const r of t.parameters?.required ?? []) if (!(r in (t.parameters.properties ?? {}))) fail(`${t.name}: required לא קיים ב-properties: ${r}`)
  if (t.risk && t.risk !== 'write') fail(`${t.name}: risk יכול להיות רק write`)
}

let ran = 0
let skipped = 0
const files = fs2.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.startsWith('_') && f !== 'registry.js')
const covered = new Set()
for (const file of files) {
  let mod
  try {
    mod = await import(`./${file}`)
  } catch {
    continue
  }
  for (const test of mod.tests ?? []) {
    const tool = extendedTools.find((t) => t.name === test.tool)
    if (!tool) {
      fail(`${file}: בדיקה לכלי שלא קיים: ${test.tool}`)
      continue
    }
    covered.add(tool.name)
    if (tool.network && !withNetwork) {
      skipped++
      continue
    }
    try {
      const result = await tool.run(test.args ?? {}, {})
      if (!test.check(result)) fail(`${tool.name}: התוצאה לא עברה את הבדיקה: ${String(result).slice(0, 160)}`)
      else ran++
    } catch (e) {
      if (test.throws) ran++
      else fail(`${tool.name}: ${e.message}`)
    }
  }
}

const untested = extendedTools.filter((t) => !covered.has(t.name))
console.log(`${extendedTools.length} כלים ב-${categories.length} תחומים; ${ran} בדיקות עברו, ${skipped} דולגו (רשת), ${untested.length} בלי בדיקה`)
if (untested.length) console.log(`בלי בדיקה: ${untested.map((t) => t.name).join(', ')}`)
if (failed) {
  console.log(`${failed} כשלונות`)
  process.exit(1)
}
console.log('הכול תקין')
