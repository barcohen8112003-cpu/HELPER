// Direct LLM integration for HELPER Desktop.
// Seamlessly connects OpenRouter (GPT-4o-mini, DeepSeek, etc.) with tool calling, vision, and system automation.
'use strict'
const fs = require('fs')
const config = require('./config')
const hands = require('./hands')
const store = require('./store')

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'open_app_or_web',
      description: 'Opens an application installed on the PC or opens a website URL in the default browser.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Name of the app (e.g. Spotify, Chrome, Notepad) or website URL' } },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'focus_window',
      description: 'Brings an existing open window forward to the front.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'App name or window title to focus' } },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'place_window',
      description: 'Moves or snaps a window to a position or screen.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Window/app name or "זה" for foreground' },
          where: { type: 'string', enum: ['left', 'right', 'top', 'bottom', 'center', 'max', 'min', 'restore'], description: 'Where to place' },
          screen: { type: 'string', description: 'Screen name/index: "1", "2", "next", "ימני", "שמאלי"' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'close_window',
      description: 'Closes an open window.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'App name or "זה" for foreground' } },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_volume',
      description: 'Adjusts or mutes the system audio volume.',
      parameters: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['up', 'down', 'mute', 'set'], description: 'Volume operation' },
          value: { type: 'number', description: '0-100 for set, or step count for up/down' }
        },
        required: ['op']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'control_media',
      description: 'Controls music and media playback (play, pause, next, prev).',
      parameters: {
        type: 'object',
        properties: { op: { type: 'string', enum: ['play', 'pause', 'next', 'prev', 'toggle'] } },
        required: ['op']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'play_youtube',
      description: 'Plays a video or song on YouTube directly.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Song or video title to search and play' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: 'Searches Google, YouTube, or Google Maps.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search keywords' },
          site: { type: 'string', enum: ['google', 'youtube', 'maps'] }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'clipboard_action',
      description: 'Reads from or writes to the Windows clipboard.',
      parameters: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['read', 'write'], description: 'Operation' },
          text: { type: 'string', description: 'Text to write (for op=write)' }
        },
        required: ['op']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'system_status',
      description: 'Returns hardware and OS stats: RAM, CPU cores, uptime.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'press_key',
      description: 'Sends a key combo (e.g. "ctrl+c", "ctrl+v", "win+d", "alt+f4").',
      parameters: {
        type: 'object',
        properties: { keys: { type: 'string', description: 'Key combination' } },
        required: ['keys']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'type_text',
      description: 'Types text steadily into the currently focused field.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Text to type' } },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'remember_fact',
      description: 'Saves a personal fact into persistent memory.',
      parameters: {
        type: 'object',
        properties: { fact: { type: 'string', description: 'Fact to remember' } },
        required: ['fact']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Executes a safe shell command on the PC (e.g. dir, ping, git status, tasklist).',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'Command line to run' } },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'workspace_mode',
      description: 'Arranges the desktop workspace (e.g. "code" for VS Code left and browser right, "reading" for centered browser, "clean" for desktop).',
      parameters: {
        type: 'object',
        properties: { mode: { type: 'string', enum: ['code', 'reading', 'clean'], description: 'Workspace mode' } },
        required: ['mode']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_tab_control',
      description: 'Controls browser tabs (new, close, reopen, next, prev, refresh).',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['new', 'close', 'reopen', 'next', 'prev', 'refresh'] } },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'look_window',
      description: 'Lists what is inside an open window: its buttons, fields, links, tabs and menu items by name. Use before pressing or writing inside a window. Faster and more exact than a screenshot.',
      parameters: {
        type: 'object',
        properties: {
          window: { type: 'string', description: 'App name or window id; empty for the window in front' },
          kind: { type: 'string', enum: ['button', 'field', 'link', 'tab', 'menu'] }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_window',
      description: 'Returns the text a window shows (a web page, a document, a chat), to answer or summarize what is written there.',
      parameters: { type: 'object', properties: { window: { type: 'string', description: 'App name or window id; empty for the window in front' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'press_control',
      description: 'Presses a button, link, menu item, tab or checkbox inside a window by its label (Hebrew or English).',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'The label, e.g. "שמור", "Send", "הבא"' },
          window: { type: 'string', description: 'App name or window id; empty for the window in front' },
          times: { type: 'number', description: 'How many presses (default 1)' }
        },
        required: ['target']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fill_field',
      description: 'Writes text into a field of a window by the field name; without a field, into the main field (search box, message box, document).',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          field: { type: 'string', description: 'Field name, e.g. "חיפוש", "To", "Subject"' },
          window: { type: 'string', description: 'App name or window id; empty for the window in front' },
          submit: { type: 'boolean', description: 'Press Enter after writing' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'switch_tab',
      description: 'Switches to (or closes) an open browser tab by its title.',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' }, close: { type: 'boolean' } },
        required: ['title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'goto_site',
      description: 'Opens a site in the browser that is already open (this tab or a new tab), instead of a new window.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Address or site name, e.g. ynet.co.il, יוטיוב' }, newtab: { type: 'boolean' } },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'scroll_window',
      description: 'Scrolls the window in front (or a named one). Negative is down.',
      parameters: { type: 'object', properties: { amount: { type: 'number' }, window: { type: 'string' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'latest_download_file',
      description: 'Finds or opens the most recently downloaded file in Downloads folder.',
      parameters: {
        type: 'object',
        properties: { open: { type: 'boolean', description: 'True to open the file, false to just report name' } }
      }
    }
  }
]

async function executeTool(name, args) {
  switch (name) {
    case 'open_app_or_web':
      return await hands.run({ cmd: 'open', args: { name: args.name } })
    case 'focus_window':
      return await hands.run({ cmd: 'focus', args: { name: args.name } })
    case 'place_window':
      return await hands.run({ cmd: 'place', args })
    case 'close_window':
      return await hands.run({ cmd: 'close', args: { name: args.name } })
    case 'set_volume':
      return await hands.run({ cmd: 'volume', args })
    case 'control_media':
      return await hands.run({ cmd: 'media', args })
    case 'play_youtube':
      return await hands.run({ cmd: 'play', args: { query: args.query } })
    case 'search_web':
      return await hands.run({ cmd: 'search', args })
    case 'clipboard_action':
      return await hands.run({ cmd: 'clipboard', args })
    case 'system_status':
      return await hands.run({ cmd: 'system', args: {} })
    case 'press_key':
      return await hands.run({ cmd: 'key', args: { keys: args.keys } })
    case 'type_text':
      return await hands.run({ cmd: 'type', args: { text: args.text } })
    case 'remember_fact':
      return await hands.run({ cmd: 'remember', args: { fact: args.fact } })
    case 'run_command':
      return await hands.run({ cmd: 'shell', args: { command: args.command } })
    case 'workspace_mode':
      return await hands.run({ cmd: 'workspace', args: { mode: args.mode } })
    case 'browser_tab_control':
      return await hands.run({ cmd: 'browser_tab', args: { action: args.action } })
    case 'look_window':
      return await hands.run({ cmd: 'look', args })
    case 'read_window':
      return await hands.run({ cmd: 'read', args })
    case 'press_control':
      return await hands.run({ cmd: 'press', args })
    case 'fill_field':
      return await hands.run({ cmd: 'fill', args })
    case 'switch_tab':
      return await hands.run({ cmd: 'tab', args })
    case 'goto_site':
      return await hands.run({ cmd: 'goto', args })
    case 'scroll_window':
      return await hands.run({ cmd: 'scroll', args })
    case 'latest_download_file':
      return await hands.run({ cmd: 'latest_download', args: { open: args.open } })
    default:
      throw new Error('Unknown tool: ' + name)
  }
}

function systemPrompt(extra = {}) {
  const mem = store.memory()
  const memLines = mem.length ? 'זיכרון אישי שלך על המשתמש:\n' + mem.slice(-30).map((m) => '- ' + m.text).join('\n') : ''
  const now = new Date()
  const timeStr = now.toLocaleString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })

  return [
    'אתה HELPER, העוזר האישי הטוב בעולם, כאן על המחשב (Windows 11).',
    'אישיות: חכם, חד, ישיר, מועיל וחם. עברית טבעית ומדוברת. תמיד תשובה ישירה וקצרה.',
    'בלי חנופה, בלי "בטח!", "בשמחה!", "איך עוד אוכל לעזור?". תענה מיד או תבצע את הפעולה.',
    'יש לך שליטה מלאה במחשב דרך הכלים (פתיחת אפליקציות, סידור חלונות, ווליום, יוטיוב, חיפוש, לוח העתקות, מידע מערכת, הרצת פקודות).',
    'בתוך חלון קיים: look_window כדי לראות מה יש בו, ואז press_control / fill_field לפי השמות. שאלה על מה שכתוב בחלון: read_window. אתר: goto_site בדפדפן הפתוח, טאב קיים: switch_tab.',
    'משימה מורכבת: תכנן את כל הצעדים ובצע אותם ברצף, ואז משפט קצר על מה שעשית.',
    `זמן נוכחי: ${timeStr}.`,
    extra.foreground ? `חלון פעיל כרגע: ${extra.foreground}` : '',
    extra.windows ? `חלונות פתוחים:\n${extra.windows}` : '',
    memLines,
  ].filter(Boolean).join('\n\n')
}

/**
 * Ask the direct LLM via OpenRouter.
 * @param {string} prompt User prompt
 * @param {object} extra { screenshot, foreground, windows, ... }
 * @param {function} onEvent ({ type: 'tool'|'text', name, input, text })
 * @returns {Promise<{ ok: boolean, text: string }>}
 */
async function ask(prompt, extra = {}, onEvent = () => {}) {
  const apiKey = config.llmApiKey
  if (!apiKey) {
    return { ok: false, text: 'חסר מפתח LLM_API_KEY בקובץ .env' }
  }

  const models = [
    'openai/gpt-4o-mini',
    'deepseek/deepseek-chat',
    'meta-llama/llama-3.3-70b-instruct'
  ]

  let userContent = prompt
  if (extra.screenshot && extra.screenshot.path) {
    try {
      const imgBuffer = fs.readFileSync(extra.screenshot.path)
      const b64 = imgBuffer.toString('base64')
      userContent = [
        { type: 'text', text: prompt + '\n[מצורף צילום מסך נוכחי של מה שהמשתמש רואה]' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }
      ]
    } catch {}
  }

  const messages = [
    { role: 'system', content: systemPrompt(extra) },
    { role: 'user', content: userContent }
  ]

  for (const model of models) {
    try {
      const res = await callWithTools(apiKey, model, messages, onEvent)
      if (res && res.text) return { ok: true, text: res.text }
    } catch (e) {
      if (e.message && e.message.includes('404')) continue
      // If error is not a 404 model missing, try next model or throw
    }
  }

  return { ok: false, text: 'לא הצלחתי לקבל מענה מהמודל כרגע.' }
}

async function callWithTools(apiKey, model, messages, onEvent, turn = 0) {
  if (turn > 10) {
    return { ok: true, text: 'הפעולות בוצעו.' }
  }

  const baseUrl = config.llmBaseUrl || 'https://openrouter.ai/api/v1'
  const resp = await fetch(baseUrl.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      model,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      max_tokens: 600
    })
  })

  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`LLM call failed (${resp.status}): ${errText.slice(0, 200)}`)
  }

  const data = await resp.json()
  const choice = data.choices && data.choices[0]
  if (!choice) throw new Error('No choices returned')

  const msg = choice.message
  messages.push(msg)

  if (msg.tool_calls && msg.tool_calls.length) {
    for (const toolCall of msg.tool_calls) {
      const fn = toolCall.function
      let args = {}
      try { args = JSON.parse(fn.arguments) } catch {}
      onEvent({ type: 'tool', name: fn.name, input: args })

      let toolResult = ''
      try {
        toolResult = await executeTool(fn.name, args)
      } catch (err) {
        toolResult = 'שגיאה: ' + err.message
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: String(toolResult ?? 'בוצע')
      })
    }
    // Continue conversation after tool execution
    return await callWithTools(apiKey, model, messages, onEvent, turn + 1)
  }

  return { ok: true, text: msg.content ? msg.content.trim() : '' }
}

module.exports = { ask, TOOLS }
