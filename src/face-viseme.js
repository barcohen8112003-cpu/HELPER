// Mouth shape from a spectrum, used by the in-browser face. No DOM, so the server tests it too.
// Bins are 0..1 magnitudes, low frequencies first (an AnalyserNode byte frequency array, divided by 255).

export const SHAPES = ['closed', 'mbp', 'ee', 'ah', 'oh', 'wide']

function avg(list) {
  if (!list.length) return 0
  let s = 0
  for (const n of list) s += n
  return s / list.length
}

// Returns { shape, open } where open is 0..1. Silence is a closed mouth.
export function visemeFromBins(bins) {
  const b = []
  for (const n of bins || []) {
    const v = Number(n)
    if (Number.isFinite(v)) b.push(Math.max(0, Math.min(1, v)))
  }
  if (!b.length) return { shape: 'closed', open: 0 }
  const level = avg(b)
  if (level < 0.045) return { shape: 'closed', open: 0 }
  const third = Math.max(1, Math.floor(b.length / 3))
  const low = avg(b.slice(0, third))
  const mid = avg(b.slice(third, third * 2))
  const high = avg(b.slice(third * 2))
  const open = Math.max(0.12, Math.min(1, (level - 0.04) / 0.32))
  let shape = 'ah'
  if (high > mid * 1.15 && high > low) shape = open > 0.62 ? 'wide' : 'ee'
  else if (low > mid * 1.05 && low >= high) shape = open > 0.5 ? 'oh' : 'mbp'
  return { shape, open }
}
