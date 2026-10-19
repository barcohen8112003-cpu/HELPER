// Fun: randomness, games and decisions. Fairness-sensitive picks use node:crypto; an optional `seed` makes a tool deterministic.
import { randomInt } from 'node:crypto'
import { str, num, bool, oneOf, obj, lines, clip, need, toNumber, bucket, persist } from './_kit.js'

export const category = 'fun'
export const blurb = 'רנדומליות, משחקים והחלטות'

// ---------- helpers ----------
function mulberry32(a) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
// Returns r(n) -> integer in [0, n). Crypto-random unless a seed is given.
function rng(seed) {
  if (seed === undefined || seed === null || seed === '') return (n) => randomInt(n)
  let h = 2166136261
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  const f = mulberry32(h)
  return (n) => Math.floor(f() * n)
}
const pickFrom = (arr, r) => arr[r(arr.length)]
function shuffled(arr, r) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = r(i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
function toList(value, name = 'רשימה', { min = 1, max = 200 } = {}) {
  need(value, name)
  const items = (Array.isArray(value) ? value : String(value).split(/[\n,،;]+/)).map((x) => String(x).trim()).filter(Boolean)
  if (items.length < min) throw new Error(`צריך לפחות ${min} פריטים ב${name}`)
  if (items.length > max) throw new Error(`יותר מדי פריטים ב${name} (מקסימום ${max})`)
  return items.map((x) => x.slice(0, 80))
}
const FINAL = { ך: 'כ', ם: 'מ', ן: 'נ', ף: 'פ', ץ: 'צ' }
const norm = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[֑-ׇ]/g, '')
    .replace(/[ךםןףץ]/g, (m) => FINAL[m])
    .replace(/[^\p{L}\p{N}]/gu, '')
const stripH = (s) => (s.length > 3 && s[0] === 'ה' ? s.slice(1) : s)
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length][b.length]
}
function fuzzyMatch(given, accepted) {
  const g = stripH(norm(given))
  if (!g) return false
  for (const a0 of accepted) {
    const a = stripH(norm(a0))
    if (!a) continue
    if (g === a) return true
    if (a.length >= 3 && g.length >= 3 && (g.includes(a) || a.includes(g))) return true
    const tol = a.length >= 9 ? 2 : a.length >= 4 ? 1 : 0
    if (tol && lev(g, a) <= tol) return true
  }
  return false
}
const games = () => bucket('fun_games', {})

// ---------- content ----------
const WORDS = `שמש ירח כוכב ענן גשם רוח שלג ברק רעם קשת
ים נהר אגם הר גבעה עמק מדבר יער שדה גן
פרח עץ עלה שורש פרי תפוח בננה תמר רימון ענבים
אבטיח מלון אפרסק תות לימון תפוז זיתים שקד אגס דובדבן
לחם חמאה גבינה חלב ביצה דבש שוקולד גלידה עוגה עוגייה
פלאפל חומוס שווארמה סלט פיתה שניצל מרק אורז פסטה פיצה
חתול כלב סוס פרה כבשה עז תרנגול ברווז דג צפרדע
אריה נמר פיל ג'ירפה קוף זאב שועל דוב ארנב צב
נשר יונה עורב ציפור פרפר דבורה נמלה עכביש דולפין כריש
שולחן כיסא ספה מיטה ארון מקרר תנור מראה שטיח וילון
דלת חלון גג קיר מדרגה מרפסת מטבח סלון חצר גשר
אופניים אוטובוס רכבת מטוס ספינה רכבל קטנוע משאית מונית רמזור
ספר עיפרון מחברת מחשב טלפון מקלדת עכבר מסך אוזניות מצלמה
כדורגל כדורסל טניס שחייה ריצה גלישה טיול קמפינג חוף פיקניק
מוזיקה גיטרה פסנתר תוף שיר ריקוד סרט תיאטרון ציור פסל
חבר משפחה שכן מורה רופא נהג טבח צייר שחקן שוטר
בוקר צהריים ערב לילה שבת חופשה חג יומולדת מסיבה הפתעה
זהב כסף ברזל זכוכית עץ אבן חול מים אש אוויר
אדום כחול ירוק צהוב כתום סגול ורוד שחור לבן אפור
שמחה סקרנות אומץ סבלנות חלום הרפתקה מזל צחוק חיוך ידידות
ירושלים חיפה אילת הגליל הנגב כנרת כרמל תבור מצדה עכו
מפתח מנעול שעון מחבט כדור בלון פנס מטרייה תיק כובע`
  .split(/\s+/)
  .filter(Boolean)

const WYR = [
  'להיות מסוגל לעוף או להיות בלתי נראה?',
  'לאכול רק פיצה כל החיים או רק שווארמה כל החיים?',
  'לדעת מתי תמות או איך תמות?',
  'לחיות בלי אינטרנט שנה או בלי מוזיקה שנה?',
  'להיות עשיר ובודד או עני ועם חברים מעולים?',
  'לטייל בכל העולם או לגור בדירת החלומות בעיר אחת?',
  'לקרוא מחשבות או לראות את העתיד?',
  'לוותר על סרטים וסדרות לתמיד או על משחקי מחשב לתמיד?',
  'לישון רק 4 שעות בלילה ולהרגיש מעולה או לישון 12 שעות ולהרגיש רגיל?',
  'שכל הטלפונים בעולם יתקלקלו ליום או שהחשמל ייפסק ליום?',
  'להיות הכי חכם בכיתה או הכי מצחיק בכיתה?',
  'לגור על חוף הים או בראש הר?',
  'לדבר כל שפה בעולם או לנגן בכל כלי נגינה?',
  'לחיות בחורף נצחי או בקיץ נצחי?',
  'לאכול גלידה בלי הגבלה או שוקולד בלי הגבלה?',
  'לעבור בחזרה לילדות או לקפוץ קדימה 20 שנה?',
  'שכולם יראו את היסטוריית החיפושים שלך או את ההודעות האחרונות שלך?',
  'להיות מפורסם בכל העולם או להיות הכי טוב בתחום שאתה אוהב, אבל בלי שאף אחד יידע?',
  'לנצח פעם אחת בלוטו ענק או לקבל אלף שקל בכל חודש לכל החיים?',
  'שיהיה לך כלב שמדבר או חתול שמדבר?',
  'לאבד את חוש הטעם או את חוש הריח?',
  'להיות תמיד 10 דקות באיחור או תמיד 20 דקות מוקדם?',
  'לצאת לטיול במכונת זמן לעבר או לעתיד?',
  'לחיות שנה בלי סוכר או שנה בלי קפה?',
  'לעבוד במקצוע שאתה אוהב עם שכר בינוני או במקצוע משעמם עם שכר גבוה?',
  'לשחק כל משחק מושלם או לשחזר כל שיר שתשמע?',
]
const TRUTH = [
  'מה הדבר הכי מביך שקרה לך בבית הספר?',
  'מה השקר הכי גדול שסיפרת להורים שלך?',
  'על מי היה לך קראש בסתר?',
  'מה השיר שאתה שומע בסתר ומתבייש להודות?',
  'מה הדבר הכי מוזר שאתה עושה כשאתה לבד בבית?',
  'מה הפעם האחרונה שבכית ולמה?',
  'מה הפחד הכי מטופש שיש לך?',
  'איזו הודעה שלחת בטעות לא לאדם הנכון?',
  'מה הדבר הכי יקר שהרסת במקרה?',
  'אם היית יכול להחליף חיים עם מישהו ליום, מי זה היה?',
  'מה הסוד הכי טוב שלא סיפרת לאף אחד?',
  'איזה כינוי מביך היה לך בילדות?',
  'מה הדבר שהכי מעצבן אותך אצל חברים?',
  'מה הדבר הראשון שאתה עושה כשאתה מתעורר?',
  'איזו סדרה אתה מתבייש שאתה אוהב?',
  'מתי בפעם האחרונה העתקת במבחן או בשיעורי בית?',
  'מה היה הדייט הכי גרוע שלך?',
  'איזה תכונה שלך אתה הכי פחות אוהב?',
  'מה הדבר הכי מטורף שעשית בגלל התערבות?',
  'מי בקבוצה הזאת הכי קל לך לדבר איתו ולמה?',
  'מה הדבר שהכי גאה בו בעצמך?',
  'אם היית חייב למחוק אפליקציה אחת מהטלפון, איזו?',
  'מה התחביב המוזר ביותר שלך?',
  'מה הדבר הכי ילדותי שאתה עדיין עושה?',
  'מה היית עושה אם היית בלתי נראה ליום אחד?',
  'איזה שקר קטן אתה מספר הכי הרבה?',
]
const DARE = [
  'תדבר במבטא של סבתא עד התור הבא שלך.',
  'תעשה 10 שכיבות סמיכה עכשיו.',
  'תשלח הודעת קול שבה אתה שר שיר ילדים.',
  'תחקה חיה לבחירת הקבוצה עד שיבינו מה זו.',
  'תרקוד 30 שניות בלי מוזיקה.',
  'תנסה ללקק את המרפק שלך.',
  'תספר בדיחה, ואם אף אחד לא צוחק, תספר עוד אחת.',
  'תדבר רק בחרוזים בשלוש הדקות הבאות.',
  'תעשה את הקול הכי מצחיק שאתה מסוגל.',
  'תתן למישהו מהקבוצה לבחור לך תמונת פרופיל לשעה.',
  'תחזיק פלאנק חצי דקה.',
  'תתאר את היום שלך כאילו אתה קריין חדשות.',
  'תעשה עשר קפיצות כוכב תוך כדי שאתה שר את ההמנון.',
  'תדבר בלחש עד התור הבא שלך.',
  'תצייר פורטרט של מישהו בקבוצה בעיניים עצומות.',
  'תנסה לעשות סטנד-אפ של דקה על מטרייה.',
  'תחקה מורה שכולנו מכירים.',
  'תאכל כפית של משהו חמוץ מהמטבח.',
  'תסתובב חמש פעמים סביב עצמך ותנסה ללכת בקו ישר.',
  'תכתוב סטטוס מצחיק על עצמך בהוראת הקבוצה.',
  'תעשה מחמאה אמיתית לכל אחד בחדר.',
  'תדבר כמו רובוט עד התור הבא.',
  'תנסה לעמוד על רגל אחת דקה שלמה בלי להחזיק בכלום.',
  'תספר סיפור קצר של 30 שניות שבו כל משפט מתחיל באות הבאה באלף-בית.',
  'תעשה פנטומימה של סרט, והקבוצה תנחש.',
  'תתחפש במשהו מהבית ותצטלם.',
]
const ICE = [
  'מה הדבר הכי טוב שקרה לך השבוע?',
  'אם היית יכול לאכול רק מאכל אחד כל החיים, מה הוא?',
  'מה הסדרה האחרונה שסיימת ואיך היא?',
  'לאן הטיול הבא שאתה חולם עליו?',
  'איזה כוח על היית רוצה שיהיה לך?',
  'מה הדבר הכי מצחיק שראית לאחרונה ברשת?',
  'מה היית עושה עם מיליון שקל?',
  'איזה שיר מרים לך את מצב הרוח?',
  'מה הדבר שהכי אתה אוהב בעיר שלך?',
  'איזה מקצוע היית רוצה לנסות ליום אחד?',
  'מה הספר או הסרט שהכי השפיע עליך?',
  'מה המנה האהובה עליך שאמא או סבתא מכינות?',
  'אם היית יכול לפגוש אדם מפורסם אחד, מי?',
  'איזו מיומנות היית רוצה ללמוד מהר?',
  'מה הפעילות האהובה עליך בסוף שבוע?',
  'איזה חיית מחמד היית רוצה, ולמה?',
  'מה הדבר הכי מוזר שאכלת?',
  'מה הזיכרון הכי טוב שלך מהילדות?',
  'איזה יום בשבוע הכי אהוב עליך?',
  'אם היית כותב ספר, על מה הוא היה?',
  'איזו אפליקציה אתה לא יכול בלעדיה?',
  'מה הדבר הראשון שהיית קונה בחנות צעצועים בלי הגבלה?',
  'איזה מקום בארץ הכי אהוב עליך?',
  'מה היית רוצה שיקרה בעוד חמש שנים?',
  'תבחר: הרים או חוף ים, ולמה?',
  'איזה שם היית נותן לסרט על החיים שלך?',
]

const TRIVIA = [
  ['מהי בירת צרפת?', 'פריז', []],
  ['כמה צלעות יש למשושה?', '6', ['שש']],
  ['מהו כוכב הלכת הקרוב ביותר לשמש?', 'חמה', ['מרקורי', 'כוכב חמה']],
  ['מי כתב את "רומיאו ויוליה"?', 'שייקספיר', ['וויליאם שייקספיר']],
  ['מהי בירת יפן?', 'טוקיו', []],
  ['כמה ימים יש בשנה מעוברת (גרגוריאנית)?', '366', []],
  ['מהו המקום הנמוך ביותר על פני היבשה בעולם?', 'ים המלח', []],
  ['מי היה ראש הממשלה הראשון של ישראל?', 'דוד בן גוריון', ['בן גוריון']],
  ['באיזו שנה הוקמה מדינת ישראל?', '1948', ['תש"ח']],
  ['איזה יסוד כימי מסומן באות O?', 'חמצן', ['אוקסיגן']],
  ['כמה שחקנים יש בקבוצת כדורגל על המגרש?', '11', ['אחד עשר', 'אחד-עשר']],
  ['מהו האוקיינוס הגדול ביותר?', 'האוקיינוס השקט', ['השקט', 'פסיפיק']],
  ['מהי בירת אוסטרליה?', 'קנברה', ['קנברה']],
  ['כמה יבשות יש בעולם לפי המודל הנפוץ?', '7', ['שבע']],
  ['מהו בעל החיים היבשתי המהיר ביותר?', 'ברדלס', ['צ\'יטה', 'צ׳יטה']],
  ['מי צייר את המונה ליזה?', 'לאונרדו דה וינצ\'י', ['דה וינצי', 'דה וינצ\'י', 'לאונרדו']],
  ['מהו ההר הגבוה בעולם מעל פני הים?', 'האוורסט', ['אוורסט']],
  ['כמה אותיות יש באלף-בית העברי?', '22', ['עשרים ושתיים']],
  ['מהי בירת ספרד?', 'מדריד', []],
  ['מהו הנהר הארוך ביותר בישראל?', 'הירדן', ['ירדן']],
  ['איזה גז הכי נפוץ באטמוספירה של כדור הארץ?', 'חנקן', ['ניטרוגן']],
  ['כמה דקות יש ביממה?', '1440', []],
  ['איזה כוכב לכת ידוע בטבעות הבולטות שלו?', 'שבתאי', ['סטורן']],
  ['מהו הסימול הכימי של זהב?', 'Au', ['אאו']],
  ['מהי בירת איטליה?', 'רומא', []],
  ['כמה צבעים יש בקשת?', '7', ['שבע']],
  ['איזו מדינה היא הגדולה בעולם בשטחה?', 'רוסיה', []],
  ['מהו היונק הגדול ביותר בעולם?', 'לווייתן כחול', ['הלוויתן הכחול', 'לוויתן']],
  ['איזה אגם גדול נמצא בצפון ישראל?', 'הכנרת', ['כנרת', 'ים כנרת']],
  ['מי כתב את "הנסיך הקטן"?', 'אנטואן דה סנט אכזופרי', ['סנט אכזופרי', 'סנט אקזופרי']],
  ['מהי בירת גרמניה?', 'ברלין', []],
  ['כמה שניות יש בשעה?', '3600', []],
  ['איזה מתכת נמצאת במצב נוזלי בטמפרטורת החדר?', 'כספית', ['מרקורי']],
  ['מי היה האדם הראשון שצעד על הירח?', 'ניל ארמסטרונג', ['ארמסטרונג']],
  ['מהי השפה הרשמית של ברזיל?', 'פורטוגזית', []],
  ['איזה איבר בגוף שואב את הדם?', 'הלב', ['לב']],
  ['כמה מטרים יש בקילומטר?', '1000', ['אלף']],
  ['איזה כוכב נמצא במרכז מערכת השמש?', 'השמש', ['שמש']],
  ['מהי בירת מצרים?', 'קהיר', []],
  ['מהי העיר הגדולה בישראל לפי אוכלוסייה?', 'ירושלים', []],
  ['כמה קלפים יש בחפיסה רגילה בלי ג\'וקרים?', '52', ['חמישים ושניים']],
  ['באיזו מדינה נמצא מגדל פיזה?', 'איטליה', []],
  ['מהו המספר הראשוני הקטן ביותר?', '2', ['שתיים', 'שניים']],
  ['מי כתבה את ספרי הארי פוטר?', 'ג\'יי קיי רולינג', ['רולינג', 'ג\'יי. קיי. רולינג']],
  ['מהי בירת בריטניה?', 'לונדון', []],
]

const RIDDLES = [
  ['מה עולה ויורד ולא זז ממקומו?', 'מדרגות'],
  ['יש לי ערים בלי בתים, הרים בלי עצים ומים בלי דגים. מה אני?', 'מפה'],
  ['מה שייך לך אבל אחרים משתמשים בו יותר ממך?', 'השם שלך'],
  ['מה רץ בלי רגליים?', 'מים'],
  ['מה יש לו מפתחות אבל לא פותח אף דלת?', 'מקלדת'],
  ['ככל שלוקחים ממני יותר, אני גדול יותר. מה אני?', 'בור'],
  ['מה נשבר ברגע שאומרים את שמו?', 'שקט'],
  ['מה יש לו ידיים אבל לא יכול ללחוץ יד?', 'שעון'],
  ['מה יש לו צוואר אבל אין לו ראש?', 'בקבוק'],
  ['מה נהיה רטוב יותר ככל שהוא מייבש?', 'מגבת'],
  ['מה יש לו עין אחת אבל לא רואה?', 'מחט'],
  ['מה אפשר לתפוס אבל אי אפשר לזרוק?', 'הצטננות'],
  ['מה יש לו שיניים אבל לא נושך?', 'מסרק'],
  ['מה עף בלי כנפיים ובוכה בלי עיניים?', 'ענן'],
  ['מה הולך על ארבע בבוקר, על שתיים בצהריים ועל שלוש בערב?', 'אדם'],
  ['מה תמיד לפנינו אבל אי אפשר לראות אותו?', 'העתיד'],
  ['מה אפשר לשבור בלי לגעת בו?', 'הבטחה'],
  ['מה מלא חורים ובכל זאת מחזיק מים?', 'ספוג'],
  ['מה גדל כשמאכילים אותו ומת כשנותנים לו מים?', 'אש'],
  ['מה יש לו דפים אבל הוא לא עץ?', 'ספר'],
  ['מה אפשר לשמור רק אחרי שנותנים אותו?', 'מילה'],
  ['מה יש לו פנים ושתי ידיים אבל אין לו ראש ולא גוף?', 'שעון'],
]

const EIGHT = [
  'בהחלט כן!', 'בטוח שכן.', 'אין ספק.', 'כל הסימנים מצביעים על כן.', 'כן, לך על זה.',
  'סביר מאוד.', 'נראה לי שכן.', 'הערפל סמיך, תשאל שוב.', 'עדיף לא לספר לך עכשיו.', 'אי אפשר לחזות כרגע.',
  'תתרכז ותשאל שוב.', 'לא סומך על זה.', 'התשובה שלי היא לא.', 'המקורות שלי אומרים לא.', 'לא נראה טוב.',
  'ממש לא.', 'אולי כן, אולי לא, תחליט בעצמך.', 'תשאל מישהו חכם יותר ממני.',
]
const COMPLIMENTS = [
  'יש לך חוש הומור מעולה.', 'אתה חבר אמיתי, אפשר לסמוך עליך.', 'אתה פשוט לומד דברים מהר.', 'הרבה אנשים מרגישים טוב לידך.',
  'יש לך אנרגיה שמדביקה.', 'אתה יצירתי יותר ממה שאתה חושב.', 'אתה מקשיב באמת, וזה נדיר.', 'החיוך שלך משפר את היום של אחרים.',
  'יש לך טעם מעולה.', 'אתה עקשן במובן הכי טוב.', 'אתה אדם נדיב.', 'אתה יודע להצחיק גם ברגעים קשים.',
  'אתה חכם ולא מתנשא, וזה שילוב מנצח.', 'יש לך כישרון שעוד תופתע לגלות.', 'אתה אמיץ יותר ממה שנדמה לך.', 'אתה גורם לאנשים להרגיש שייכים.',
  'אתה יודע לתת עצות טובות.', 'אתה מוסיף הרבה כיף לכל מקום.', 'אתה בדרך הנכונה, ממשיכים ככה.', 'אתה אדם שכיף להכיר.',
  'אתה עובד קשה וזה רואים.', 'יש לך לב טוב.', 'אתה גורם לדברים קשים להיראות קלים.', 'הסקרנות שלך מעוררת השראה.', 'אתה מושלם בלהיות מי שאתה.',
]
const BOYS = ['נועם', 'איתי', 'יובל', 'עומר', 'אורי', 'דניאל', 'אלון', 'תומר', 'גיא', 'ניר', 'אדם', 'יונתן', 'עידו', 'ליאם', 'אריאל', 'רועי', 'עמית', 'שחר']
const GIRLS = ['נועה', 'מאיה', 'שירה', 'תמר', 'יעל', 'אופיר', 'ליאור', 'רותם', 'הילה', 'אגם', 'שיר', 'מיכל', 'דנה', 'נטע', 'ענבר', 'טל', 'ריי', 'מורן']
const LASTS = ['כהן', 'לוי', 'מזרחי', 'פרץ', 'ביטון', 'אברהם', 'דהן', 'אזולאי', 'פרידמן', 'שפירא', 'גולן', 'רוזן', 'אדרי', 'חדד', 'בן דוד', 'ברק', 'שמש', 'אורבך', 'כץ', 'גבאי']
const FOOD = [
  'פיצה', 'שווארמה בלאפה', 'המבורגר', 'סושי', 'פלאפל', 'שניצל עם פירה', 'פסטה ברוטב שמנת', 'חומוס עם פול', 'שקשוקה', 'טוסט גבינה',
  'סלט גדול עם טונה', 'אורז עם עוף', 'מרק עוף', 'קבב בפיתה', 'בורקס', 'פנקייק', 'סנדוויץ\' אבוקדו', 'אטריות מוקפצות', 'נקניקיות', 'מג\'דרה',
]
const WATCH = [
  'סרט קומדיה עם חברים', 'סדרת פשע מותחת', 'סרט הרפתקאות קלאסי', 'סדרת אנימציה לבוגרים', 'סרט מדע בדיוני', 'תוכנית ריאליטי קלילה',
  'סרט אימה (אם לא פוחדים)', 'סדרה ישראלית שעוד לא ראית', 'דוקומנטרי על הטבע', 'סרט משפחה מצחיק', 'הארי פוטר מההתחלה', 'מרתון של חברים',
  'סרט על ספורט', 'סדרת פנטזיה', 'סרט מרגש לבכות', 'סטנד-אפ של קומיקאי שאתה אוהב', 'סרט ישן שכולם אומרים שהוא קלאסי', 'סדרת מסתורין',
]
const DO = [
  'לצאת לטיול רגלי בטבע', 'להזמין חברים למשחקי קופסה', 'ללכת לים', 'לבשל משהו חדש', 'לצאת לריצה קלה', 'לעשות ערב סרט בבית',
  'לנסות אטרקציה בעיר שלא היית בה', 'לקרוא פרק בספר', 'לצלם סרטון קצר ומצחיק', 'ללמוד קטע בגיטרה או בפסנתר', 'לצאת לאופניים', 'לסדר את החדר ולשים מוזיקה',
  'לעשות פיקניק בפארק', 'לשחק כדורגל או כדורסל עם חברים', 'להתקשר לחבר שלא דיברת איתו המון זמן', 'לצייר או לשרבט משהו', 'ללכת לקפה עם חבר', 'לנסות מתכון לעוגה', 'לטייל במקום חדש בארץ', 'לישון קצת בכיף',
]
const HANG = [
  'מחשב', 'שוקולד', 'פלאפל', 'אופניים', 'חופשה', 'כדורגל', 'מקרר', 'ספרייה', 'גלידה', 'דינוזאור', 'טלפון', 'בננה', 'מטוס', 'אוטובוס', 'תפוח',
  'שולחן', 'מגדלור', 'ירושלים', 'מקלדת', 'קשת', 'פסנתר', 'חדרים', 'מצלמה', 'כנרת', 'הרפתקה', 'חברים', 'שמיים', 'ספינה', 'ארנב', 'דולפין',
  'מטרייה', 'יומולדת', 'פרפר', 'תיאטרון', 'אבטיח', 'מסיבה', 'קפה', 'גיטרה', 'חולצה', 'מדבר',
]
const PALETTE_NAMES = ['שקיעה', 'ים', 'יער', 'מדבר', 'סוכריה', 'לילה', 'אביב', 'קפה']

// ---------- tic tac toe ----------
const LINES3 = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]]
function winner(b) {
  for (const [a, c, d] of LINES3) if (b[a] !== '-' && b[a] === b[c] && b[a] === b[d]) return b[a]
  return b.includes('-') ? null : 'draw'
}
function minimax(b, turn) {
  const w = winner(b)
  if (w === 'O') return 1
  if (w === 'X') return -1
  if (w === 'draw') return 0
  const scores = []
  for (let i = 0; i < 9; i++) if (b[i] === '-') scores.push(minimax(b.slice(0, i) + turn + b.slice(i + 1), turn === 'O' ? 'X' : 'O'))
  return turn === 'O' ? Math.max(...scores) : Math.min(...scores)
}
function botMove(b, level, r) {
  const empty = [...b].map((c, i) => (c === '-' ? i : -1)).filter((i) => i >= 0)
  if (level === 'easy') return pickFrom(empty, r)
  const scored = empty.map((i) => ({ i, s: minimax(b.slice(0, i) + 'O' + b.slice(i + 1), 'X') }))
  const best = Math.max(...scored.map((x) => x.s))
  return pickFrom(scored.filter((x) => x.s === best), r).i
}
function renderBoard(b) {
  const cell = (i) => (b[i] === 'X' ? 'X' : b[i] === 'O' ? 'O' : String(i + 1))
  return [0, 3, 6].map((r) => `${cell(r)} | ${cell(r + 1)} | ${cell(r + 2)}`).join('\n---------\n')
}

// ---------- hangman / rps helpers ----------
const RPS = { rock: 'אבן', paper: 'נייר', scissors: 'מספריים' }
const RPS_IN = { אבן: 'rock', נייר: 'paper', מספריים: 'scissors', מספרים: 'scissors', rock: 'rock', paper: 'paper', scissors: 'scissors' }
const hex = (n) => n.toString(16).padStart(2, '0')
function hslToHex(h, s, l) {
  s /= 100
  l /= 100
  const k = (n) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return `#${hex(Math.round(f(0) * 255))}${hex(Math.round(f(8) * 255))}${hex(Math.round(f(4) * 255))}`
}
const intArg = (v, name, lo, hi, def) => {
  if (v === undefined || v === null || v === '') return def
  const n = Math.trunc(toNumber(v, name))
  if (n < lo || n > hi) throw new Error(`${name} חייב להיות בין ${lo} ל-${hi}`)
  return n
}

// ---------- tools ----------
export const tools = [
  {
    name: 'fun_dice',
    description: 'מטיל קוביות בסימון NdM, למשל 2d6+3 (עד 100 קוביות).',
    parameters: obj({ notation: str('למשל 2d6+3, d20 או 4d8-1'), seed: str('זרע לתוצאה קבועה (לא חובה)') }, ['notation']),
    run({ notation, seed }) {
      const m = /^(\d*)d(\d+)([+-]\d+)?$/i.exec(String(need(notation, 'סימון')).replace(/\s+/g, ''))
      if (!m) throw new Error('סימון לא תקין, למשל 2d6+3')
      const n = m[1] === '' ? 1 : Number(m[1])
      const sides = Number(m[2])
      const mod = m[3] ? Number(m[3]) : 0
      if (n < 1 || n > 100) throw new Error('מספר הקוביות חייב להיות בין 1 ל-100')
      if (sides < 2 || sides > 1000) throw new Error('מספר הפאות חייב להיות בין 2 ל-1000')
      const r = rng(seed)
      const rolls = Array.from({ length: n }, () => r(sides) + 1)
      const total = rolls.reduce((a, b) => a + b, 0) + mod
      return `${clip(rolls.join(' + '), 600)}${mod ? ` ${mod > 0 ? '+' : '-'} ${Math.abs(mod)}` : ''}\nסה"כ: ${total}`
    },
  },
  {
    name: 'fun_coin',
    description: 'מטיל מטבע (עץ או פלי), אפשר כמה פעמים.',
    parameters: obj({ times: num('כמה הטלות (ברירת מחדל 1, עד 100)'), seed: str('זרע (לא חובה)') }, []),
    run({ times, seed }) {
      const n = intArg(times, 'מספר הטלות', 1, 100, 1)
      const r = rng(seed)
      const res = Array.from({ length: n }, () => (r(2) ? 'עץ' : 'פלי'))
      if (n === 1) return res[0]
      return `${res.join(', ')}\nעץ: ${res.filter((x) => x === 'עץ').length}, פלי: ${res.filter((x) => x === 'פלי').length}`
    },
  },
  {
    name: 'fun_pick',
    description: 'בוחר באקראי פריט אחד או כמה פריטים מתוך רשימה.',
    parameters: obj({ items: { type: 'array', items: { type: 'string' }, description: 'הפריטים (או טקסט מופרד בפסיקים)' }, count: num('כמה לבחור (ברירת מחדל 1)'), seed: str('זרע (לא חובה)') }, ['items']),
    run({ items, count, seed }) {
      const list = toList(items, 'רשימה')
      const n = intArg(count, 'כמות', 1, list.length, 1)
      const out = shuffled(list, rng(seed)).slice(0, n)
      return n === 1 ? out[0] : out.map((x, i) => `${i + 1}. ${x}`).join('\n')
    },
  },
  {
    name: 'fun_shuffle',
    description: 'מערבב רשימה בסדר אקראי הוגן.',
    parameters: obj({ items: { type: 'array', items: { type: 'string' }, description: 'הפריטים' }, seed: str('זרע (לא חובה)') }, ['items']),
    run({ items, seed }) {
      return clip(shuffled(toList(items, 'רשימה'), rng(seed)).map((x, i) => `${i + 1}. ${x}`).join('\n'), 3000)
    },
  },
  {
    name: 'fun_random_number',
    description: 'מגריל מספר שלם אקראי בטווח (כולל הקצוות), אפשר כמה מספרים.',
    parameters: obj({ min: num('מינימום'), max: num('מקסימום'), count: num('כמה מספרים (עד 50)'), unique: bool('בלי חזרות'), seed: str('זרע (לא חובה)') }, ['min', 'max']),
    run({ min, max, count, unique, seed }) {
      const lo = Math.trunc(toNumber(min, 'מינימום'))
      const hi = Math.trunc(toNumber(max, 'מקסימום'))
      if (hi < lo) throw new Error('המקסימום קטן מהמינימום')
      if (hi - lo > 1e12) throw new Error('הטווח גדול מדי')
      const n = intArg(count, 'כמות', 1, 50, 1)
      if (unique && hi - lo + 1 < n) throw new Error('הטווח קטן מדי בלי חזרות')
      const r = rng(seed)
      const out = []
      while (out.length < n) {
        const v = lo + r(hi - lo + 1)
        if (!unique || !out.includes(v)) out.push(v)
      }
      return out.join(', ')
    },
  },
  {
    name: 'fun_teams',
    description: 'מחלק אנשים באופן אקראי למספר קבוצות שווה ככל האפשר.',
    parameters: obj({ names: { type: 'array', items: { type: 'string' }, description: 'השמות' }, teams: num('מספר קבוצות'), seed: str('זרע (לא חובה)') }, ['names', 'teams']),
    run({ names, teams, seed }) {
      const list = toList(names, 'שמות', { min: 2 })
      const k = intArg(teams, 'מספר קבוצות', 2, list.length, 2)
      const groups = Array.from({ length: k }, () => [])
      shuffled(list, rng(seed)).forEach((p, i) => groups[i % k].push(p))
      return groups.map((g, i) => `קבוצה ${i + 1}: ${g.join(', ')}`).join('\n')
    },
  },
  {
    name: 'fun_draw_order',
    description: 'מגריל סדר תורות או מי מתחיל, עם שם אחד שנבחר ראשון.',
    parameters: obj({ names: { type: 'array', items: { type: 'string' }, description: 'המשתתפים' }, seed: str('זרע (לא חובה)') }, ['names']),
    run({ names, seed }) {
      const order = shuffled(toList(names, 'משתתפים', { min: 2 }), rng(seed))
      return `מתחיל: ${order[0]}\nסדר מלא: ${order.join(' ← ')}`
    },
  },
  {
    name: 'fun_password',
    description: 'מייצר סיסמה חזקה אקראית או משפט-סיסמה מעברית (אקראיות מאובטחת).',
    parameters: obj(
      { mode: oneOf(['password', 'passphrase'], 'password רגילה או passphrase ממילים'), length: num('אורך סיסמה 8-64 (ברירת מחדל 16)'), symbols: bool('לכלול סימנים מיוחדים'), words: num('מספר מילים 3-8 (ל-passphrase)') },
      [],
    ),
    run({ mode, length, symbols, words }) {
      if (mode === 'passphrase') {
        const n = intArg(words, 'מספר מילים', 3, 8, 4)
        const picked = Array.from({ length: n }, () => WORDS[randomInt(WORDS.length)])
        return `${picked.join('-')}-${randomInt(10, 100)}`
      }
      const len = intArg(length, 'אורך', 8, 64, 16)
      const sets = ['abcdefghijkmnopqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789']
      if (symbols !== false && symbols !== 'false') sets.push('!@#$%^&*-_=+?')
      const all = sets.join('')
      const chars = sets.map((s) => s[randomInt(s.length)])
      while (chars.length < len) chars.push(all[randomInt(all.length)])
      return shuffled(chars, (n) => randomInt(n)).join('')
    },
  },
  {
    name: 'fun_question',
    description: 'שואל שאלה אקראית: מה מעדיף, אמת, חובה או שאלת היכרות.',
    parameters: obj({ kind: oneOf(['would_you_rather', 'truth', 'dare', 'icebreaker'], 'סוג השאלה'), seed: str('זרע (לא חובה)') }, ['kind']),
    run({ kind, seed }) {
      const map = { would_you_rather: ['מה מעדיף', WYR], truth: ['אמת', TRUTH], dare: ['חובה', DARE], icebreaker: ['שאלת היכרות', ICE] }
      const e = map[kind]
      if (!e) throw new Error('סוג שאלה לא מוכר')
      return `${e[0]}: ${pickFrom(e[1], rng(seed))}`
    },
  },
  {
    name: 'fun_trivia',
    description: 'נותן שאלת טריוויה בעברית עם מספר מזהה, בלי התשובה.',
    parameters: obj({ seed: str('זרע (לא חובה)') }, []),
    run({ seed }) {
      const id = rng(seed)(TRIVIA.length)
      return `שאלה #${id + 1}: ${TRIVIA[id][0]}\n(לבדיקת תשובה: fun_trivia_answer עם id=${id + 1})`
    },
  },
  {
    name: 'fun_trivia_answer',
    description: 'בודק תשובה לשאלת טריוויה לפי מספר השאלה, או חושף את התשובה.',
    parameters: obj({ id: num('מספר השאלה'), answer: str('התשובה של המשתמש (ריק = לחשוף)') }, ['id']),
    run({ id, answer }) {
      const i = Math.trunc(toNumber(id, 'מספר שאלה')) - 1
      if (!TRIVIA[i]) throw new Error(`אין שאלה כזאת, המספרים הם 1 עד ${TRIVIA.length}`)
      const [q, a, alts] = TRIVIA[i]
      if (answer === undefined || answer === null || String(answer).trim() === '') return `התשובה: ${a}`
      return fuzzyMatch(answer, [a, ...alts]) ? `נכון! ${a}` : `לא מדויק. התשובה הנכונה: ${a}`
    },
  },
  {
    name: 'fun_riddle',
    description: 'נותן חידה בעברית; עם id וגם reveal=true חושף את התשובה.',
    parameters: obj({ id: num('מספר חידה (לחשיפה)'), reveal: bool('לחשוף תשובה'), seed: str('זרע (לא חובה)') }, []),
    run({ id, reveal, seed }) {
      if (id !== undefined && id !== null && id !== '') {
        const i = Math.trunc(toNumber(id, 'מספר חידה')) - 1
        if (!RIDDLES[i]) throw new Error(`אין חידה כזאת, המספרים הם 1 עד ${RIDDLES.length}`)
        return reveal ? `חידה #${i + 1}: ${RIDDLES[i][0]}\nתשובה: ${RIDDLES[i][1]}` : `חידה #${i + 1}: ${RIDDLES[i][0]}`
      }
      const i = rng(seed)(RIDDLES.length)
      return `חידה #${i + 1}: ${RIDDLES[i][0]}\n(לחשיפה: id=${i + 1} ו-reveal=true)`
    },
  },
  {
    name: 'fun_8ball',
    description: 'כדור קסמים 8: עונה על שאלת כן/לא בתשובה מסתורית.',
    parameters: obj({ question: str('השאלה'), seed: str('זרע (לא חובה)') }, ['question']),
    run({ question, seed }) {
      need(question, 'שאלה')
      return `🎱 ${pickFrom(EIGHT, rng(seed))}`
    },
  },
  {
    name: 'fun_rps',
    description: 'אבן נייר ומספריים נגד הבוט, עם ניקוד מצטבר.',
    parameters: obj({ choice: str('אבן / נייר / מספריים (או reset לאיפוס ניקוד)') }, ['choice']),
    async run({ choice }) {
      const score = await bucket('fun_rps', { wins: 0, losses: 0, draws: 0 })
      const c = String(need(choice, 'בחירה')).trim().toLowerCase()
      if (c === 'reset' || c === 'איפוס') {
        score.wins = score.losses = score.draws = 0
        await persist()
        return 'הניקוד אופס'
      }
      const you = RPS_IN[c]
      if (!you) throw new Error('בחר אבן, נייר או מספריים')
      const keys = Object.keys(RPS)
      const bot = keys[randomInt(3)]
      const beats = { rock: 'scissors', paper: 'rock', scissors: 'paper' }
      let res
      if (you === bot) (score.draws++, (res = 'תיקו'))
      else if (beats[you] === bot) (score.wins++, (res = 'ניצחת!'))
      else (score.losses++, (res = 'הפסדת'))
      await persist()
      return `אתה: ${RPS[you]}, אני: ${RPS[bot]}. ${res}\nניקוד: ניצחונות ${score.wins}, הפסדים ${score.losses}, תיקו ${score.draws}`
    },
  },
  {
    name: 'fun_guess',
    description: 'משחק ניחוש מספר: new מתחיל, guess מנחש ומקבל רמז גבוה או נמוך.',
    parameters: obj({ action: oneOf(['new', 'guess', 'give_up'], 'new / guess / give_up'), min: num('מינימום (new)'), max: num('מקסימום (new)'), number: num('הניחוש (guess)') }, ['action']),
    async run({ action, min, max, number }) {
      const g = await games()
      if (action === 'new') {
        const lo = Math.trunc(toNumber(min ?? 1, 'מינימום'))
        const hi = Math.trunc(toNumber(max ?? 100, 'מקסימום'))
        if (hi <= lo || hi - lo > 1e9) throw new Error('טווח לא תקין')
        g.guess = { lo, hi, secret: lo + randomInt(hi - lo + 1), tries: 0 }
        await persist()
        return `חשבתי על מספר בין ${lo} ל-${hi}. נסה לנחש!`
      }
      const s = g.guess
      if (!s) throw new Error('אין משחק פעיל, התחל עם action=new')
      if (action === 'give_up') {
        delete g.guess
        await persist()
        return `המספר היה ${s.secret}`
      }
      if (action !== 'guess') throw new Error('פעולה לא מוכרת')
      const n = Math.trunc(toNumber(need(number, 'ניחוש'), 'ניחוש'))
      s.tries++
      if (n === s.secret) {
        delete g.guess
        await persist()
        return `נכון! המספר היה ${n}, ניחשת ב-${s.tries} ניסיונות.`
      }
      await persist()
      return `${n < s.secret ? 'גבוה יותר' : 'נמוך יותר'} (ניסיון ${s.tries})`
    },
  },
  {
    name: 'fun_hangman',
    description: 'משחק תלייה בעברית: new מתחיל, guess מנחש אות או מילה שלמה.',
    parameters: obj({ action: oneOf(['new', 'guess', 'status'], 'new / guess / status'), letter: str('אות או מילה (guess)') }, ['action']),
    async run({ action, letter }) {
      const g = await games()
      const show = (h) => {
        const masked = [...h.word].map((ch) => (h.guessed.includes(norm(ch)) ? ch : '_')).join(' ')
        return `${masked}\nטעויות: ${h.wrong.length}/6${h.wrong.length ? ` (${h.wrong.join(' ')})` : ''}`
      }
      if (action === 'new') {
        g.hangman = { word: HANG[randomInt(HANG.length)], guessed: [], wrong: [] }
        await persist()
        return `מילה חדשה, ${g.hangman.word.length} אותיות:\n${show(g.hangman)}`
      }
      const h = g.hangman
      if (!h) throw new Error('אין משחק פעיל, התחל עם action=new')
      if (action === 'status') return show(h)
      if (action !== 'guess') throw new Error('פעולה לא מוכרת')
      const guess = norm(need(letter, 'אות'))
      if (!guess) throw new Error('אות לא תקינה')
      const target = norm(h.word)
      if (guess.length > 1) {
        if (guess === target) {
          delete g.hangman
          await persist()
          return `נכון! המילה היא ${h.word}`
        }
        h.wrong.push(guess)
      } else if (h.guessed.includes(guess) || h.wrong.includes(guess)) {
        return `כבר ניחשת את ${guess}\n${show(h)}`
      } else if (target.includes(guess)) h.guessed.push(guess)
      else h.wrong.push(guess)
      if ([...target].every((c) => h.guessed.includes(c))) {
        delete g.hangman
        await persist()
        return `ניצחת! המילה היא ${h.word}`
      }
      if (h.wrong.length >= 6) {
        delete g.hangman
        await persist()
        return `הפסדת. המילה הייתה ${h.word}`
      }
      await persist()
      return show(h)
    },
  },
  {
    name: 'fun_tictactoe',
    description: 'איקס עיגול נגד הבוט (אתה X): new מתחיל, move עם משבצת 1-9.',
    parameters: obj({ action: oneOf(['new', 'move', 'status'], 'new / move / status'), cell: num('משבצת 1-9'), level: oneOf(['easy', 'hard'], 'easy אקראי, hard בלתי מנוצח') }, ['action']),
    async run({ action, cell, level }) {
      const g = await games()
      if (action === 'new') {
        g.ttt = { board: '---------', level: level === 'easy' ? 'easy' : 'hard' }
        await persist()
        return `משחק חדש (${g.ttt.level === 'easy' ? 'קל' : 'קשה'}). תורך:\n${renderBoard(g.ttt.board)}`
      }
      const t = g.ttt
      if (!t) throw new Error('אין משחק פעיל, התחל עם action=new')
      if (action === 'status') return renderBoard(t.board)
      if (action !== 'move') throw new Error('פעולה לא מוכרת')
      const i = Math.trunc(toNumber(need(cell, 'משבצת'), 'משבצת')) - 1
      if (i < 0 || i > 8) throw new Error('משבצת חייבת להיות בין 1 ל-9')
      if (t.board[i] !== '-') throw new Error('המשבצת תפוסה')
      t.board = t.board.slice(0, i) + 'X' + t.board.slice(i + 1)
      let w = winner(t.board)
      if (!w) {
        const m = botMove(t.board, t.level, (n) => randomInt(n))
        t.board = t.board.slice(0, m) + 'O' + t.board.slice(m + 1)
        w = winner(t.board)
      }
      const b = renderBoard(t.board)
      if (w) delete g.ttt
      await persist()
      if (w === 'X') return `${b}\nניצחת!`
      if (w === 'O') return `${b}\nאני ניצחתי`
      if (w === 'draw') return `${b}\nתיקו`
      return `${b}\nתורך`
    },
  },
  {
    name: 'fun_compliment',
    description: 'מחמיא בחום, אפשר לשם מסוים.',
    parameters: obj({ name: str('שם (לא חובה)'), seed: str('זרע (לא חובה)') }, []),
    run({ name, seed }) {
      const c = pickFrom(COMPLIMENTS, rng(seed))
      return name ? `${String(name).slice(0, 40)}, ${c}` : c
    },
  },
  {
    name: 'fun_decide',
    description: 'עוזר להחליט: מדרג אפשרויות לפי קריטריונים עם משקלים.',
    parameters: obj(
      {
        criteria: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, weight: { type: 'number' } } }, description: 'קריטריונים עם משקל 1-10' },
        options: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, scores: { type: 'array', items: { type: 'number' } } } }, description: 'אפשרויות, עם ציון 1-10 לכל קריטריון באותו סדר' },
      },
      ['criteria', 'options'],
    ),
    run({ criteria, options }) {
      if (!Array.isArray(criteria) || !criteria.length || criteria.length > 20) throw new Error('צריך בין 1 ל-20 קריטריונים')
      if (!Array.isArray(options) || options.length < 2 || options.length > 30) throw new Error('צריך בין 2 ל-30 אפשרויות')
      const ws = criteria.map((c) => {
        const w = c.weight === undefined ? 1 : toNumber(c.weight, 'משקל')
        if (w < 0 || w > 100) throw new Error('משקל חייב להיות בין 0 ל-100')
        return w
      })
      const total = ws.reduce((a, b) => a + b, 0)
      if (total <= 0) throw new Error('סכום המשקלים חייב להיות חיובי')
      const ranked = options
        .map((o) => {
          if (!o?.name || !Array.isArray(o.scores) || o.scores.length !== criteria.length) throw new Error(`לאפשרות "${o?.name ?? '?'}" צריך ${criteria.length} ציונים`)
          const score = o.scores.reduce((s, v, i) => s + toNumber(v, 'ציון') * ws[i], 0) / total
          return { name: String(o.name).slice(0, 60), score }
        })
        .sort((a, b) => b.score - a.score)
      return `${ranked.map((r, i) => `${i + 1}. ${r.name}: ${r.score.toFixed(2)}`).join('\n')}\nהמנצח: ${ranked[0].name}`
    },
  },
  {
    name: 'fun_name',
    description: 'מגריל שמות ישראליים אקראיים (פרטי ומשפחה).',
    parameters: obj({ gender: oneOf(['boy', 'girl', 'any'], 'בן, בת או כל אחד'), count: num('כמה שמות (עד 20)'), seed: str('זרע (לא חובה)') }, []),
    run({ gender, count, seed }) {
      const r = rng(seed)
      const n = intArg(count, 'כמות', 1, 20, 1)
      const pool = gender === 'boy' ? BOYS : gender === 'girl' ? GIRLS : [...BOYS, ...GIRLS]
      return Array.from({ length: n }, () => `${pickFrom(pool, r)} ${pickFrom(LASTS, r)}`).join('\n')
    },
  },
  {
    name: 'fun_palette',
    description: 'מייצר פלטת צבעים אקראית ומתואמת עם קודי hex.',
    parameters: obj({ count: num('כמה צבעים 2-10 (ברירת מחדל 5)'), seed: str('זרע (לא חובה)') }, []),
    run({ count, seed }) {
      const r = rng(seed)
      const n = intArg(count, 'כמות', 2, 10, 5)
      const base = r(360)
      const cols = Array.from({ length: n }, (_, i) => hslToHex((base + Math.round((360 / n) * i * 0.5) + r(20)) % 360, 50 + r(40), 35 + r(40)))
      return `פלטת ${pickFrom(PALETTE_NAMES, r)}:\n${cols.join('  ')}`
    },
  },
  {
    name: 'fun_suggest',
    description: 'מציע מה לאכול, מה לראות או מה לעשות כשאין רעיון.',
    parameters: obj({ kind: oneOf(['eat', 'watch', 'do'], 'eat / watch / do'), seed: str('זרע (לא חובה)') }, ['kind']),
    run({ kind, seed }) {
      const map = { eat: ['לאכול', FOOD], watch: ['לראות', WATCH], do: ['לעשות', DO] }
      const e = map[kind]
      if (!e) throw new Error('בחר eat, watch או do')
      return `מה ${e[0]}: ${pickFrom(e[1], rng(seed))}`
    },
  },
  {
    name: 'fun_bracket',
    description: 'בונה טורניר הדחה מרשימת שמות: סבב ראשון עם פטורים אם צריך.',
    parameters: obj({ names: { type: 'array', items: { type: 'string' }, description: 'המשתתפים (2 עד 64)' }, shuffle: bool('לערבב (ברירת מחדל כן)'), seed: str('זרע (לא חובה)') }, ['names']),
    run({ names, shuffle, seed }) {
      const list = toList(names, 'משתתפים', { min: 2, max: 64 })
      const order = shuffle === false ? list : shuffled(list, rng(seed))
      let size = 2
      while (size < order.length) size *= 2
      const byes = size - order.length
      const out = []
      let idx = 0
      for (let m = 0; m < size / 2; m++) {
        if (m < byes) out.push(`${order[idx++]} - פטור`)
        else {
          out.push(`${order[idx]} נגד ${order[idx + 1]}`)
          idx += 2
        }
      }
      const rounds = Math.log2(size)
      const names2 = { 1: 'גמר', 2: 'חצי גמר', 3: 'רבע גמר' }
      return `${order.length} משתתפים, ${rounds} סבבים (${names2[rounds] ?? `סבב ראשון מתוך ${rounds}`} בסבב הראשון)\nסבב 1:\n${out.map((x, i) => `${i + 1}. ${x}`).join('\n')}`
    },
  },
]

export const tests = [
  { tool: 'fun_dice', args: { notation: '2d6+3', seed: 'a' }, check: (r) => /סה"כ: (\d+)/.test(r) && Number(/סה"כ: (\d+)/.exec(r)[1]) >= 5 && Number(/סה"כ: (\d+)/.exec(r)[1]) <= 15 },
  { tool: 'fun_dice', args: { notation: '0d6' }, throws: true, check: () => false },
  { tool: 'fun_coin', args: { times: 10 }, check: (r) => /עץ: \d+, פלי: \d+/.test(r) },
  { tool: 'fun_pick', args: { items: ['א', 'ב', 'ג'], count: 2, seed: 1 }, check: (r) => r.split('\n').length === 2 },
  { tool: 'fun_shuffle', args: { items: 'א,ב,ג,ד' }, check: (r) => r.split('\n').length === 4 },
  { tool: 'fun_random_number', args: { min: 5, max: 9, count: 4, unique: true }, check: (r) => { const a = r.split(', ').map(Number); return a.length === 4 && new Set(a).size === 4 && a.every((x) => x >= 5 && x <= 9) } },
  { tool: 'fun_teams', args: { names: ['א', 'ב', 'ג', 'ד', 'ה'], teams: 2 }, check: (r) => r.split('\n').length === 2 && r.includes('קבוצה 2') },
  { tool: 'fun_draw_order', args: { names: ['א', 'ב', 'ג'] }, check: (r) => r.includes('מתחיל:') && r.includes('סדר מלא') },
  { tool: 'fun_password', args: { length: 20 }, check: (r) => r.length === 20 && /\d/.test(r) && /[a-z]/.test(r) && /[A-Z]/.test(r) && /[^a-zA-Z0-9]/.test(r) },
  { tool: 'fun_password', args: { mode: 'passphrase', words: 4 }, check: (r) => r.split('-').length === 5 && WORDS.length >= 200 },
  { tool: 'fun_question', args: { kind: 'truth' }, check: (r) => r.startsWith('אמת:') && TRUTH.length >= 25 && WYR.length >= 25 && DARE.length >= 25 && ICE.length >= 25 },
  { tool: 'fun_trivia', args: { seed: 'x' }, check: (r) => /#\d+/.test(r) && TRIVIA.length >= 40 },
  { tool: 'fun_trivia_answer', args: { id: 1, answer: 'פריס' }, check: (r) => r.startsWith('נכון') },
  { tool: 'fun_trivia_answer', args: { id: 2, answer: '6' }, check: (r) => r.startsWith('נכון') },
  { tool: 'fun_trivia_answer', args: { id: 1, answer: 'לונדון' }, check: (r) => r.startsWith('לא מדויק') },
  { tool: 'fun_riddle', args: { id: 1, reveal: true }, check: (r) => r.includes('מדרגות') && RIDDLES.length >= 20 },
  { tool: 'fun_8ball', args: { question: 'האם אעבור?' }, check: (r) => r.includes('🎱') },
  { tool: 'fun_rps', args: { choice: 'reset' }, check: (r) => r.includes('אופס') },
  { tool: 'fun_rps', args: { choice: 'אבן' }, check: (r) => r.includes('ניקוד:') },
  { tool: 'fun_guess', args: { action: 'new', min: 1, max: 10 }, check: (r) => r.includes('בין 1 ל-10') },
  { tool: 'fun_guess', args: { action: 'guess', number: 5 }, check: (r) => /נכון|גבוה|נמוך/.test(r) },
  { tool: 'fun_hangman', args: { action: 'new' }, check: (r) => r.includes('_') },
  { tool: 'fun_hangman', args: { action: 'guess', letter: 'א' }, check: (r) => r.includes('טעויות') || r.includes('ניצחת') || r.includes('הפסדת') },
  { tool: 'fun_tictactoe', args: { action: 'new', level: 'hard' }, check: (r) => r.includes('1 | 2 | 3') },
  { tool: 'fun_tictactoe', args: { action: 'move', cell: 5 }, check: (r) => r.includes('X') && r.includes('O') },
  { tool: 'fun_compliment', args: { name: 'דני' }, check: (r) => r.startsWith('דני,') },
  { tool: 'fun_decide', args: { criteria: [{ name: 'מחיר', weight: 3 }, { name: 'איכות', weight: 1 }], options: [{ name: 'א', scores: [9, 5] }, { name: 'ב', scores: [3, 5] }] }, check: (r) => r.includes('המנצח: א') },
  { tool: 'fun_name', args: { gender: 'girl', count: 3 }, check: (r) => r.split('\n').length === 3 },
  { tool: 'fun_palette', args: { count: 4 }, check: (r) => (r.match(/#[0-9a-f]{6}/g) ?? []).length === 4 },
  { tool: 'fun_suggest', args: { kind: 'eat' }, check: (r) => r.startsWith('מה לאכול:') },
  { tool: 'fun_bracket', args: { names: ['א', 'ב', 'ג', 'ד', 'ה'], shuffle: false }, check: (r) => r.includes('ה - פטור') === false && r.includes('פטור') && r.includes('3 סבבים') },
]
