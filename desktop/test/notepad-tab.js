// A fresh, empty Notepad tab for the live checks, and nothing else: Windows 11 Notepad reopens the user's own files
// as tabs, so a check writes only after it has made a new "Untitled" tab and seen that tab in front, and at the end
// empties and closes only that tab.
'use strict'
const { execFile } = require('child_process')
const w = require('../src/win32')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PAD = /(פנקס רשימות|Notepad)/
const UNTITLED = /^(ללא שם|Untitled)(\s|$)/   // not \b: it does not see Hebrew letters as a word
const find = () => w.windows().find((x) => PAD.test(x.title))

let openedByUs = false

async function freshTab() {
  if (!find()) {
    openedByUs = true
    execFile('notepad.exe')
    for (let i = 0; i < 40 && !find(); i++) await sleep(250)
    await sleep(1000)
  }
  const pad = find()
  if (!pad) throw new Error('Notepad did not open')
  w.focus(pad.hwnd)
  await sleep(300)
  w.combo('ctrl+n')
  for (let i = 0; i < 20; i++) {
    await sleep(200)
    const now = find()
    if (now && UNTITLED.test(now.title) && w.isForeground(now.hwnd)) return now
  }
  throw new Error('no fresh Untitled tab in front; not writing anything')
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Empties our tab (so Notepad does not ask to save it) and closes it; Notepad itself closes if the check opened it.
 * Notepad names an untitled tab by its first line, so the words the check wrote there also say "ours".
 */
async function closeTab(wrote = []) {
  const ours = new RegExp('^\\*?(ללא שם|Untitled' + wrote.map((t) => '|' + esc(t)).join('') + ')')
  const pad = find()
  if (!pad || !ours.test(pad.title)) return   // not ours in front: leave everything as it is
  for (let i = 0; i < 5 && !w.isForeground(pad.hwnd); i++) { w.focus(pad.hwnd); await sleep(200) }
  if (!w.isForeground(pad.hwnd)) return
  w.combo('ctrl+a'); w.combo('delete'); await sleep(150)
  w.combo('ctrl+w')
  await sleep(600)
  if (openedByUs) { const p = find(); if (p && UNTITLED.test(p.title)) w.close(p.hwnd) }
}

module.exports = { freshTab, closeTab, find, PAD, UNTITLED }
