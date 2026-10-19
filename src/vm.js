// The assistant's own computer: a Linux virtual machine (VirtualBox) on the user's PC, reached over SSH.
// It shares no folders, clipboard or files with the host. Whatever runs there stays there.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { config, DATA_DIR } from './config.js'

const VBOX = process.env.VBOXMANAGE || 'C:\\Program Files\\Oracle\\VirtualBox\\VBoxManage.exe'
const SSH = process.env.SSH_EXE || 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'
const KEY = path.join(DATA_DIR, 'vm', 'id_ed25519')
const KNOWN_HOSTS = path.join(DATA_DIR, 'vm', 'known_hosts')
const MAX_OUTPUT = 6000
const BOOT_WAIT = 120000

export const vmEnabled = () => process.platform === 'win32' && fs.existsSync(KEY) && fs.existsSync(VBOX)

const run = (file, args, options = {}) =>
  new Promise((resolve) => execFile(file, args, { windowsHide: true, maxBuffer: 20 * 1024 * 1024, ...options }, (error, stdout, stderr) => resolve({ error, stdout, stderr })))

const sshArgs = (remote) => [
  '-i', KEY, '-p', String(config.vm.port),
  '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${KNOWN_HOSTS}`, '-o', 'ConnectTimeout=8', '-o', 'LogLevel=ERROR',
  `${config.vm.user}@127.0.0.1`, remote,
]

// Wrapped for the remote shell: the whole command arrives as one single-quoted word.
const quote = (command) => `'${String(command).replace(/'/g, `'\\''`)}'`

async function isUp() {
  const { error } = await run(SSH, sshArgs('true'), { timeout: 15000 })
  return !error
}

// Starts the machine if it is off and waits until it answers. It keeps running afterwards.
export async function ensureRunning() {
  if (await isUp()) return
  const info = await run(VBOX, ['showvminfo', config.vm.name, '--machinereadable'])
  if (info.error) throw new Error(`המכונה ${config.vm.name} לא קיימת ב-VirtualBox`)
  if (!/VMState="running"/.test(info.stdout)) {
    const started = await run(VBOX, ['startvm', config.vm.name, '--type', 'headless'])
    if (started.error) throw new Error(`המכונה לא עלתה: ${(started.stderr || started.error.message).slice(0, 200)}`)
  }
  const deadline = Date.now() + BOOT_WAIT
  while (Date.now() < deadline) {
    if (await isUp()) return
    await new Promise((r) => setTimeout(r, 3000))
  }
  throw new Error('המכונה דולקת אבל לא עונה ב-SSH')
}

// Runs a bash command on the machine, as its own user (which has sudo). Returns the output and the exit code.
export async function vmRun(command, timeoutSeconds = 120) {
  await ensureRunning()
  const limit = Math.min(900, Math.max(5, timeoutSeconds))
  const { error, stdout, stderr } = await run(SSH, sshArgs(`timeout ${limit} bash -lc ${quote(command)}`), { timeout: (limit + 15) * 1000 })
  const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
  const text = [stdout, stderr && `STDERR: ${stderr}`].filter(Boolean).join('\n').trim() || '(אין פלט)'
  const cut = text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT / 2)}\n…[נחתך]…\n${text.slice(-MAX_OUTPUT / 2)}` : text
  return `${cut}\n[exit ${code === 124 ? `124 - נעצר אחרי ${limit} שניות` : code}]`
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json', zip: 'application/zip' }

// Fetches a file from the machine, as { buffer, mime, name }, ready to be sent to the user.
export async function vmFetch(file) {
  await ensureRunning()
  const { error, stdout, stderr } = await run(SSH, sshArgs(`cat -- ${quote(file)}`), { timeout: 120000, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })
  if (error) throw new Error((stderr?.toString() || error.message).slice(0, 200))
  const name = path.posix.basename(file)
  return { buffer: stdout, mime: MIME[name.split('.').pop().toLowerCase()] || 'application/octet-stream', name }
}
