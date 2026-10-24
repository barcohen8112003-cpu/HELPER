// A stand-in for Claude Code in HELPER's brain tests: takes the same arguments, reads the ask on stdin, checks what
// HELPER gave it (the hands, the rules, the permissions), uses the hands like Claude would, and answers in Claude
// Code's stream-json. Set HELPER_CLAUDE_EXE to this file before starting HELPER.
'use strict'
const fs = require('fs')
const { execFileSync } = require('child_process')

const args = process.argv.slice(2)
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const fail = (why) => { out({ type: 'result', subtype: 'error', is_error: true, result: 'fake-claude: ' + why, session_id: 's-fake' }); process.exit(0) }

let prompt = ''
process.stdin.on('data', (d) => { prompt += d })
process.stdin.on('end', () => {
  // What HELPER must pass, as the real Claude Code needs it.
  const need = ['-p', '--output-format', 'stream-json', '--verbose', '--model', '--append-system-prompt-file', '--allowedTools', '--disallowedTools', '--max-turns']
  for (const n of need) if (!args.includes(n)) return fail('missing ' + n)
  const sys = fs.readFileSync(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8')
  if (!/confirm/.test(sys) || !/hands\.mjs/.test(sys) || !/HELPER/.test(sys)) return fail('the system prompt lacks the hands or the rules')
  const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'))
  const bash = allowed.find((a) => /^Bash\(node .*hands\.mjs:\*\)$/.test(a))
  if (!bash) return fail('no Bash permission for the hands: ' + allowed.join(' '))
  if (allowed.some((a) => a === 'Bash' || a === 'Write' || a === 'Edit')) return fail('too much permission: ' + allowed.join(' '))
  const hands = bash.slice('Bash(node '.length, -':*)'.length)
  if (!prompt.trim()) return fail('no ask on stdin')

  out({ type: 'system', subtype: 'init', session_id: 's-fake' })
  const run = (cmd, json) => {
    out({ type: 'assistant', session_id: 's-fake', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `node ${hands} ${cmd} '${json}'` } }] } })
    return execFileSync(process.execPath, [hands, cmd, json], { encoding: 'utf8', env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }) }).trim()
  }
  try {
    if (/מחשבון/.test(prompt)) {
      run('open', JSON.stringify({ name: 'מחשבון' }))
      const placed = run('place', JSON.stringify({ name: 'מחשבון', where: 'left' }))
      out({ type: 'assistant', session_id: 's-fake', message: { content: [{ type: 'text', text: placed }] } })
      out({ type: 'result', subtype: 'success', is_error: false, result: 'סידרתי לך את המחשבון בצד שמאל', session_id: 's-fake' })
    } else if (/תשלח/.test(prompt)) {
      const answer = run('confirm', JSON.stringify({ question: 'לשלוח את ההודעה?' }))
      out({ type: 'result', subtype: 'success', is_error: false, result: answer === 'כן' ? 'שלחתי' : 'לא שלחתי', session_id: 's-fake' })
    } else {
      out({ type: 'result', subtype: 'success', is_error: false, result: 'קיבלתי: ' + prompt.split('\n')[0], session_id: 's-fake' })
    }
  } catch (e) {
    fail('a hands step failed: ' + e.message.split('\n')[0])
  }
})
