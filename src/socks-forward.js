// TCP tunnel through a SOCKS5 proxy. Tailscale on the VPS runs in userspace mode, so the helper
// container cannot dial a tailnet IP directly. It connects to tailscale:1055 and this tunnel
// carries one TCP stream (ADB) to the phone.
import net from 'node:net'

export function parseSocksProxy(raw) {
  const v = String(raw || '').trim()
  if (!v) return null
  let url
  try {
    url = new URL(v)
  } catch {
    return null
  }
  if (url.protocol !== 'socks5:' && url.protocol !== 'socks5h:') return null
  const port = Number(url.port)
  if (!url.hostname || !port) return null
  return {
    host: url.hostname,
    port,
    user: decodeURIComponent(url.username || ''),
    pass: decodeURIComponent(url.password || ''),
  }
}

// One reader for the whole handshake. Reading twice with a fresh listener drops the bytes that were
// pushed back onto the socket between the two reads.
function reader(socket) {
  let buf = Buffer.alloc(0)
  let pending = null
  const fail = (err) => pending?.reject(err instanceof Error ? err : new Error('חיבור ה-SOCKS נסגר'))
  const pump = () => {
    if (!pending || buf.length < pending.n) return
    const { n, resolve } = pending
    pending = null
    const out = buf.subarray(0, n)
    buf = buf.subarray(n)
    resolve(out)
  }
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk])
    pump()
  }
  socket.on('data', onData)
  socket.on('error', fail)
  socket.on('close', fail)
  return {
    read(n) {
      if (buf.length >= n) {
        const out = buf.subarray(0, n)
        buf = buf.subarray(n)
        return Promise.resolve(out)
      }
      return new Promise((resolve, reject) => {
        pending = { n, resolve, reject }
        pump()
      })
    },
    stop() {
      socket.off('data', onData)
      socket.off('error', fail)
      socket.off('close', fail)
      if (buf.length) socket.unshift(buf)
      buf = Buffer.alloc(0)
    },
  }
}

function write(socket, buf) {
  return new Promise((resolve, reject) => {
    socket.write(buf, (err) => (err ? reject(err) : resolve()))
  })
}

// Opens a SOCKS5 CONNECT to targetHost:targetPort and returns the proxy socket, ready to pipe.
export async function socksConnect(proxy, targetHost, targetPort) {
  if (!proxy?.host || !proxy.port) throw new Error('פרוקסי הטלפון צריך להיות כתובת socks5://')
  const socket = net.connect({ host: proxy.host, port: proxy.port })
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  const incoming = reader(socket)
  try {
    const auth = Boolean(proxy.user)
    await write(socket, Buffer.from(auth ? [0x05, 0x01, 0x02] : [0x05, 0x01, 0x00]))
    const method = await incoming.read(2)
    if (method[0] !== 0x05 || method[1] === 0xff) throw new Error('שרת ה-SOCKS דחה את שיטת האימות')
    if (method[1] === 0x02) {
      const user = Buffer.from(proxy.user)
      const pass = Buffer.from(proxy.pass)
      if (user.length > 255 || pass.length > 255) throw new Error('שם המשתמש של הפרוקסי ארוך מדי')
      await write(socket, Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]))
      const answer = await incoming.read(2)
      if (answer[1] !== 0x00) throw new Error('הפרוקסי דחה את שם המשתמש או הסיסמה')
    } else if (method[1] !== 0x00) {
      throw new Error('שרת ה-SOCKS ביקש אימות שלא נתמך')
    }
    const hostBuf = Buffer.from(targetHost)
    let addr
    if (net.isIP(targetHost) === 4) addr = Buffer.concat([Buffer.from([0x01]), Buffer.from(targetHost.split('.').map(Number))])
    else if (net.isIP(targetHost) === 6) addr = Buffer.concat([Buffer.from([0x04]), ipv6Buffer(targetHost)])
    else {
      if (hostBuf.length > 255) throw new Error('שם המארח ארוך מדי')
      addr = Buffer.concat([Buffer.from([0x03, hostBuf.length]), hostBuf])
    }
    const portBuf = Buffer.alloc(2)
    portBuf.writeUInt16BE(targetPort)
    await write(socket, Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addr, portBuf]))
    const head = await incoming.read(4)
    if (head[1] !== 0x00) throw new Error(`הפרוקסי לא פתח חיבור אל הטלפון (קוד ${head[1]})`)
    const atyp = head[3]
    if (atyp === 0x01) await incoming.read(4 + 2)
    else if (atyp === 0x04) await incoming.read(16 + 2)
    else if (atyp === 0x03) {
      const len = (await incoming.read(1))[0]
      await incoming.read(len + 2)
    } else {
      throw new Error('תשובת SOCKS לא מוכרת')
    }
    incoming.stop()
    return socket
  } catch (err) {
    incoming.stop()
    socket.destroy()
    throw err
  }
}

function ipv6Buffer(host) {
  const parts = host.split('::')
  const head = parts[0] ? parts[0].split(':').filter(Boolean) : []
  const tail = parts[1] ? parts[1].split(':').filter(Boolean) : []
  const missing = 8 - head.length - tail.length
  const full = [...head, ...Array(Math.max(0, missing)).fill('0'), ...tail]
  const buf = Buffer.alloc(16)
  full.slice(0, 8).forEach((part, i) => buf.writeUInt16BE(parseInt(part || '0', 16), i * 2))
  return buf
}

function pipe(a, b) {
  const drop = () => {
    a.destroy()
    b.destroy()
  }
  a.pipe(b)
  b.pipe(a)
  a.on('error', drop)
  b.on('error', drop)
  a.on('close', () => b.destroy())
  b.on('close', () => a.destroy())
}

// Listens on 127.0.0.1 and tunnels every connection to targetHost:targetPort via the proxy.
// listenPort 0 picks a free port. The returned port is what `adb connect` should dial.
export function startTcpForward({ listenHost = '127.0.0.1', listenPort = 0, targetHost, targetPort, proxy }) {
  if (!targetHost || !targetPort) throw new Error('חסרה כתובת יעד למנהרה')
  const server = net.createServer((client) => {
    socksConnect(proxy, targetHost, targetPort)
      .then((remote) => pipe(client, remote))
      .catch(() => client.destroy())
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(listenPort, listenHost, () => {
      const port = server.address().port
      resolve({
        host: listenHost,
        port,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}
