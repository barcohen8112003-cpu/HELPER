// libsignal (pulled in by Baileys) prints Signal session records on the console. Those objects
// contain key material. The lines are dropped; everything else still goes to the log.
const SECRET_PREFIXES = [
  'Closing session',
  'Closing open session',
  'Removing old closed session',
  'Opening session',
  'Session already closed',
]

export function isSecretSessionLog(value) {
  if (typeof value !== 'string') return false
  const text = value.trimStart()
  return SECRET_PREFIXES.some((prefix) => text.startsWith(prefix))
}

for (const method of ['log', 'info', 'warn']) {
  const orig = console[method].bind(console)
  console[method] = (...args) => {
    if (isSecretSessionLog(args[0])) return
    orig(...args)
  }
}
