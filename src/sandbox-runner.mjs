// Runs inside the sandbox: `node --permission --allow-fs-read=<this file> --allow-fs-read=<module> sandbox-runner.mjs <module>`.
// The permission flag leaves this process no file writes, no child processes, no worker threads, and reads only of the
// two files named; its environment is empty, so none of Helper's keys exist here. One request comes in on stdin and one
// answer leaves on stdout. Nothing in this file is trusted with more than that.
import { pathToFileURL } from 'node:url'

const MAX_OUT = 4000

const read = async () => {
  let data = ''
  for await (const chunk of process.stdin) data += chunk
  return JSON.parse(data || '{}')
}
const done = (value) => process.stdout.write(JSON.stringify(value))
const clip = (x) => String(x ?? '').slice(0, MAX_OUT)

try {
  const req = await read()
  const mod = await import(pathToFileURL(process.argv[2]).href)
  const tools = Array.isArray(mod.tools) ? mod.tools : []
  if (req.op === 'describe') {
    done({ ok: true, tools: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters, network: Boolean(t.network) })), tests: Array.isArray(mod.tests) ? mod.tests.length : 0, blurb: String(mod.blurb || '') })
  } else if (req.op === 'call') {
    const tool = tools.find((t) => t.name === req.tool)
    if (!tool) throw new Error('כלי לא קיים')
    done({ ok: true, result: clip(await tool.run(req.args || {})) })
  } else if (req.op === 'test') {
    const results = []
    for (const t of Array.isArray(mod.tests) ? mod.tests : []) {
      const tool = tools.find((x) => x.name === t.tool)
      if (!tool) {
        results.push({ tool: t.tool, pass: false, why: 'הכלי לא קיים' })
        continue
      }
      try {
        const out = await tool.run(t.args || {})
        results.push({ tool: t.tool, pass: Boolean(t.check(out)), why: Boolean(t.check(out)) ? '' : `התוצאה לא עברה את הבדיקה: ${clip(out).slice(0, 120)}` })
      } catch (e) {
        results.push({ tool: t.tool, pass: Boolean(t.throws), why: t.throws ? '' : clip(e.message).slice(0, 120) })
      }
    }
    done({ ok: true, results })
  } else {
    throw new Error('פעולה לא מוכרת')
  }
} catch (e) {
  done({ ok: false, error: clip(e.message).slice(0, 300) })
}
process.exit(0)
