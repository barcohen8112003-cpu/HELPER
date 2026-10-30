// npm run check:scrapling-py: runs py/scrapling_worker_test.py with the venv's Python, without a shell.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const python = process.env.SCRAPLING_PYTHON || path.join(ROOT, '.venv-scrapling', process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python')
if (!fs.existsSync(python)) {
  console.log(`אין ${python}. התקנה: py/README.md`)
  process.exit(1)
}
const r = spawnSync(python, ['-I', path.join(ROOT, 'py', 'scrapling_worker_test.py')], { stdio: 'inherit' })
process.exit(r.status ?? 1)
