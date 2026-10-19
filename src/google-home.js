// Integration with Google Home via the open Chrome tab on the Webtop port.
// Connects over CDP to read device states and control smart home devices (lights, speakers, etc.)
// using native CDP mouse events (required for Angular Material interactive tiles).
import WebSocket from 'ws'

const CDP_PORT = 9223

async function getHomeTab() {
  let list
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`, { signal: AbortSignal.timeout(3000) })
    list = await res.json()
  } catch {
    throw new Error('דפדפן הבית לא פועל. יש לוודא שחלון Webtop פתוח עם Google Home.')
  }
  const tab = list.find((t) => t.type === 'page' && t.url && t.url.includes('home.google.com'))
  if (!tab) {
    throw new Error('לשונית Google Home לא נמצאה פתוחה בחלון הדפדפן (פורט 9223).')
  }
  return tab
}

async function withHomeSession(fn) {
  const tab = await getHomeTab()
  const ws = new WebSocket(tab.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })

  let reqId = 1
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const curId = reqId++
      const handler = (data) => {
        try {
          const msg = JSON.parse(data.toString())
          if (msg.id === curId) {
            ws.off('message', handler)
            if (msg.error) reject(new Error(msg.error.message))
            else resolve(msg.result)
          }
        } catch (e) {
          reject(e)
        }
      }
      ws.on('message', handler)
      ws.send(JSON.stringify({ id: curId, method, params }))
    })

  try {
    // If any group is collapsed, expand it so all individual device tiles are exposed and clickable
    const expandRes = await send('Runtime.evaluate', {
      expression: `
        (() => {
          const btn = document.querySelector('button.expand-button');
          if (btn && (btn.innerText.includes('keyboard_arrow_down') || btn.getAttribute('title') === 'הרחבה')) {
            const r = btn.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }
          return null;
        })()
      `,
      returnByValue: true,
    })
    if (expandRes?.result?.value) {
      const pos = expandRes.result.value
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
      await new Promise((r) => setTimeout(r, 60))
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
      await new Promise((r) => setTimeout(r, 600))
    }

    return await fn(send)
  } finally {
    ws.close()
  }
}

const PARSE_EXPR = `
  (() => {
    const buttons = Array.from(document.querySelectorAll('button.on-off-tile'));
    return buttons.map((b, idx) => {
      const lines = (b.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
      const title = b.getAttribute('title') || '';
      const isOffline = b.classList.contains('offline') || lines.some(l => l.includes('אופליין'));
      const isActive = b.classList.contains('active') || title === 'השבתה' || lines.some(l => l.includes('מופעל') || l.includes('פועלים'));
      const isGroup = b.classList.contains('group') || lines.includes('light_group');
      
      let name = lines.find(l => !['light_group', 'speaker', 'lightbulb'].includes(l) && !l.includes('מכשירים') && !l.includes('כבויה') && !l.includes('דלוק') && !l.includes('מושבתים') && !l.includes('פועלים') && !l.includes('מופעל') && !l.includes('אופליין')) || lines.join(' ');
      let type = b.className.includes('LIGHT') ? 'אורות' : b.className.includes('SPEAKER') ? 'רמקול' : 'מכשיר';
      const r = b.getBoundingClientRect();
      return {
        index: idx,
        name,
        type,
        title,
        isGroup,
        isOffline,
        status: isOffline ? 'אופליין' : isActive ? 'דלוק' : 'כבוי',
        x: r.left + r.width / 2,
        y: r.top + r.height / 2
      };
    });
  })()
`

async function getParsedDevices(send) {
  const res = await send('Runtime.evaluate', { expression: PARSE_EXPR, returnByValue: true })
  return res?.result?.value || []
}

export async function getHomeDevices() {
  return withHomeSession(async (send) => {
    const all = await getParsedDevices(send)
    // Exclude redundant meta group tiles when individual items exist
    const hasIndividuals = all.some((d) => !d.isGroup && d.type === 'אורות')
    const devices = hasIndividuals ? all.filter((d) => !d.isGroup) : all
    if (!devices.length) return 'לא זוהו מכשירים פעילים בעמוד Google Home'

    const lines = ['🏠 *מכשירי בית חכם (Google Home):*']
    for (const d of devices) {
      const icon = d.type === 'אורות' ? '💡' : d.type === 'רמקול' ? '🔊' : '🔌'
      const stIcon = d.status === 'דלוק' ? '🟢' : d.status === 'אופליין' ? '⚠️' : '⚪'
      lines.push(`• ${icon} *${d.name}* (${d.type}): ${stIcon} ${d.status}`)
    }
    return lines.join('\n')
  })
}

export async function controlHomeDevice(deviceQuery, action = 'toggle') {
  const q = String(deviceQuery || '').trim().toLowerCase()
  let act = String(action || 'toggle').toLowerCase()
  if (['on', 'הדלק', 'להדליק', 'דלוק', 'הדלקה'].includes(act)) act = 'on'
  else if (['off', 'כבה', 'לכבות', 'כבוי', 'כיבוי'].includes(act)) act = 'off'
  else act = 'toggle'

  return withHomeSession(async (send) => {
    const all = await getParsedDevices(send)
    if (!all.length) return 'לא זוהו מכשירים בעמוד Google Home.'

    const hasIndividuals = all.some((d) => !d.isGroup && d.type === 'אורות')
    const parsed = hasIndividuals ? all.filter((d) => !d.isGroup) : all

    const normalize = (s) => (s || '').toLowerCase().replace(/[^a-z0-9א-ת]/g, '')
    const qNorm = normalize(q)

    // Checks for room/all lights
    const isAllRoomLights =
      q.includes('חדר שלי') ||
      q.includes('חדר') ||
      q.includes('אור') ||
      q.includes('אורות') ||
      q.includes('lights')
    const isAllLights = q.includes('כל האורות') || (q.includes('אורות') && (q.includes('כל') || q.length <= 6))
    const isAll = q.includes('הכל') || q === 'all'

    let targets = []
    if (isAllLights || isAll) {
      targets = parsed.filter((p) => (isAll ? true : p.type === 'אורות'))
    } else {
      // Check if user specifically requested a named sub-device (e.g. "mine light", "led", "floor lamp")
      const specificMatches = parsed.filter((p) => {
        const nNorm = normalize(p.name)
        if (q.includes('mine') && p.name.toLowerCase().includes('mine')) return true
        if (q.includes('led') || q.includes('לד')) return p.name.toLowerCase().includes('led')
        if (q.includes('floor') || q.includes('מנורת רצפה') || (q.includes('מנורה') && !q.includes('אור'))) return p.name.toLowerCase().includes('floor')
        if (q.includes('סלון') || q.includes('living')) return p.name.toLowerCase().includes('living') || p.name.toLowerCase().includes('lounge')
        if (q.includes('לאונג') || q.includes('lounge')) return p.name.toLowerCase().includes('lounge')
        return nNorm.includes(qNorm) || (qNorm.length >= 3 && qNorm.includes(nNorm))
      })

      if (specificMatches.length > 0) {
        targets = specificMatches
      } else if (isAllRoomLights) {
        // Default when asking for "אור בחדר" or "חדר שלי Lights" -> all individual room lights!
        targets = parsed.filter((p) => p.type === 'אורות')
      }
    }

    if (!targets.length) {
      return `לא נמצא מכשיר מתאים עבור "${deviceQuery}".\nמכשירים זמינים:\n${parsed.map((p) => `• *${p.name}* (${p.type}): ${p.status}`).join('\n')}`
    }

    const clicked = []
    const unchanged = []
    const offline = []

    for (const t of targets) {
      if (t.isOffline) {
        offline.push(`• *${t.name}*: ⚠️ המכשיר אופליין ולא ניתן לשליטה כרגע`)
        continue
      }

      const currentlyOn = t.status === 'דלוק'
      if (act === 'on' && currentlyOn) {
        unchanged.push(`• *${t.name}* כבר דלוק 🟢`)
        continue
      }
      if (act === 'off' && !currentlyOn) {
        unchanged.push(`• *${t.name}* כבר כבוי ⚪`)
        continue
      }

      // Dispatch native CDP mouse events to trigger Angular Material
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: t.x,
        y: t.y,
        button: 'left',
        clickCount: 1,
      })
      await new Promise((r) => setTimeout(r, 60))
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: t.x,
        y: t.y,
        button: 'left',
        clickCount: 1,
      })
      clicked.push(t)
      await new Promise((r) => setTimeout(r, 150))
    }

    if (clicked.length > 0) {
      // Wait for Google Home to update DOM
      await new Promise((r) => setTimeout(r, 1000))
    }

    const afterDevices = await getParsedDevices(send)
    const lines = []

    for (const c of clicked) {
      const updated = afterDevices.find((p) => p.index === c.index) || c
      const icon = updated.status === 'דלוק' ? '🟢 💡' : '⚪ 🔌'
      lines.push(`• *${updated.name}* שונה בהצלחה למצב: *${updated.status}* ${icon}`)
    }

    lines.push(...unchanged)
    lines.push(...offline)
    return lines.join('\n')
  })
}
