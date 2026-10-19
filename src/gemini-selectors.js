// Everything src/gemini.js knows about the Gemini web page, in one place. The page changes without notice; when it
// does, this is the only file to fix. Each entry is a list tried in order: the first one that matches wins.
//
// To see what the page looks like right now (with the Gemini window open and signed in):
//   node src/gemini.js probe
// prints the visible buttons, inputs and editable boxes with their labels, which is what these lists match on.

export const SELECTORS = {
  // The box the prompt is typed into (a contenteditable editor, not a textarea).
  input: [
    'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'div.ql-editor[contenteditable="true"]',
    'textarea',
  ],
  // The button that sends the prompt.
  send: [
    'button[aria-label*="Send" i]',
    'button[aria-label*="שליחה"]',
    'button[aria-label*="שלח"]',
    'button.send-button',
  ],
  // Shown only while an answer is being written. Its disappearance is how we know the answer is complete.
  generating: [
    'button[aria-label*="Stop" i]',
    'button[aria-label*="עצירה"]',
    'button[aria-label*="הפסק"]',
  ],
  // The menu that offers file upload, and the item in it that opens the file chooser.
  uploadMenu: [
    'button[aria-label*="upload" i]',
    'button[aria-label*="העלא"]',
    'button[aria-label*="הוספ"]',
    'button[aria-label*="Add files" i]',
  ],
  uploadItem: [
    '[data-test-id*="local"][data-test-id*="upload"]',
    'button[aria-label*="Upload files" i]',
    'button[aria-label*="העלאת קבצים"]',
    '[role="menuitem"]',
  ],
  // A file shown as attached, under the prompt box, before sending.
  attachment: [
    'uploader-file-preview',
    '[data-test-id*="file-preview"]',
    '.file-preview',
  ],
  // Each answer of the model. The last one is the answer to our prompt.
  response: [
    'model-response',
    'message-content',
    '[data-test-id*="response"]',
  ],
  // Inside the last answer: things that download a file. Matched on the element and on its label or text.
  download: [
    'a[download]',
    'a[href$=".docx" i]',
    'button[aria-label*="Download" i]',
    'button[aria-label*="הורד"]',
    'a[aria-label*="Download" i]',
  ],
}

// Text that means the window is not usable right now. Seen on the page, Helper stops and tells Naor; it never tries
// to get past any of these by itself.
export const BLOCKERS = {
  login: [/accounts\.google\.com/i, /\bSign in\b/, /התחבר(ות)?\b/],
  captcha: [/captcha/i, /unusual traffic/i, /not a robot/i, /אינני רובוט/, /תעבורה חריגה/],
}

// Words on a button or link that offers a Word file. Used when none of the `download` selectors matched.
export const DOWNLOAD_WORDS = /(download|הורד|docx|word|\.docx)/i
