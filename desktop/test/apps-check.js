// On this PC: which Start menu entry each spoken name finds. Run: node test/apps-check.js
'use strict'
const path = require('path')
const apps = require('../src/apps')
apps.init(path.join(process.env.APPDATA, 'helper-desktop'))
const names = ['מחשבון', 'המחשבון', 'כרום', 'ספוטיפיי', 'דיסקורד', 'פנקס רשימות', 'נוטפד', 'סייר הקבצים', 'טרמינל', 'וואטסאפ',
  'סטרימיו', 'vlc', 'הגדרות', 'מנהל המשימות', 'קלוד', 'obs', 'סטים', 'טלגרם', 'מייל', 'יומן', 'זום', 'אקסבוקס', 'שורת הפקודה', 'ולורנט']
setTimeout(() => {
  for (const n of names) {
    const a = apps.find(n)
    console.log(n.padEnd(14), '→', a ? a.name.replace(/[‎‏]/g, '') : '—')
  }
  process.exit(0)
}, 300)
