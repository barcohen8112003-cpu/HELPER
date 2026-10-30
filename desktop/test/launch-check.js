// On this PC: a Store app (Calculator) opens through its Start menu entry, shows as a window, and closes.
// Run: node test/launch-check.js
'use strict'
const path = require('path')
const apps = require('../src/apps')
const w = require('../src/win32')
apps.init(path.join(process.env.APPDATA, 'helper-desktop'))
const docs = w.windows().find((x) => x.app === 'explorer' && /מסמכים|Documents/.test(x.title))
if (docs) w.close(docs.hwnd)
setTimeout(() => {
  const calc = apps.find('מחשבון')
  console.log('entry:', calc && calc.id)
  apps.launch(calc)
  setTimeout(() => {
    const list = w.windows()
    const win = list.find((x) => apps.windowMatches(x, 'מחשבון'))
    console.log('window:', win ? `${win.app} | ${win.title}` : 'not found', '\nall:', list.map((x) => x.app).join(', '))
    if (win) w.close(win.hwnd)
    process.exit(win ? 0 : 1)
  }, 3500)
}, 300)
