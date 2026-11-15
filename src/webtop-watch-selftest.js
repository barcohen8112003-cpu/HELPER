// node src/webtop-watch-selftest.js
// Webtop notices: what counts as new (grades, timetable changes, exams, school events), the silent first read,
// and, in a real Chrome against a stand-in Webtop, that the API answers are taken from the page's own requests.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-webtop-watch-'))
process.env.HELPER_DATA_DIR = tmp
process.env.HELPER_ENV_FILE = path.join(tmp, '.env')
delete process.env.PC_BRIDGE_SECRET
delete process.env.PC_BRIDGE_EXECUTOR

let ok = true
const check = (name, cond, info = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + info : ''}`)
  if (!cond) ok = false
}

const { planWebtopNotice, webtopItems, lessonName } = await import('./webtop-watch.js')

const NOW = new Date(2026, 10, 7, 20, 0) // Saturday 7.11.2026
const grade = (id, g, extra = {}) => ({ evaluationID: id, title: 'מבחן באנגלית', subject: 'אנגלית 4', grade: g, gradeTranslation: null, isDeleted: 0, ...extra })
const read1 = {
  grades: [grade(1, null), grade(2, 90, { subject: 'כימיה 5', title: 'בוחן' })],
  changes: {
    changes: [
      { id: 10, date: '2026-11-08T00:00:00', hour: 1, content: 'ביטול שיעור', group: 'ג`ראמנה סוזן, אנגלית 4,  י\' 1 י\' 2 (רמה: 4  יח``ל)' },
      { id: 11, date: '2026-11-01T00:00:00', hour: 3, content: 'ביטול שיעור', group: 'x, y' },
    ],
    exams: [{ id: 20, title: 'מטלת בגרות ציונות', textualType: 'מטלת בגרות', date: '2026-11-16T00:00:00', from_hour: 3, to_hour: 6 }],
    events: [],
    messages: [],
  },
  school: [],
}

const first = planWebtopNotice(read1, null, NOW)
check('the first read sends nothing', first.text === '' && first.fresh.length === 0)
check('the first read remembers what is there', first.seen.includes('grade:2:90') && first.seen.includes('change:10:ביטול שיעור'))
check('a past change is not listed', !webtopItems(read1, NOW).some((i) => i.key.startsWith('change:11')))
check('an evaluation without a grade is not a grade yet', !first.seen.some((k) => k.startsWith('grade:1:')))
check('the lesson name is subject (teacher)', lessonName(read1.changes.changes[0].group) === "אנגלית 4 (ג'ראמנה סוזן)", lessonName(read1.changes.changes[0].group))

const again = planWebtopNotice(read1, first.seen, NOW)
check('the same read twice sends nothing', again.text === '')

const read2 = structuredClone(read1)
read2.grades[0].grade = 87
read2.changes.changes.push({ id: 12, date: '2026-11-09T00:00:00', hour: 5, content: 'מילוי מקום', group: 'לונדון עינב, מתמ\' 4', room: '403' })
read2.changes.exams.push({ id: 21, title: 'מבחן במתמטיקה', textualType: 'מבחן', date: '2026-11-20T00:00:00', from_hour: 1, to_hour: 2 })
read2.school = [{ date: '2026-11-08T06:00:00.000Z', data: { generalMessages: [{ id: 5, title: 'טקס יום הזיכרון לרבין' }], classes: [{ hours: [{ hour: { hour: 2 }, events: [{ id: 7, title: 'סיור בשכונה' }], exams: [], messages: [], changes: [] }] }] } }]
const second = planWebtopNotice(read2, first.seen, NOW)
check('a grade that was entered is news', second.text.includes('ציון חדש') && second.text.includes('אנגלית 4 - מבחן באנגלית: *87*'), second.text)
check('a new change says the day and the lesson', second.text.includes('יום שני 9.11, שיעור 5: מילוי מקום - מתמ\' 4 (לונדון עינב), חדר 403'))
check('a new exam is news, its type not said twice', second.text.includes('• מבחן במתמטיקה - יום שישי 20.11, שיעורים 1-2'))
check('a school event and a message are news', second.text.includes('סיור בשכונה - מחר, שיעור 2') && second.text.includes('טקס יום הזיכרון לרבין'))
check('old things are not repeated', !second.text.includes('בוחן') && !second.text.includes('ציונות'))
check('everything goes in one message', second.fresh.length === 5, String(second.fresh.length))

const read3 = structuredClone(read2)
read3.grades[1].grade = 95
const third = planWebtopNotice(read3, second.seen, NOW)
check('a changed grade is said to be updated', third.text.includes('ציון עודכן') && third.text.includes('עודכן: כימיה 5 - בוחן: *95*'), third.text)

const partial = planWebtopNotice({ grades: null, changes: null, school: [] }, second.seen, NOW)
check('a read with nothing in it forgets nothing', partial.text === '' && partial.seen.length === second.seen.length)

// --- A real Chrome against a stand-in Webtop: the answers come from the page's own API requests. ---
const chrome = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean).find((p) => fs.existsSync(p))
if (!chrome) {
  console.log('skip: no Chrome found for the browser part')
} else {
  const PORT = 9361
  const WEB = 9362
  const asked = []
  const page = (api, body) => `<!doctype html><meta charset="utf-8"><body dir="rtl"><h1>Webtop</h1><p>כרטיס תלמיד</p><script>
    fetch('/server/api/${api}', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(${JSON.stringify(body)}) })
  </script></body>`
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const json = (data) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: true, data }))
      }
      if (req.url.startsWith('/server/api/')) asked.push({ url: req.url, body })
      if (req.url === '/server/api/shotef/ChangesAndMessagesData') return json(read2.changes)
      if (req.url === '/server/api/PupilCard/GetPupilGrades') return json(read2.grades)
      // Synthetic: the shape of this answer is a guess (it is not documented); schoolwork.js refuses shapes it does not know.
      if (req.url === '/server/api/dashboard/GetHomeWork') return json([{ id: 77, subjectName: 'ספרות', homeWork: 'לקרוא את הסיפור "הדרך" עד עמוד 30', dueDate: '2026-11-12T00:00:00' }])
      // Today's board has the event and the message, tomorrow's is empty.
      if (req.url === '/server/api/shotef/SchoolchangesPerGradeFirst') return json(asked.filter((a) => a.url === req.url).length === 1 ? read2.school[0].data : { generalMessages: [], classes: [] })
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      if (req.url.startsWith('/Timetable_Changes')) return res.end(page('shotef/ChangesAndMessagesData', { institutionCode: 340018, selectedValue: '10|6', typeView: 1, todayOnly: false, startWeek: false }))
      if (req.url.startsWith('/Student_Card')) return res.end(page('PupilCard/GetPupilGrades', { studyYear: 2027, moduleID: 6 }))
      if (req.url.startsWith('/dashboard')) return res.end(page('dashboard/GetHomeWork', { id: 'SYNTHETIC-ENCRYPTED-ID', ClassCode: 10, ClassNumber: 6 }))
      res.end('<!doctype html><meta charset="utf-8"><body>ריכוז מידע</body>')
    })
  }).listen(WEB, '127.0.0.1')
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-webtop-watch-chrome-'))
  const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--disable-dev-shm-usage', ...(process.platform === 'linux' ? ['--no-sandbox'] : []), `http://127.0.0.1:${WEB}/`], { stdio: 'ignore' })
  try {
    let up = false
    for (let i = 0; i < 120 && !up; i++) {
      try {
        up = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).some((t) => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${WEB}`))
      } catch {}
      if (!up) await new Promise((r) => setTimeout(r, 250))
    }
    if (!up) throw new Error(`Chrome did not start (${chrome})`)
    const { config } = await import('./config.js')
    config.webtop.port = PORT
    config.webtop.cloud = false
    config.webtop.url = `http://127.0.0.1:${WEB}/`
    const { readWebtopUpdates } = await import('./session.js')
    const got = await readWebtopUpdates()
    check('grades come from the grades page request', got.grades?.length === 2 && got.grades[0].grade === 87)
    check('changes and exams come from the timetable page request', got.changes?.changes?.length === 3 && got.changes.exams.length === 2)
    check('the school board is asked for today and tomorrow', got.school.length === 2 && got.school[0].data.generalMessages[0].id === 5)
    const sb = asked.filter((a) => a.url.endsWith('SchoolchangesPerGradeFirst')).map((a) => JSON.parse(a.body))
    check('with the school code and grade from the page request', sb.length === 2 && sb[0].institutionCode === 340018 && sb[0].grade === 10, JSON.stringify(sb[0]))
    const plan = planWebtopNotice(got, first.seen, NOW)
    check('the browser read gives the same notice', plan.fresh.length === 5, String(plan.fresh.length))
    check('without the homework list on, the homework board is not asked for', got.homework === undefined && !asked.some((a) => a.url.endsWith('dashboard/GetHomeWork')))
    const withHw = await readWebtopUpdates({ homework: true })
    const hwAsk = asked.filter((a) => a.url.endsWith('dashboard/GetHomeWork'))
    check('with it, the board comes from the dashboard page\'s own request', withHw.homework?.asked === true && withHw.homework.data?.[0]?.homeWork?.includes('הדרך') && hwAsk.length === 1, JSON.stringify(withHw.homework))
    check('the board request is the page\'s own (its ids, not ones Helper made up)', JSON.parse(hwAsk[0].body).id === 'SYNTHETIC-ENCRYPTED-ID')
    check('the rest of the read is unchanged with the board added', withHw.grades?.length === 2 && withHw.changes?.exams?.length === 2)
    const { webtopHomework } = await import('./schoolwork.js')
    const parsed = webtopHomework(withHw.homework)
    check('the board answer is parsed into homework', parsed.entries?.[0]?.title === 'לקרוא את הסיפור "הדרך" עד עמוד 30' && parsed.entries[0].course === 'ספרות' && parsed.entries[0].due.day === '2026-11-12', JSON.stringify(parsed))
    config.webtop.homeworkPath = '/no-homework-here'
    const silent = await readWebtopUpdates({ homework: true })
    check('a page that does not ask for the board gives "not answered", not an empty board', silent.homework?.asked === true && silent.homework.data === undefined && Boolean(webtopHomework(silent.homework).error))
  } catch (e) {
    check('browser part ran', false, e.message)
  } finally {
    proc.kill()
    server.close()
  }
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(ok ? 'PASS' : 'FAIL')
process.exit(ok ? 0 : 1)
