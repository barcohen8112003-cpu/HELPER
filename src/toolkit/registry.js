// Loads every toolkit module in this folder. A module is one file:
//
//   export const category = 'math'                 // lower-case, one word
//   export const blurb = 'חישובים והמרות'          // what the category is for, in a few Hebrew words
//   export const tools = [{ name, description, parameters, run(args, ctx), risk?, network? }, ...]
//   export const tests = [{ tool: 'name', args: {...}, check: (result) => boolean }]   // optional but expected
//
// `risk: 'write'` means the tool changes something outside Helper (sends, deletes, posts). Those need the user's
// approval in chat on every call. Tools without it must be read-only or only touch Helper's own state.
// `network: true` marks tools that call the internet; the offline self-test skips their tests.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.startsWith('_') && f !== 'registry.js').sort()

export const categories = []
export const extendedTools = []
export const loadErrors = []

for (const file of files) {
  try {
    const mod = await import(`./${file}`)
    const category = mod.category || file.replace(/\.js$/, '')
    const seen = new Set()
    for (const tool of mod.tools) {
      if (extendedTools.some((t) => t.name === tool.name) || seen.has(tool.name)) throw new Error(`שם כלי כפול: ${tool.name}`)
      seen.add(tool.name)
    }
    categories.push({ category, blurb: mod.blurb || '', count: mod.tools.length })
    for (const tool of mod.tools) extendedTools.push({ ...tool, category })
  } catch (e) {
    // One broken module must not take the assistant down.
    loadErrors.push(`${file}: ${e.message}`)
    console.warn(`[toolkit] ${file} לא נטען: ${e.message}`)
  }
}

const words = (s) => String(s).toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((w) => w.length > 1)

// The tools that best match a request, best first. Used by the tool_search tool.
export function searchTools(query, active = extendedTools, limit = 8) {
  const q = words(query)
  if (!q.length) return []
  return active
    .map((t) => {
      const hay = `${t.name.replace(/_/g, ' ')} ${t.category} ${t.description}`.toLowerCase()
      let score = 0
      for (const w of q) {
        if (t.category === w) score += 6
        if (t.name.includes(w)) score += 4
        if (hay.includes(w)) score += 1
      }
      return { t, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.t)
}
