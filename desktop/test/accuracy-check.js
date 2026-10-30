// Transcription accuracy, measured. 30 Hebrew commands are spoken by Windows' Hebrew voice, then degraded the way a
// voice changer does (pitch shifted down, echo, pink noise, quiet), and sent through the same path the app uses
// (src/speech.js: prepare → whisper → clean). For each: the word error rate against what was said, and whether the
// text still means the same command (src/instant.js gives the same steps). Needs HELPER running (the speech
// server), ffmpeg and Windows' Hebrew voice. Run: node test/accuracy-check.js [--variant=clean|changer|both]
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const speech = require('../src/speech')
const instant = require('../src/instant')

const root = path.join(__dirname, '..')
const cache = path.join(os.tmpdir(), 'helper-accuracy')
fs.mkdirSync(cache, { recursive: true })

const PHRASES = [
  'תפתח את ספוטיפיי', 'תפתח את כרום ותשים אותו בצד שמאל', 'תסגור את דיסקורד', 'תפעיל ביוטיוב את השיר נתתי לך בית',
  'תגביר את הווליום', 'תנמיך קצת', 'השתק', 'השיר הבא', 'תעצור את המוזיקה', 'מה השעה',
  'תפתח את המחשבון', 'תעביר את דיסקורד למסך השני', 'תגדיל את כרום', 'תמזער את הכל', 'תחפש מתכון לשקשוקה',
  'חפש ביוטיוב לופי', 'תנגן אופק אדנק', 'תפתח את וואטסאפ', 'תפתח את סטרימיו', 'תשים את ספוטיפיי בצד ימין',
  'תסגור את כרום', 'תפתח את פנקס הרשימות', 'תפתח את הגדרות', 'תנעל את המחשב', 'ווליום שלושים',
  'תפתח את טלגרם ואת דיסקורד', 'תפעיל לי שיר של עומר אדם', 'תחפש במפות פיצה בחיפה', 'תפתח את מנהל המשימות', 'תשים את הכרום בצד שמאל של המסך השני',
]

const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })

/** Windows' Hebrew voice → 16 kHz mono WAV, cached. */
function speak(i) {
  const out = path.join(cache, `p${i}-clean.wav`)
  if (fs.existsSync(out)) return out
  const raw = path.join(cache, `p${i}-raw.wav`)
  const r = sh('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'src', 'say.ps1'), '-Text', PHRASES[i], '-Out', raw]).toString()
  if (!/OK/.test(r)) throw new Error('no Hebrew voice')
  sh('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-af', 'apad=pad_dur=0.5', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', out])
  return out
}

/** What a voice changer does to a voice: pitch down, a little echo, noise, and a quiet level. */
function changer(i) {
  const out = path.join(cache, `p${i}-changer.wav`)
  if (fs.existsSync(out)) return out
  sh('ffmpeg', ['-y', '-loglevel', 'error', '-i', speak(i), '-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.02:sample_rate=16000',
    '-filter_complex', '[0:a]asetrate=16000*0.82,aresample=16000,atempo=1.22,aecho=0.8:0.6:35:0.25,volume=0.12[a];[1:a]volume=0.6[n];[a][n]amix=inputs=2:duration=first:normalize=0',
    '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', out])
  return out
}

const words = (s) => String(s).replace(/[.,!?״"׳']/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
function wer(truth, heard) {
  const a = words(truth), b = words(heard)
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length][b.length] / Math.max(1, a.length)
}
const steps = (t) => JSON.stringify((instant.parse(t) || {}).steps || null)

async function run(variant) {
  let exact = 0, sameCommand = 0, werSum = 0
  const misses = []
  for (let i = 0; i < PHRASES.length; i++) {
    const wav = fs.readFileSync(variant === 'clean' ? speak(i) : changer(i))
    let heard = ''
    try {
      if (process.env.HELPER_BEST) heard = await speech.transcribeBest(root, wav, [speech.HINTS, '', 'כרום, דיסקורד, ספוטיפיי, וואטסאפ, סטרימיו, טלגרם, ביוטיוב, ווליום, תפתח, תסגור, תשים, תעביר'], (x) => Boolean(instant.parse(x) && instant.parse(x).steps))
      else heard = await speech.transcribe(root, wav, process.env.HELPER_PROMPT !== undefined ? process.env.HELPER_PROMPT : speech.HINTS)
    } catch (e) { heard = '' }
    const e = wer(PHRASES[i], heard)
    werSum += e
    if (e === 0) exact++
    const ok = steps(heard) === steps(PHRASES[i]) && steps(PHRASES[i]) !== 'null'
    if (ok) sameCommand++
    if (!ok) misses.push(`   "${PHRASES[i]}" → "${heard}"`)
  }
  const n = PHRASES.length
  console.log(`${variant.padEnd(8)} exact ${exact}/${n} | same command ${sameCommand}/${n} | word error rate ${(werSum / n * 100).toFixed(1)}%`)
  if (process.argv.includes('--misses')) console.log(misses.join('\n'))
  return { exact, sameCommand, wer: werSum / n }
}

;(async () => {
  const pick = (process.argv.find((a) => a.startsWith('--variant=')) || '--variant=both').slice(10)
  const apps = require('../src/apps')
  apps.init(path.join(process.env.APPDATA, 'helper-desktop'))
  await new Promise((r) => setTimeout(r, 300))
  speech.setVocabulary(apps.vocabulary())
  await speech.start(root)
  const out = {}
  if (pick !== 'changer') out.clean = await run('clean')
  if (pick !== 'clean') out.changer = await run('changer')
  fs.writeFileSync(path.join(cache, 'last-result.json'), JSON.stringify(out))
})()
