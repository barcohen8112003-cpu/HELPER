// The only bridge between HELPER's windows and the app: a few named messages, nothing else.
'use strict'
const { contextBridge, ipcRenderer } = require('electron')

const IN = new Set(['state', 'record', 'play', 'overlay', 'live'])
const OUT = new Set(['audio', 'typed', 'confirm', 'hover', 'dismiss', 'mark', 'mark-cancel', 'voice-state', 'mics', 'partial', 'endpoint'])

contextBridge.exposeInMainWorld('helper', {
  on: (channel, fn) => { if (IN.has(channel)) ipcRenderer.on(channel, (e, data) => fn(data)) },
  send: (channel, data) => { if (OUT.has(channel)) ipcRenderer.send(channel, data) },
})
