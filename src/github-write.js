// GitHub writes Helper can do natively: open an issue, open a pull request, comment on an issue or a PR. Nothing
// else. github_get stays read-only (GET only), and the browser remains the way to do anything not listed here.
//
// Rules this file keeps, in code:
// - Off until the owner names the repositories: GITHUB_WRITE_REPOS=owner/repo,owner/other. Any other repository is
//   refused before a request is made. There is no generic "call this API path" write.
// - Each call is bound to the token's login, the repository's numeric id, the exact target (issue/PR number and kind,
//   or head/base branches with their commit SHAs) and the exact title and body the owner was shown.
// - Opening a PR only opens it: no push, no merge, no branch or commit is created, and it opens as a draft unless
//   draft=false is asked for and approved. A PR whose head moved after the question is not opened.
// - "Created" is said only when GitHub answered with the new object (its number and html_url).
// - Whether the token can actually write is not known until GitHub answers; a 403/404 is reported as such.
import { config } from './config.js'
import { boundMutation } from './bound-actions.js'
import { str, obj } from './tool-helpers.js'

const API = 'https://api.github.com'
const NAME = /^[A-Za-z0-9_.-]{1,100}$/
const BRANCH = /^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*@\{)[A-Za-z0-9._/-]{1,200}(?<![/.])$/
const MAX_TITLE = 256
const MAX_BODY = 4000
const fail = (message, code) => Object.assign(new Error(message), code && { code })

export const writeRepos = () => (process.env.GITHUB_WRITE_REPOS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)

async function gh(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.githubToken}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'helper', ...(body && { 'Content-Type': 'application/json' }) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {}
  if (!res.ok) {
    const why = res.status === 403 || res.status === 404 ? ' (ייתכן שלטוקן אין הרשאה לזה, או שהמאגר לא גלוי לו)' : ''
    throw Object.assign(new Error(`GitHub HTTP ${res.status}${why}: ${String(data?.message || text).slice(0, 200)}`), { status: res.status })
  }
  return data ?? {}
}

// The repository, if the owner allowed writing to it and the token can see it.
async function repoFor(input) {
  if (!config.githubToken) throw fail('אין GITHUB_TOKEN מוגדר.', 'setup_needed')
  const allowed = writeRepos()
  if (!allowed.length) throw fail('כתיבה ל-GitHub כבויה: אין מאגרים ב-GITHUB_WRITE_REPOS. צריך שהבעלים יבחר אילו מאגרים מותרים.', 'setup_needed')
  const full = String(input || '').trim()
  const [owner, name, extra] = full.split('/')
  if (extra !== undefined || !NAME.test(owner || '') || !NAME.test(name || '')) throw fail('repo צריך להיות בדיוק owner/name.')
  if (!allowed.includes(full.toLowerCase())) throw fail(`המאגר ${full} לא ברשימת המאגרים המותרים לכתיבה (GITHUB_WRITE_REPOS).`)
  const me = await gh('GET', '/user')
  const repo = await gh('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`)
  if (repo.archived) throw fail(`המאגר ${repo.full_name} בארכיון. אין בו כתיבה.`)
  return { login: me.login, owner, name, id: repo.id, full: repo.full_name, repo, base: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}` }
}

function words(title, body, { needTitle = true } = {}) {
  const t = String(title ?? '')
  const b = String(body ?? '')
  if (needTitle && (!t.trim() || t.length > MAX_TITLE)) throw fail(`צריך כותרת עד ${MAX_TITLE} תווים.`)
  if (/[\r\n]/.test(t)) throw fail('ירידת שורה בכותרת לא מותרת.')
  if (b.length > MAX_BODY) throw fail(`הטקסט ארוך מכדי להציג אותו במלואו לאישור (${b.length} תווים, מקסימום ${MAX_BODY}).`)
  return { t, b }
}

const created = (res, kind, repoFull) => Boolean(res && Number.isInteger(res.number) && typeof res.html_url === 'string' && res.html_url.includes(`/${repoFull}/${kind}/`))

export async function createIssue(ctx, args) {
  return boundMutation(ctx, {
    tool: 'github_create_issue',
    async prepare() {
      const { t, b } = words(args.title, args.body)
      const r = await repoFor(args.repo)
      if (r.repo.has_issues === false) throw fail(`ב-${r.full} כבויים issues.`)
      return {
        account: `github:${r.login}`,
        op: { base: r.base, repoId: r.id, full: r.full, title: t, body: b },
        question: `לפתוח issue ב-GitHub?\n*מאגר:* ${r.full}\n*בשם:* ${r.login}\n*כותרת:* ${t}\n\n${b || '(בלי תוכן)'}`,
      }
    },
    async execute(op) {
      const res = await gh('POST', `${op.base}/issues`, { title: op.title, body: op.body })
      const confirmed = created(res, 'issues', op.full)
      return { confirmed, ref: res.html_url, text: confirmed ? `נפתח issue #${res.number}: ${res.html_url}` : 'GitHub ענה בלי ה-issue החדש (אין מספר וקישור)' }
    },
  })
}

async function branch(r, name) {
  if (!BRANCH.test(String(name || ''))) throw fail(`שם ענף לא תקין: "${String(name).slice(0, 80)}".`)
  try {
    const b = await gh('GET', `${r.base}/branches/${encodeURIComponent(name)}`)
    return b.commit?.sha
  } catch (e) {
    if (e.status === 404) throw fail(`אין ענף ${name} ב-${r.full}.`)
    throw e
  }
}

export async function createPullRequest(ctx, args) {
  return boundMutation(ctx, {
    tool: 'github_create_pr',
    async prepare() {
      const { t, b } = words(args.title, args.body)
      const r = await repoFor(args.repo)
      if (String(args.head || '').includes(':')) throw fail('רק ענף מאותו מאגר (בלי owner:branch ממזלג).')
      if (args.head === args.base) throw fail('head ו-base זהים.')
      const head = await branch(r, args.head)
      const base = await branch(r, args.base)
      const cmp = await gh('GET', `${r.base}/compare/${encodeURIComponent(args.base)}...${encodeURIComponent(args.head)}`)
      if (!(cmp.ahead_by > 0)) throw fail(`אין ב-${args.head} שינויים מעבר ל-${args.base}. אין מה לפתוח.`)
      const open = await gh('GET', `${r.base}/pulls?state=open&head=${encodeURIComponent(`${r.owner}:${args.head}`)}&base=${encodeURIComponent(args.base)}`)
      if (Array.isArray(open) && open.length) throw fail(`כבר פתוח PR מ-${args.head} ל-${args.base}: ${open[0].html_url}`)
      const draft = args.draft !== false
      return {
        account: `github:${r.login}`,
        op: { base: r.base, repoId: r.id, full: r.full, head: args.head, headSha: head, baseRef: args.base, title: t, body: b, draft },
        fingerprint: { head, base },
        question: `לפתוח pull request ב-GitHub?${draft ? ' (כטיוטה)' : ' (לא טיוטה: מוכן לסקירה)'}\n*מאגר:* ${r.full}\n*בשם:* ${r.login}\n*מ:* ${args.head} (${head.slice(0, 7)}, ${cmp.ahead_by} קומיטים)\n*אל:* ${args.base} (${base.slice(0, 7)})\n*כותרת:* ${t}\n\n${b || '(בלי תיאור)'}\n\nרק פתיחה. בלי מיזוג, בלי push ובלי שינוי בענפים.`,
      }
    },
    recheck: async (op) => {
      const r = { base: op.base, full: op.full }
      return { head: await branch(r, op.head), base: await branch(r, op.baseRef) }
    },
    async execute(op) {
      const res = await gh('POST', `${op.base}/pulls`, { title: op.title, head: op.head, base: op.baseRef, body: op.body, draft: op.draft })
      const confirmed = created(res, 'pull', op.full)
      const moved = confirmed && res.head?.sha && res.head.sha !== op.headSha ? ` (שים לב: ה-head עכשיו ${res.head.sha.slice(0, 7)})` : ''
      return { confirmed, ref: res.html_url, text: confirmed ? `נפתח PR #${res.number}${res.draft ? ' (טיוטה)' : ''}: ${res.html_url}${moved}` : 'GitHub ענה בלי ה-PR החדש (אין מספר וקישור)' }
    },
  })
}

export async function createComment(ctx, args) {
  return boundMutation(ctx, {
    tool: 'github_comment',
    async prepare() {
      const { b } = words('', args.body, { needTitle: false })
      if (!b.trim()) throw fail('אין תוכן לתגובה.')
      const kind = args.kind
      if (!['issue', 'pr'].includes(kind)) throw fail('kind צריך להיות issue או pr.')
      const number = Number(args.number)
      if (!Number.isInteger(number) || number < 1) throw fail('צריך מספר issue/PR מדויק.')
      const r = await repoFor(args.repo)
      let target
      try {
        target = await gh('GET', `${r.base}/issues/${number}`)
      } catch (e) {
        if (e.status === 404) throw fail(`אין #${number} ב-${r.full}.`)
        throw e
      }
      const isPr = Boolean(target.pull_request)
      if (isPr !== (kind === 'pr')) throw fail(`#${number} ב-${r.full} הוא ${isPr ? 'PR' : 'issue'}, לא ${kind === 'pr' ? 'PR' : 'issue'}.`)
      if (target.locked) throw fail(`#${number} נעול לתגובות.`)
      return {
        account: `github:${r.login}`,
        op: { base: r.base, repoId: r.id, full: r.full, number, kind, body: b },
        question: `להגיב ב-GitHub על ${kind === 'pr' ? 'PR' : 'issue'} #${number} "${target.title}" (${target.state})?\n*מאגר:* ${r.full}\n*בשם:* ${r.login}\n\n${b}`,
      }
    },
    async execute(op) {
      const res = await gh('POST', `${op.base}/issues/${op.number}/comments`, { body: op.body })
      const confirmed = Number.isInteger(res.id) && typeof res.html_url === 'string' && String(res.issue_url || '').endsWith(`/${op.full}/issues/${op.number}`)
      return { confirmed, ref: res.html_url, text: confirmed ? `התגובה נוספה: ${res.html_url}` : 'GitHub ענה בלי התגובה החדשה' }
    },
  })
}

const REPO = str('owner/name, מתוך GITHUB_WRITE_REPOS')
const on = () => Boolean(config.githubToken)

export const githubWriteTools = [
  {
    name: 'github_create_issue',
    enabled: on,
    description: 'פותח issue חדש במאגר GitHub מותר (GITHUB_WRITE_REPOS). המשתמש מאשר את הכותרת והתוכן המדויקים.',
    parameters: obj({ repo: REPO, title: str('כותרת'), body: str('תוכן (Markdown)') }, ['repo', 'title']),
    run: (args, ctx) => createIssue(ctx, args),
  },
  {
    name: 'github_create_pr',
    enabled: on,
    description: 'פותח pull request (כטיוטה, אלא אם draft=false) מענף קיים head לענף base באותו מאגר מותר. רק פותח: לא ממזג, לא דוחף ולא יוצר ענפים. המשתמש מאשר.',
    parameters: obj({ repo: REPO, head: str('הענף עם השינויים'), base: str('הענף שאליו'), title: str('כותרת'), body: str('תיאור'), draft: { type: 'boolean', description: 'ברירת מחדל true' } }, ['repo', 'head', 'base', 'title']),
    run: (args, ctx) => createPullRequest(ctx, args),
  },
  {
    name: 'github_comment',
    enabled: on,
    description: 'מוסיף תגובה ל-issue או ל-PR קיים (kind=issue|pr, number) במאגר מותר. המשתמש מאשר את הנוסח המדויק.',
    parameters: obj({ repo: REPO, kind: str('issue או pr'), number: { type: 'number' }, body: str('התגובה') }, ['repo', 'kind', 'number', 'body']),
    run: (args, ctx) => createComment(ctx, args),
  },
]
