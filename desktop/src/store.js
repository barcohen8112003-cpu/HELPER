// What HELPER for Windows keeps on this PC, under %APPDATA%\helper-desktop: settings, what you asked it to remember,
// the shortcuts it learned, and a log of each ask (what was asked, what ran, how long it took).
'use strict'
const fs = require('fs')
const path = require('path')

let dir = null

const DEFAULTS = {
  helperUrl: 'http://37.60.240.231:3210',
  helperToken: '',
  model: 'haiku',              // haiku: fast; sonnet: for harder work
  micName: 'voicemod',         // part of the microphone's name; empty: Windows' default
  speakAnswers: true,          // a spoken answer to a spoken ask: HELPER's voice from the cloud, Windows' Hebrew voice offline
  talkKey: 'pagedown',         // hold or press PageDown (PD) / Ctrl+Alt+Q
  dictationKey: 'rightctrl',   // hold to dictate
  pointKey: 'ctrl+alt+p',
  startAtLogin: true,
}

function init(dataDir) {
  dir = dataDir
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(path.join(dir, 'work'), { recursive: true })
}

function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) } catch { return fallback }
}

function writeJson(name, value) {
  const file = path.join(dir, name)
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2))
  fs.renameSync(file + '.tmp', file)
}

const settings = () => Object.assign({}, DEFAULTS, readJson('settings.json', {}))
const saveSettings = (patch) => writeJson('settings.json', Object.assign(settings(), patch))

// ---- memory: short facts, said with "תזכור ש..." -------------------------------------------------

function memory() {
  return readJson('memory.json', [])
}

function remember(fact) {
  const list = memory().filter((m) => m.text !== fact)
  list.push({ text: fact, at: new Date().toISOString() })
  writeJson('memory.json', list.slice(-200))
}

function forget(words) {
  const before = memory()
  const after = before.filter((m) => !m.text.includes(words))
  writeJson('memory.json', after)
  return before.length - after.length
}

// ---- learned shortcuts: a phrase → the steps that did it --------------------------------------------

/** Lowercase, no punctuation, no polite words: "תפתח בבקשה את כרום!" → "תפתח את כרום". */
function normalize(s) {
  return String(s).toLowerCase()
    .replace(/[״"'׳.,!?:;()\[\]{}]/g, ' ')
    .replace(/(^|\s)(בבקשה|אפשר|תוכל|תוכלי|רגע|יאללה|בוא|תעשה לי|לי)(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

function learned() {
  return readJson('learned.json', {})
}

/** steps: [{cmd, args}] for the hands (hands.js), or {say} for a phrase that is another command. */
function learn(phrase, steps, source) {
  const all = learned()
  all[normalize(phrase)] = { phrase, steps, source, at: new Date().toISOString(), uses: 0 }
  writeJson('learned.json', all)
}

function unlearn(phrase) {
  const all = learned()
  const key = normalize(phrase)
  if (!all[key]) return false
  delete all[key]
  writeJson('learned.json', all)
  return true
}

function lookup(phrase) {
  const all = learned()
  const hit = all[normalize(phrase)]
  if (!hit) return null
  hit.uses = (hit.uses || 0) + 1
  writeJson('learned.json', all)
  return hit
}

function log(entry) {
  try {
    fs.appendFileSync(path.join(dir, 'asks.jsonl'), JSON.stringify(Object.assign({ at: new Date().toISOString() }, entry)) + '\n')
  } catch { /* the log is a convenience */ }
}

module.exports = { init, settings, saveSettings, memory, remember, forget, learned, learn, unlearn, lookup, normalize, log, dir: () => dir, workDir: () => path.join(dir, 'work') }
