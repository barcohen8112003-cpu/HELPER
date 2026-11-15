// What on the PC belongs to HELPER on the cloud and not to this computer: the house (lights, TV, air conditioner,
// blinds, boiler, through Google Home on the cloud) and a check of the whole system. Words alone decide, no AI, so
// "תכבה את האורות" reaches the cloud at once, where a plain light command runs with no model either.
'use strict'

// A home device, as it is said, with the usual prefixes (ה, ב, ו, ש, ל, את ה...). Whole words only: "אורח" is no light.
const DEVICE = /(^|\s)(?:[ובשלמ]?ה?|וה|שה|כשה)(אור|אורות|מנורה|מנורות|נורה|נורות|תאורה|טלוויזיה|טלויזיה|טלוויזייה|טלביזיה|מקרן|מזגן|מזגנים|תריס|תריסים|בוילר|מאוורר|מאווררים|שקע|שקעים|פלאג|מנעול|דלת הכניסה|שואב|שואב האבק|רובוט)(?=\s|$)/
const HOME_NAMES = /((^|\s)[ובשל]?הדוד(?=\s|$)|דוד השמש|דוד החשמל|בית חכם|בבית החכם|גוגל הום|google home|homebridge|הומברידג|smart home)/i
// "במחשב", "על המסך": the ask is about this PC, even with one of the words above ("תגביר את הבהירות של המסך").
const PC_ONLY = /(^(תנגן|תנגני|נגן|תשמיע|תשמיעי)\s|שיר|סרטון|פלייליסט|במחשב|של המחשב|על המסך|במסך|בכרום|ביוטיוב|בספוטיפיי)/

// "תבדוק את המערכת", "בדיקת מערכת", "מה מצב המערכת", "סטטוס", "הכל עובד?"
const STATUS = /^((תבדוק|תבדקי|בדוק|תעשה|תריץ)\s+(לי\s+)?(את\s+)?(ה)?(מערכת|מערכות|בדיקת מערכת|סטטוס)|בדיקת מערכת|בדיקת מערכות|(מה\s+)?(ה)?מצב (של\s+)?(ה)?מערכת|סטטוס|system (check|status)|status|הכל עובד|הכול עובד|מה עובד ומה לא)$/i

/** 'home' | 'status' | null for a tidied sentence (instant.tidy). */
function route(text) {
  const t = String(text || '').trim().replace(/[?!.]+$/, '').trim()
  if (!t) return null
  if (STATUS.test(t)) return 'status'
  if (PC_ONLY.test(t)) return null
  if (DEVICE.test(t) || HOME_NAMES.test(t)) return 'home'
  return null
}

/** One spoken line for the PC check: the hands' numbers, the brain in use, and the cloud link. */
function statusLine({ pc, brain, cloud }) {
  const parts = []
  if (pc) parts.push('המחשב: ' + pc.replace(/ · /g, ', '))
  if (brain) parts.push('המוח כאן: ' + brain)
  if (cloud) parts.push(cloud.ok ? `HELPER בענן מחובר (${cloud.ms} מילישניות)` : 'HELPER בענן: ' + cloud.reason)
  return parts.join('. ')
}

module.exports = { route, statusLine }
