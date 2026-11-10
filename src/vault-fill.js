// Filling a saved login into a browser page over the Chrome DevTools Protocol, for the vault (src/vault.js).
// `call(method, params)` is a CDP call on one tab: the errand browser's (src/errand-browser.js) in production, a
// Playwright CDP session in the self-test.
//
// The site is checked where the form actually is, not where the model thinks it is:
// - the tab's top-level page, after any redirects, must be at the entry's exact origin;
// - the password field must be in a frame of that same origin whose every parent frame is that origin too (a
//   login frame inside someone else's page is refused);
// - there must be exactly one visible password field, and it must still be type=password when it is filled.
// The values are passed to an isolated world as call arguments, set on the fields, and never returned.
const originOfUrl = (u) => {
  try {
    return new URL(u).origin
  } catch {
    return 'null'
  }
}

export async function pageOrigin(call) {
  const { frameTree } = await call('Page.getFrameTree')
  return originOfUrl(frameTree.frame.url)
}

// Frames as [{ id, origin, chain: [origins of it and every parent] }].
function frames(tree, parents = [], out = []) {
  const own = tree.frame.securityOrigin && tree.frame.securityOrigin !== '://' ? tree.frame.securityOrigin : originOfUrl(tree.frame.url)
  const chain = [...parents, own, originOfUrl(tree.frame.url)]
  out.push({ id: tree.frame.id, chain })
  for (const child of tree.childFrames || []) frames(child, chain, out)
  return out
}

const VISIBLE = `const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.disabled }`
const COUNT = `(() => { ${VISIBLE}; return [...document.querySelectorAll('input')].filter((el) => el.type === 'password' && vis(el)).length })()`
const FILL = `function (user, pass) {
  ${VISIBLE}
  const pw = [...document.querySelectorAll('input')].filter((el) => el.type === 'password' && vis(el))
  if (pw.length !== 1) return { ok: false, why: 'count' }
  const p = pw[0]
  if (p.type !== 'password' || p.readOnly) return { ok: false, why: 'field' }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  const put = (el, v) => { el.focus(); setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })) }
  let u = null
  if (user) {
    const scope = p.form || document
    u = [...scope.querySelectorAll('input[autocomplete~="username"]')].find(vis) || null
    if (!u) {
      const before = [...scope.querySelectorAll('input')].filter((el) => ['text', 'email', 'tel'].includes(el.type) && vis(el) && (el.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING))
      u = before.at(-1) || null
    }
    if (u) put(u, user)
  }
  put(p, pass)
  return { ok: p.type === 'password' && p.value === pass, user: Boolean(u) }
}`

const refuse = (message) => Object.assign(new Error(message), { code: 'refused' })

// The one same-site frame with exactly one visible password field, or a refusal saying why. Reads only.
export async function locateLogin(call, origin) {
  const { frameTree } = await call('Page.getFrameTree')
  const top = originOfUrl(frameTree.frame.url)
  if (top !== origin) throw refuse(`הדף הפתוח הוא ${top}, לא ${origin}. לא ממלא.`)
  const all = frames(frameTree)
  const sameSite = all.filter((f) => f.chain.every((o) => o === origin))
  const found = []
  for (const f of sameSite) {
    const { executionContextId } = await call('Page.createIsolatedWorld', { frameId: f.id, worldName: 'helper-vault', grantUniveralAccess: false })
    const { result } = await call('Runtime.evaluate', { expression: COUNT, contextId: executionContextId, returnByValue: true })
    if (result.value > 0) found.push({ ...f, count: result.value, contextId: executionContextId })
  }
  const elsewhere = all.length - sameSite.length
  if (!found.length) throw refuse(elsewhere ? 'שדה הסיסמה לא בדף של האתר עצמו (מסגרת מאתר אחר). לא ממלא.' : 'אין בדף שדה סיסמה גלוי.')
  if (found.length > 1 || found[0].count > 1) throw refuse('יש בדף יותר משדה סיסמה אחד. לא ממלא כדי לא לטעות בשדה.')
  return found[0]
}

// -> { filled: true, user: boolean }. Throws (code 'refused') when anything does not match. The checks run again
// here, right before the values are set, whatever was checked before the question.
export async function fillLogin(call, { origin, username, password }) {
  const target = await locateLogin(call, origin)
  const { result: global } = await call('Runtime.evaluate', { expression: 'globalThis', contextId: target.contextId })
  const { result } = await call('Runtime.callFunctionOn', { functionDeclaration: FILL, objectId: global.objectId, arguments: [{ value: username || '' }, { value: password }], returnByValue: true, silent: true })
  // Nothing from the call is returned except whether it worked.
  if (!result?.value?.ok) throw refuse('השדה השתנה או לא קיבל את הערך. לא מולא.')
  if ((await pageOrigin(call)) !== origin) throw refuse('הדף עבר לאתר אחר בזמן המילוי.')
  return { filled: true, user: Boolean(result.value.user) }
}
