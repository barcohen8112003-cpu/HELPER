// The avatar's feel for music: from a stream of loudness numbers (Windows' own peak meter on the speakers, 0..1,
// about 30 a second) to how hard to dance, when the beat hits and roughly how fast the song is.
//
// It only ever sees one number at a time. No audio, no samples, no song information: the number is the peak that
// Windows already worked out for its volume mixer. Nothing is kept beyond a few running averages and the times of
// the last few beats, and nothing here writes, logs or sends anything.
//
//   energy  0..1, the loudness of the last half second or so, after auto-gain (so 20% volume and 100% volume both use the whole range)
//   beat    true on a frame where the loudness jumps (an onset: a kick, a snare, a loud chord)
//   level   0 | 1 | 2, energy in three steps (quiet / medium / loud) that only changes after it held for a while,
//           so the avatar's dance doesn't flip between moves every frame
//   bpm     the tempo from the last beats (70..180), or 0 while it isn't sure; changes only by more than 8%, and at
//           most every few seconds
'use strict'

const FLOOR = 0.008            // below this the speakers are as good as silent
const MIN_PEAK = 0.03          // auto-gain never boosts more than 1 / MIN_PEAK
const PEAK_HALF_MS = 4000      // the running max halves in this long, so a quieter song is caught up with
const TAU_FAST = 30            // ms, the fast follower (what's happening now)
const TAU_SLOW = 400           // ms, the slow follower (the loudness around now)
const TAU_ENERGY_UP = 150, TAU_ENERGY_DOWN = 600   // ms, how fast energy rises and falls
const ONSET_RATIO = 1.35
const ONSET_MIN = 0.15         // a beat needs at least this much (after auto-gain)
const MIN_BEAT_GAP = 280       // ms: no two beats closer than this (about 214 BPM)
const MIN_BPM = 70, MAX_BPM = 180
const TEMPO_BEATS = 8          // the median of up to this many gaps between beats
const TEMPO_MIN_GAPS = 4
const TEMPO_HOLD_MS = 4000
const TEMPO_CHANGE = 0.08
const LEVEL_HOLD_MS = 1500
const LEVEL_EDGES = [0.3, 0.6]  // energy below the first is quiet, above the second is loud
const LEVEL_MARGIN = 0.04
const MAX_DT = 500             // a longer gap between numbers (the meter was paused) restarts the followers

const round = (x, step) => Math.round(x / step) * step
const median = (a) => { const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

function createBeat() {
  let peak = MIN_PEAK, fast = 0, slow = 0, energy = 0
  let lastT = null, lastBeat = -Infinity, gaps = []
  let bpm = 0, bpmAt = -Infinity
  let level = 0, levelSince = null

  function reset() {
    peak = MIN_PEAK; fast = 0; slow = 0; energy = 0
    lastT = null; lastBeat = -Infinity; gaps = []
    bpm = 0; bpmAt = -Infinity
    level = 0; levelSince = null
  }

  /** One loudness number at time t (ms). Returns { energy, beat, level, bpm }, or null for a number that isn't one. */
  function push(x, t) {
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1) return null
    if (typeof t !== 'number' || !Number.isFinite(t)) return null
    const first = lastT == null || t - lastT > MAX_DT   // the start, or the meter was paused: no jump from zero
    let dt = first ? 33 : t - lastT
    if (dt < 0) return null
    lastT = t

    // Auto-gain: a running max that slowly falls, never below MIN_PEAK.
    peak = Math.max(x, MIN_PEAK, peak * Math.pow(0.5, dt / PEAK_HALF_MS))
    const n = x < FLOOR ? 0 : Math.min(1, x / peak)

    if (first) { fast = n; slow = n }
    const prevFast = fast
    fast += (n - fast) * (1 - Math.exp(-dt / TAU_FAST))
    slow += (n - slow) * (1 - Math.exp(-dt / TAU_SLOW))
    energy += (n - energy) * (1 - Math.exp(-dt / (n > energy ? TAU_ENERGY_UP : TAU_ENERGY_DOWN)))

    let beat = false
    if (fast > ONSET_MIN && fast > slow * ONSET_RATIO + 0.03 && fast > prevFast && t - lastBeat >= MIN_BEAT_GAP) {
      beat = true
      const gap = t - lastBeat
      if (gap > 60000 / MAX_BPM * 0.98 && gap < 60000 / MIN_BPM * 1.02) {
        gaps.push(gap)
        if (gaps.length > TEMPO_BEATS) gaps.shift()
      } else if (gap > 2000) gaps = []
      lastBeat = t
      if (gaps.length >= TEMPO_MIN_GAPS) {
        const est = Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(60000 / median(gaps))))
        if (!bpm || (Math.abs(est - bpm) / bpm > TEMPO_CHANGE && t - bpmAt >= TEMPO_HOLD_MS)) { bpm = est; bpmAt = t }
      }
    }
    if (t - lastBeat > 4000) { gaps = []; if (bpm && t - lastBeat > 8000) bpm = 0 }

    // Three steps with a margin around each edge, so energy hovering on an edge doesn't count as a change.
    let want = level
    while (want < 2 && energy >= LEVEL_EDGES[want] + LEVEL_MARGIN) want++
    while (want > 0 && energy < LEVEL_EDGES[want - 1] - LEVEL_MARGIN) want--
    if (want === level) levelSince = null
    else if (levelSince == null) levelSince = t
    else if (t - levelSince >= LEVEL_HOLD_MS) { level = want; levelSince = null }

    return { energy: Number(Math.max(0, Math.min(1, round(energy, 0.05))).toFixed(2)), beat, level, bpm }
  }

  return { push, reset }
}

module.exports = { createBeat, FLOOR, MIN_BEAT_GAP, MIN_BPM, MAX_BPM, LEVEL_HOLD_MS }
