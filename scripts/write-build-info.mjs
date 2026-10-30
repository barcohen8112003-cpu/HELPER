// Writes build-info.json for the post-deploy WhatsApp note.
// Used by the Docker notes stage (`docker compose up -d --build` after git pull).
// .git is read here and is not copied into the final image. If git is missing, GIT_SHA is the fallback.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const outFlag = process.argv.indexOf('--out')
const out = outFlag >= 0 ? process.argv[outFlag + 1] : 'build-info.json'

function git(args) {
  return execFileSync('git', ['-c', 'safe.directory=*', ...args], { encoding: 'utf8', cwd: process.cwd() }).trim()
}

function fromGit() {
  const sha = git(['rev-parse', 'HEAD'])
  const raw = git(['log', '-40', '--pretty=format:%H%x1f%s%x1f%b%x1e'])
  const commits = raw.split('\x1e').map((block) => block.trim()).filter(Boolean).map((block) => {
    const [id, subject, ...rest] = block.split('\x1f')
    return {
      sha: String(id || '').trim(),
      subject: String(subject || '').trim().slice(0, 200),
      body: rest.join('\x1f').trim().slice(0, 500),
    }
  }).filter((c) => c.sha && c.subject)
  return { sha, short: sha.slice(0, 7), commits }
}

let info
try {
  info = fromGit()
} catch {
  const sha = String(process.env.GIT_SHA || 'unknown').trim() || 'unknown'
  info = { sha, short: sha === 'unknown' ? 'unknown' : sha.slice(0, 7), commits: [] }
}

fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
fs.writeFileSync(out, JSON.stringify(info, null, 2) + '\n')
console.log(`[build-info] ${info.short} (${info.commits.length} commits)`)
