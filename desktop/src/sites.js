// Sites by the names people say them: "יוטיוב", "ג׳ימייל", "וויינט", or an address as it is. Shared by the instant
// commands (is this a site?) and the hands (where to go).
'use strict'

const SITES = {
  'יוטיוב': 'youtube.com', 'youtube': 'youtube.com', 'גוגל': 'google.com', 'google': 'google.com', 'וואטסאפ ווב': 'web.whatsapp.com',
  'נטפליקס': 'netflix.com', 'netflix': 'netflix.com', 'גיטהאב': 'github.com', 'github': 'github.com', 'טוויטר': 'x.com',
  'פייסבוק': 'facebook.com', 'facebook': 'facebook.com', 'אינסטגרם': 'instagram.com', 'instagram': 'instagram.com', 'רדיט': 'reddit.com',
  'ג׳ימייל': 'mail.google.com', 'גימייל': 'mail.google.com', 'גמייל': 'mail.google.com', 'gmail': 'mail.google.com',
  'וויינט': 'ynet.co.il', 'ווינט': 'ynet.co.il', 'ynet': 'ynet.co.il', 'גוגל מפות': 'maps.google.com', 'טיקטוק': 'tiktok.com',
  'קיק': 'kick.com', 'צ׳אט גי פי טי': 'chatgpt.com', 'צאט גיפיטי': 'chatgpt.com', 'chatgpt': 'chatgpt.com', 'ויקיפדיה': 'he.wikipedia.org',
  'אמזון': 'amazon.com', 'עלי אקספרס': 'aliexpress.com', 'גוגל דרייב': 'drive.google.com', 'גוגל יומן': 'calendar.google.com',
  'לינקדאין': 'linkedin.com', 'טוויץ׳': 'twitch.tv', 'טוויץ': 'twitch.tv', 'twitch': 'twitch.tv', 'וואלה': 'walla.co.il', 'מאקו': 'mako.co.il',
}

const clean = (s) => String(s || '').replace(/[‎‏‪-‮]/g, '').trim()

/** A site the user named, as an address: "ynet.co.il", "יוטיוב", "https://…"; null when it is no site. */
function siteUrl(name) {
  const n = clean(name).replace(/^(את |אתר |האתר )/, '').trim()
  if (/^https?:\/\/\S+$/i.test(n)) return n
  if (/^(www\.)?[\w-]+(\.[\w-]+)*\.[a-z]{2,}(\/\S*)?$/i.test(n)) return 'https://' + n
  const low = n.toLowerCase()
  const host = SITES[low] || SITES[low.replace(/^ה(?=\S{3,})/, '')]
  return host ? 'https://' + host : null
}

module.exports = { SITES, siteUrl }
