// The microphone, for asks and dictation: 16 kHz mono, the format the speech model takes, sent as a WAV when it ends.
// level() gives the loudness for the waves. While recording it also listens for speech: hooks.onSpeech when talking
// starts, hooks.onQuiet when a pause begins, hooks.onEnd when the user has stopped talking (or never started).
'use strict'
window.Recorder = (() => {
  let stream = null, ctx = null, node = null, src = null
  let chunks = [], level = 0, purpose = 'ask', recording = false
  let hooks = {}
  // Speech detection, on 8 ms blocks: a noise floor that follows the room, speech when well above it.
  let samples = 0, floor = 0.004, speechMs = 0, started = false, lastLoud = 0, quietSent = false, ended = false
  const END_QUIET_MS = 750      // this long quiet after speech: the user is done
  const NO_SPEECH_MS = 8000     // nothing said this long: give up
  const MAX_MS = 45000

  async function start(p, micName, h) {
    purpose = p || 'ask'
    chunks = []
    recording = true
    hooks = h || {}
    samples = 0; floor = 0.004; speechMs = 0; started = false; lastLoud = 0; quietSent = false; ended = false
    try {
      let audioConstraints = { channelCount: 1, autoGainControl: true }
      try {
        const devs = await navigator.mediaDevices.enumerateDevices()
        const inputs = devs.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
        if (window.helper) helper.send('mics', inputs.map((d) => d.label))
        const vm = micName ? inputs.find((d) => d.label.toLowerCase().includes(String(micName).toLowerCase())) : null
        if (vm) {
          // A chosen microphone as it is: WebRTC's echo cancelling and noise suppression flatten virtual
          // devices (Voicemod) and add nothing for a real one that already cleans its own sound.
          audioConstraints = {
            deviceId: { exact: vm.deviceId },
            channelCount: 1,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: true,
          }
        } else {
          audioConstraints.echoCancellation = true
          audioConstraints.noiseSuppression = true
        }
      } catch { }
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints })
      // Which microphone opened, in the app log: with several (virtual ones too) this is the first thing to know.
      const track = stream.getAudioTracks()[0]
      // Names are only filled in once a microphone has been opened: send the list again, for the tray menu.
      try { const all = await navigator.mediaDevices.enumerateDevices(); if (window.helper) helper.send('mics', all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d) => d.label)) } catch { }
      if (window.helper) helper.send('voice-state', 'mic: ' + (track ? track.label : 'none'))
    } catch (e) {
      recording = false
      if (window.helper) helper.send('voice-state', 'mic failed: ' + e.name + ' ' + e.message)
      throw e
    }
    if (!recording) { close(); return }   // let go before the microphone opened
    ctx = new AudioContext({ sampleRate: 16000 })
    await ctx.audioWorklet.addModule('recorder-worklet.js')
    if (!recording) { close(); return }
    src = ctx.createMediaStreamSource(stream)
    node = new AudioWorkletNode(ctx, 'helper-tap')
    node.port.onmessage = (e) => {
      if (!recording) return
      const data = e.data
      chunks.push(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
      const rms = Math.sqrt(sum / data.length)
      level = Math.min(1, rms * 6)
      samples += data.length
      listen(rms, data.length, ctx.sampleRate)
    }
    src.connect(node)
  }

  function listen(rms, n, rate) {
    const ms = (samples / rate) * 1000
    if (ms < 250 || ended) return   // the start tone, and the microphone settling
    const threshold = Math.max(0.012, floor * 3.5)
    const loud = rms > threshold
    if (!loud) floor = rms < floor ? floor * 0.9 + rms * 0.1 : floor * 0.998 + rms * 0.002
    const block = (n / rate) * 1000
    speechMs = Math.max(0, speechMs + (loud ? block : -block / 2))
    if (loud && speechMs > 40) { lastLoud = samples; quietSent = false }
    if (!started && speechMs >= 120) { started = true; hooks.onSpeech && hooks.onSpeech() }
    const quietMs = ((samples - lastLoud) / rate) * 1000
    if (started && !quietSent && quietMs >= 250) { quietSent = true; hooks.onQuiet && hooks.onQuiet() }
    if ((started && quietMs >= END_QUIET_MS) || (!started && ms >= NO_SPEECH_MS) || ms >= MAX_MS) {
      ended = true
      hooks.onEnd && hooks.onEnd()
    }
  }

  /** The recording so far as a WAV, without ending it (for the live transcript). */
  function snapshot() {
    if (!chunks.length) return null
    return { wav: toWav(), samples, lastLoud }
  }

  function toWav() {
    const n = chunks.reduce((a, c) => a + c.length, 0)
    const pcm = new Int16Array(n)
    let o = 0
    for (const c of chunks) for (let i = 0; i < c.length; i++) pcm[o++] = Math.max(-1, Math.min(1, c[i])) * 0x7fff
    return wav(pcm, ctx ? ctx.sampleRate : 16000)
  }

  function close() {
    try { node && node.disconnect() } catch { }
    try { src && src.disconnect() } catch { }
    try { ctx && ctx.close() } catch { }
    if (stream) stream.getTracks().forEach((t) => t.stop())
    stream = ctx = node = src = null
    level = 0
  }

  /** Ends the recording; resolves the WAV bytes (an ArrayBuffer), or null when cancelled. */
  function stop(cancel) {
    recording = false
    hooks = {}
    if (cancel) { close(); chunks = []; return null }
    const out = toWav()
    close()
    chunks = []
    return out
  }

  function wav(pcm, rate) {
    const buf = new ArrayBuffer(44 + pcm.length * 2)
    const v = new DataView(buf)
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
    str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE')
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
    str(36, 'data'); v.setUint32(40, pcm.length * 2, true)
    new Int16Array(buf, 44).set(pcm)
    return buf
  }

  return { start, stop, snapshot, lastLoud: () => lastLoud, level: () => level, purpose: () => purpose, recording: () => recording }
})()
