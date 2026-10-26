// The TV as a body for the goal agent (computer-use.js): each step the HELPER home screen on the TV sends a numbered
// list of what is on the screen (and a picture when asked), and the model picks one remote-style action. Nothing here
// knows any app: "play Napoleon in Stremio", "find the next episode", "turn on subtitles" are worked out from the screen.
import { tvCall, matchApp } from './tv-app.js'
import { runGoal } from './computer-use.js'

// Buttons in TV apps that spend money or sign up: renting, buying, subscribing, a free trial that bills later.
const TV_COMMIT = /\b(rent|buy|purchase|subscribe|start (your )?(free )?trial|upgrade)\b|השכר|השכרה|קני(ה|יה)|לקנות|רכישה|מנוי|הרשמה|ניסיון חינם/i

const KEYS = /^(up|down|left|right|ok|back|home|play_pause|play|pause|stop|next|previous|rewind|fast_forward|mute|volume_up|volume_down)$/

/** One line per element: [3] "Napoleon" (focused, click) id=title @ 120,80,600,140 */
export function formatTvNodes(nodes = []) {
  return nodes
    .map((n) => {
      const name = [n.text, n.desc && n.desc !== n.text ? n.desc : ''].filter(Boolean).join(' | ')
      const flags = ['focused', 'selected', 'editable', 'click'].filter((k) => n[k])
      return `[${n.i}] ${name ? `"${name}"` : '(no text)'}${flags.length ? ` (${flags.join(', ')})` : ''}${n.id ? ` id=${n.id}` : ''} @ ${n.box || ''}`
    })
    .join('\n')
}

export function tvBody({ call = tvCall } = {}) {
  let last = { nodes: [], pkg: '' }
  let wantImage = false
  const picture = async () => {
    const r = await call('capture', { width: 960 })
    return r?.image ? { image: `data:image/jpeg;base64,${r.image}`, buffer: Buffer.from(r.image, 'base64'), mime: 'image/jpeg' } : null
  }
  return {
    name: 'tv',
    intro: `You operate the user's TV in the living room (Android TV / Google TV, driven with a remote: arrows, OK, back)
through the HELPER home screen on it, to carry out what he asked. Each turn you get a numbered list of what is on the
screen and which element has the focus, and sometimes a screenshot. Choose exactly ONE next action.`,
    actions: `Action types:
- {"type": "select", "index": <n>}                 choose element [n] (clicks it, or focuses it and presses OK)
- {"type": "key", "keys": "up|down|left|right|ok|back|home|play_pause|play|pause|stop|next|previous|rewind|fast_forward|mute|volume_up|volume_down", "times": <1-20>}
- {"type": "type", "text": "<text>", "index": <n>}  sets the text of a search field (index optional: the focused field)
- {"type": "scroll", "direction": "down|up", "index": <n>}
- {"type": "open_app", "name": "<app name>"}        e.g. Stremio, YouTube, Netflix, Disney+
- {"type": "open_url", "url": "<link>", "app": "<app name, optional>"}   a link straight into an app
- {"type": "look"}                                  your next observation includes a screenshot (when the list is not enough: video, posters, a player)
- {"type": "wait", "amount": <seconds 1-10>}`,
    tips: `Start with open_app or open_url when one fits, instead of walking menus from Home.
Links that work: Stremio movie page stremio:///detail/movie/<imdb id>, series stremio:///detail/series/<imdb id>,
Stremio search stremio:///search?search=<words>; YouTube https://www.youtube.com/results?search_query=<words>.
Titles in apps are mostly in English: search "Napoleon", not "נפוליאון".
Prefer "select" by index; when an element has no index, move the focus with the arrows and press OK.
In Stremio, a movie page lists sources (streams); pick the first one that looks playable (higher quality is fine) and
it starts. Playing a video, pausing, opening apps and searching never need a gate.
Buying or renting in a store app, subscribing and deleting are commits: gate them.
"done" once the screen shows the thing playing or open (look at a screenshot to be sure a video plays).
Add "step": 2-4 Hebrew words of what you are doing now ("מחפש את הסרט", "בוחר מקור").`,
    maxSteps: 35,
    commit: TV_COMMIT,
    finalShot: false,
    async screenshot() {
      const r = await call('observe')
      last = { nodes: Array.isArray(r.nodes) ? r.nodes : [], pkg: String(r.pkg || '') }
      let shot = null
      // A player or a poster wall says little as a list: the picture is needed then.
      if (wantImage || last.nodes.length < 3) shot = await picture().catch(() => null)
      wantImage = false
      const text = `App: ${r.label || last.pkg || 'Home'} (${last.pkg || '-'})  Screen ${r.width}x${r.height}\n${formatTvNodes(last.nodes) || '(no readable elements)'}`
      const out = { text, width: r.width, height: r.height, scale: 1, left: 0, top: 0, pkg: last.pkg, url: '' }
      if (shot) Object.assign(out, shot)
      return out
    },
    capture: () => picture(),
    async act(a) {
      if (a.type === 'look') return void (wantImage = true)
      if (a.type === 'open_app' || (a.type === 'open_url' && a.app)) {
        const { apps = [] } = await call('apps')
        const app = matchApp(apps, a.name || a.app)
        if (!app) throw new Error(`אין בטלוויזיה אפליקציה בשם ${a.name || a.app}`)
        if (a.type === 'open_app') return void (await call('open_app', { pkg: app.pkg }))
        return void (await call('open_url', { url: String(a.url), pkg: app.pkg }))
      }
      if (a.type === 'open_url') return void (await call('open_url', { url: String(a.url), pkg: '' }))
      if (a.type === 'key') {
        const key = String(a.keys || a.key || '').toLowerCase().trim()
        if (!KEYS.test(key)) throw new Error(`אין כפתור ${key}`)
        return void (await call('act', { type: 'key', keys: key, times: Math.max(1, Math.min(20, Number(a.times) || 1)) }))
      }
      if (['select', 'tap', 'type', 'scroll'].includes(a.type)) {
        const r = await call('act', a)
        return r?.info ? String(r.info) : ''
      }
      throw new Error(`פעולה לא מוכרת בטלוויזיה: ${a.type}`)
    },
    // What a select lands on, from the last list (never from the model), for the safety check on buying.
    async probe(a) {
      const n = last.nodes.find((x) => x.i === a.index)
      return n ? { label: [n.text, n.desc].filter(Boolean).join(' ').slice(0, 120), secret: false } : null
    },
  }
}

/** A task on the TV: open, find, play, set. Returns the agent's DONE / NEED_USER / FAIL line. */
export const runOnTv = (goal, ctx = {}, { call, think } = {}) => runGoal({ goal, body: tvBody({ call }), ctx, think })
