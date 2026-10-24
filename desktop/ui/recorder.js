// The microphone, for asks and dictation: 16 kHz mono, the format the speech model takes, sent as a WAV when the key
// is let go. The microphone is open only while the key is held. level() gives the loudness for the waves.
'use strict'
window.Recorder = (() => {
  let stream = null, ctx = null, node = null, src = null
  let chunks = [], level = 0, purpose = 'ask', recording = false

  async function start(p) {
    purpose = p || 'ask'
    chunks = []
    recording = true
    try {
      let audioConstraints = { channelCount: 1, autoGainControl: true }
      try {
        const devs = await navigator.mediaDevices.enumerateDevices()
        const vm = devs.find((d) => d.kind === 'audioinput' && /voicemod/i.test(d.label))
        if (vm) {
          // Voicemod handles its own audio processing. WebRTC's echoCancellation and noiseSuppression
          // aggressively attenuate modulated/virtual audio streams, so turn them off for Voicemod.
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
      level = Math.min(1, Math.sqrt(sum / data.length) * 6)
    }
    src.connect(node)
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
    const rate = ctx ? ctx.sampleRate : 16000
    close()
    if (cancel) { chunks = []; return null }
    const n = chunks.reduce((a, c) => a + c.length, 0)
    const pcm = new Int16Array(n)
    let o = 0
    for (const c of chunks) for (let i = 0; i < c.length; i++) pcm[o++] = Math.max(-1, Math.min(1, c[i])) * 0x7fff
    chunks = []
    return wav(pcm, rate)
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

  return { start, stop, level: () => level, purpose: () => purpose, recording: () => recording }
})()
