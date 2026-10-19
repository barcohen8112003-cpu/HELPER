// Fitness, nutrition and wellbeing calculators. All estimates, none of it is medical advice.
import { str, num, obj, oneOf, toNumber, need, fetchJson } from './_kit.js'

export const category = 'health'
export const blurb = 'כושר, תזונה וחישובי בריאות'

const NOTE = 'הערכה בלבד, לא ייעוץ רפואי.'
const r1 = (n) => Math.round(n * 10) / 10

function range(value, name, min, max, unit = '') {
  const n = toNumber(need(value, name), name)
  if (n < min || n > max) throw new Error(`${name} חייב להיות בין ${min} ל-${max}${unit}`)
  return n
}
const age = (v) => range(v, 'גיל', 1, 120, ' שנים')
const weight = (v) => range(v, 'משקל', 20, 400, ' ק"ג')
const height = (v) => range(v, 'גובה', 80, 250, ' ס"מ')
function sexOf(v) {
  if (v !== 'male' && v !== 'female') throw new Error('מין צריך להיות male או female')
  return v
}

const ACTIVITY = {
  sedentary: [1.2, 'יושבני, כמעט בלי פעילות'],
  light: [1.375, 'פעילות קלה 1-3 ימים בשבוע'],
  moderate: [1.55, 'פעילות בינונית 3-5 ימים בשבוע'],
  active: [1.725, 'פעילות אינטנסיבית 6-7 ימים בשבוע'],
  very_active: [1.9, 'פעילות מאוד אינטנסיבית או עבודה פיזית'],
}
const activityIds = Object.keys(ACTIVITY)
const activityOf = (v = 'sedentary') => {
  if (!ACTIVITY[v]) throw new Error('רמת פעילות לא מוכרת')
  return ACTIVITY[v]
}

function bmr(sex, w, h, a) {
  return 10 * w + 6.25 * h - 5 * a + (sex === 'male' ? 5 : -161)
}

// "1:30:00", "50:00" (minutes:seconds) or a plain number of minutes -> seconds
function parseDuration(v, name = 'זמן') {
  need(v, name)
  if (typeof v === 'number') return v * 60
  const s = String(v).trim()
  if (!s.includes(':')) return toNumber(s, name) * 60
  const p = s.split(':').map((x) => toNumber(x, name))
  if (p.length === 2) return p[0] * 60 + p[1]
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2]
  throw new Error(`${name} לא תקין`)
}
function fmtDur(sec) {
  const t = Math.round(sec)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  const mm = h ? String(m).padStart(2, '0') : String(m)
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

function parseClock(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(need(v, 'שעה')).trim())
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error('שעה צריכה להיות בפורמט HH:MM')
  return Number(m[1]) * 60 + Number(m[2])
}
const fmtClock = (mins) => {
  const t = ((Math.round(mins) % 1440) + 1440) % 1440
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

const CAFFEINE = {
  espresso: ['שוט אספרסו (30 מ"ל)', 63],
  filter_coffee: ['קפה פילטר (240 מ"ל)', 95],
  instant_coffee: ['קפה נמס (240 מ"ל)', 62],
  black_tea: ['תה שחור (240 מ"ל)', 47],
  green_tea: ['תה ירוק (240 מ"ל)', 28],
  cola: ['קולה (330 מ"ל)', 34],
  energy_drink: ['משקה אנרגיה (250 מ"ל)', 80],
  dark_chocolate: ['שוקולד מריר (50 גרם)', 25],
  decaf: ['קפה נטול קפאין (240 מ"ל)', 3],
}

const MET = {
  walking: ['הליכה מתונה', 3.5],
  brisk_walking: ['הליכה מהירה', 4.3],
  hiking: ['טיול רגלי', 6.0],
  running_8: ['ריצה 8 קמ"ש', 8.3],
  running_10: ['ריצה 10 קמ"ש', 9.8],
  running_12: ['ריצה 12 קמ"ש', 11.8],
  cycling_easy: ['רכיבה רגועה', 4.0],
  cycling_moderate: ['רכיבה בינונית', 8.0],
  swimming: ['שחייה בקצב בינוני', 5.8],
  weights: ['אימון כוח', 5.0],
  yoga: ['יוגה', 2.5],
  hiit: ['אימון אינטרוולים', 8.0],
  football: ['כדורגל', 7.0],
  basketball: ['כדורסל', 6.5],
  dancing: ['ריקוד', 5.0],
  housework: ['עבודות בית', 3.3],
}

const COOKING = {
  chicken: ['עוף', 'טמפרטורה פנימית בטוחה: 74°C (בנקודה העבה ביותר). חזה בתנור 200°C: כ-20-25 דקות; ירכיים: כ-35-45 דקות. לתת למנוח 5 דקות.'],
  steak_rare: ['סטייק, לא עשוי (rare)', 'טמפרטורה פנימית 52°C, בערך 2-3 דקות מכל צד במחבת חמה (לסטייק בעובי 2.5 ס"מ). שים לב: ההמלצה הרשמית לבשר בקר שלם היא 63°C.'],
  steak_medium_rare: ['סטייק, מדיום רייר', 'טמפרטורה פנימית 57°C, בערך 3-4 דקות מכל צד. מנוחה 5 דקות לפני החיתוך.'],
  steak_medium: ['סטייק, מדיום', 'טמפרטורה פנימית 63°C, בערך 4-5 דקות מכל צד. מנוחה 5 דקות.'],
  steak_medium_well: ['סטייק, מדיום וול', 'טמפרטורה פנימית 68°C, בערך 5-6 דקות מכל צד.'],
  steak_well: ['סטייק, וול דאן', 'טמפרטורה פנימית 71°C ומעלה, בערך 6-7 דקות מכל צד.'],
  burger: ['המבורגר (בשר טחון)', 'בשר טחון צריך להגיע ל-71°C בפנים. כ-4-5 דקות מכל צד.'],
  pork: ['חזיר', 'טמפרטורה פנימית 63°C ואז מנוחה 3 דקות.'],
  fish: ['דג', 'טמפרטורה פנימית 63°C, או כשהבשר אטום ונפרד בקלות במזלג. פילה בתנור 200°C: כ-10-15 דקות.'],
  eggs_soft: ['ביצה רכה', 'להכניס למים רותחים: 6 דקות לחלמון נוזלי, 7 דקות לחלמון רך. מיד למים קרים.'],
  eggs_hard: ['ביצה קשה', 'להכניס למים רותחים: 10-12 דקות, ואז למים קרים.'],
  rice: ['אורז לבן', 'יחס 1 כוס אורז ל-2 כוסות מים, להרתיח, להנמיך אש ולכסות 15-18 דקות, ואז לנוח מכוסה 10 דקות.'],
  pasta: ['פסטה', 'כ-100 גרם פסטה לכל ליטר מים רותחים עם כ-10 גרם מלח. לבשל לפי האריזה פחות דקה לאל דנטה (בדרך כלל 8-11 דקות).'],
}

const FIRST_AID = {
  burn: {
    name: 'כוויה',
    keys: ['כוויה', 'כויה', 'נכוויתי', 'burn'],
    steps: ['לקרר מיד במים זורמים פושרים-קרים כ-20 דקות', 'להסיר טבעות ותכשיטים לפני שהאזור מתנפח', 'לכסות בתחבושת נקייה ולא דביקה', 'לא להשתמש בקרח, משחת שיניים, שמן או חמאה ולא לפקוע שלפוחיות'],
    call: 'הכוויה גדולה מכף יד, בפנים, בידיים, באיברי המין או במפרק, עמוקה או לבנה/שחורה, כוויה כימית או חשמלית, או אצל תינוק/קשיש',
  },
  bleeding: {
    name: 'דימום',
    keys: ['דימום', 'דם', 'חתך', 'bleeding'],
    steps: ['ללבוש כפפות אם יש', 'ללחוץ ישירות על הפצע עם בד נקי או תחבושת', 'להמשיך ללחוץ בלי להרים להציץ, ולהרים את האיבר המדמם מעל הלב', 'אם הבד מתמלא בדם, להוסיף עוד שכבה מעליו'],
    call: 'הדימום חזק או מפכה, לא נעצר אחרי 10 דקות של לחץ, או שיש סחרחורת, חיוורון או איבוד הכרה',
  },
  choking: {
    name: 'חנק',
    keys: ['חנק', 'נחנק', 'נחנקת', 'choking'],
    steps: ['לשאול "אתה נחנק?" אם האדם לא יכול לדבר, לשעול או לנשום זו חסימה מלאה', 'במבוגר: 5 מכות חזקות בין השכמות, ואז 5 לחיצות בטן (תמרון היימליך)', 'לחזור לסירוגין עד שהחפץ יוצא', 'בתינוק מתחת לגיל שנה: 5 מכות גב ו-5 לחיצות חזה בשתי אצבעות, לא לחיצות בטן'],
    call: 'מיד בחסימה מלאה (להתקשר ולהמשיך בפעולות), או אם האדם מאבד הכרה (להתחיל החייאה)',
  },
  nosebleed: {
    name: 'דימום מהאף',
    keys: ['אף', 'nosebleed'],
    steps: ['לשבת זקוף ולהטות את הראש מעט קדימה, לא אחורה', 'ללחוץ על חלק האף הרך בשתי אצבעות 10 דקות ברצף', 'לנשום דרך הפה, אפשר קומפרס קר על הגשר', 'אחרי שנעצר, להימנע מנשיפת אף וממאמץ כמה שעות'],
    call: 'הדימום נמשך מעל 20 דקות, היה אחרי מכה חזקה בראש, או שיש קושי בנשימה',
  },
  sprain: {
    name: 'נקע או מכה בגפיים',
    keys: ['נקע', 'נקעתי', 'קרסול', 'sprain', 'שריר'],
    steps: ['מנוחה והפסקת הפעילות', 'קרח עטוף בבד 15-20 דקות כל כמה שעות', 'חבישה אלסטית בלחץ עדין', 'הרמת האיבר מעל גובה הלב'],
    call: 'יש עיוות נראה לעין, אי אפשר להניח משקל על הרגל, חוסר תחושה, או כאב עז. כדאי להיבדק אצל רופא כדי לשלול שבר',
  },
  fracture: {
    name: 'חשד לשבר',
    keys: ['שבר', 'שברתי', 'fracture'],
    steps: ['לא להזיז את האיבר ולא לנסות ליישר אותו', 'לקבע במצבו בעזרת סד מאולתר או בד', 'קרח עטוף בבד להפחתת נפיחות', 'אם יש פצע פתוח, לכסות בתחבושת נקייה בלי ללחוץ על העצם'],
    call: 'חשד לשבר בגב, צוואר, ראש או אגן, שבר פתוח, או איבר כחלחל וקר. בשאר המקרים לפנות דחוף לחדר מיון',
  },
  fainting: {
    name: 'עילפון',
    keys: ['עילפון', 'התעלף', 'התעלפות', 'סחרחורת', 'fainting'],
    steps: ['להשכיב על הגב ולהרים את הרגליים כ-30 ס"מ', 'לשחרר בגדים צמודים ולוודא אוויר צח', 'לבדוק נשימה', 'כשחוזר להכרה, להושיב לאט ולתת לנוח'],
    call: 'לא חוזר להכרה תוך דקה, אינו נושם, קרה אחרי מכה בראש או עם כאב בחזה, או שמדובר בהריון/סכרת',
  },
  heat: {
    name: 'מכת חום',
    keys: ['חום', 'מכת חום', 'התייבשות', 'heat'],
    steps: ['להעביר לצל או למקום ממוזג', 'להסיר בגדים מיותרים ולקרר בעזרת מים וביגוד רטוב ומאוורר', 'אם הוא בהכרה מלאה, לתת לשתות מים קרים בלגימות', 'להמשיך לקרר עד שהגוף מתקרר'],
    call: 'מיד: בלבול, חוסר הכרה, עור חם ויבש, פרכוסים או חום גוף גבוה. מכת חום היא מצב סכנת חיים',
  },
  allergy: {
    name: 'עקיצה ותגובה אלרגית',
    keys: ['עקיצה', 'דבורה', 'אלרגיה', 'אלרגית', 'allergy', 'צרעה'],
    steps: ['להרחיק מהמקור, ובעקיצת דבורה להסיר את העוקץ בגרידה לצדדים', 'לשטוף במים וסבון ולהניח קרח עטוף בבד', 'לעקוב אחרי הסימנים במשך לפחות חצי שעה', 'מי שיש לו מזרק אפינפרין ייעודי שנקבע לו על ידי רופא, משתמש בו לפי ההנחיה שקיבל'],
    call: 'מיד אם יש קושי בנשימה, נפיחות בפנים/שפתיים/לשון, פריחה נרחבת, סחרחורת או הקאות אחרי העקיצה',
  },
  cpr: {
    name: 'החייאה (אדם שלא מגיב ולא נושם)',
    keys: ['החייאה', 'לא נושם', 'דום לב', 'cpr'],
    steps: ['לוודא שהמקום בטוח, לנער ולקרוא בקול. אם אין תגובה ואין נשימה רגילה, להתקשר ל-101', 'להניח את כף היד במרכז החזה ולבצע לחיצות עמוקות של כ-5-6 ס"מ בקצב 100-120 בדקה', 'אם יש דפיברילטור (AED) להפעיל אותו ולפעול לפי ההוראות הקוליות', 'להמשיך עד שמגיע צוות רפואי או שהאדם מתחיל לנשום'],
    call: 'מיד, לפני תחילת ההחייאה. מוקדן מד"א ידריך אתכם בטלפון',
  },
  seizure: {
    name: 'פרכוס',
    keys: ['פרכוס', 'התקף', 'אפילפסיה', 'seizure'],
    steps: ['להרחיק חפצים מסוכנים ולהניח משהו רך מתחת לראש', 'לא להחזיק את האדם ולא לשים שום דבר בפה', 'לשים לב לשעה ולמדוד כמה זמן הפרכוס נמשך', 'בסיום להפנות על הצד ולהישאר איתו עד שמתאושש'],
    call: 'הפרכוס נמשך מעל 5 דקות, חוזר, האדם לא חוזר להכרה, זו פעם ראשונה, או שהאדם נפצע, בהריון או היה במים',
  },
  eye: {
    name: 'חומר בעין',
    keys: ['עין', 'חומר כימי בעין', 'eye'],
    steps: ['לשטוף את העין מיד במים זורמים פושרים לפחות 15 דקות, כשהעין פתוחה', 'להטות את הראש כך שהמים לא יזרמו לעין השנייה', 'לא לשפשף את העין', 'להסיר עדשות מגע אם אפשר'],
    call: 'חומר כימי חזק (אקונומיקה, חומצה, סיד), חפץ תקוע בעין, פגיעה חדה או ירידה בראייה. לפנות לחדר מיון',
  },
  poison: {
    name: 'בליעת חומר חשוד כרעיל',
    keys: ['הרעלה', 'רעל', 'בליעה', 'poison'],
    steps: ['להרחיק את האדם מהחומר ולהחזיק את האריזה', 'לא לגרום להקאה ולא לתת לשתות שום דבר אלא אם הונחה לכך', 'להתקשר למרכז המידע הלאומי להרעלות או ל-101 ולמסור מה נבלע, כמה וכמה זמן עבר'],
    call: 'מיד אם האדם מנומנם, מקיא, מתקשה לנשום, מפרכס או שהחומר מסוכן. מרכז הרעלות (רמב"ם): 04-7771900',
  },
}

const FOOD_LOOKUP_MAX = 80

export const tools = [
  {
    name: 'health_bmi',
    description: 'מחשב BMI וקטגוריה לפי משקל וגובה (הערכה כללית בלבד).',
    parameters: obj({ weight_kg: num('משקל בק"ג'), height_cm: num('גובה בס"מ') }),
    run({ weight_kg, height_cm }) {
      const w = weight(weight_kg)
      const h = height(height_cm)
      const bmi = w / (h / 100) ** 2
      const cat = bmi < 18.5 ? 'תת משקל' : bmi < 25 ? 'משקל תקין' : bmi < 30 ? 'עודף משקל' : 'השמנה'
      const lo = r1(18.5 * (h / 100) ** 2)
      const hi = r1(24.9 * (h / 100) ** 2)
      return `BMI: ${r1(bmi)} (${cat}). טווח משקל תקין לגובה הזה: ${lo}-${hi} ק"ג. BMI לא מבדיל בין שריר לשומן. ${NOTE}`
    },
  },
  {
    name: 'health_tdee',
    description: 'מחשב BMR (משוואת מיפלין-סן ג׳אור) וצריכת קלוריות יומית כוללת לפי רמת פעילות.',
    parameters: obj(
      { sex: oneOf(['male', 'female'], 'מין'), age: num('גיל'), weight_kg: num('משקל בק"ג'), height_cm: num('גובה בס"מ'), activity: oneOf(activityIds, 'sedentary, light, moderate, active, very_active') },
      ['sex', 'age', 'weight_kg', 'height_cm'],
    ),
    run({ sex, age: a, weight_kg, height_cm, activity }) {
      const [factor, label] = activityOf(activity)
      const b = bmr(sexOf(sex), weight(weight_kg), height(height_cm), age(a))
      return `BMR: ${Math.round(b)} קלוריות ביום במנוחה. TDEE (${label}, x${factor}): ${Math.round(b * factor)} קלוריות ביום. ${NOTE}`
    },
  },
  {
    name: 'health_calorie_target',
    description: 'יעד קלוריות יומי להורדה, שמירה או עלייה במשקל לפי נתוני הגוף והפעילות.',
    parameters: obj(
      { sex: oneOf(['male', 'female'], 'מין'), age: num('גיל'), weight_kg: num('משקל בק"ג'), height_cm: num('גובה בס"מ'), activity: oneOf(activityIds, 'רמת פעילות'), goal: oneOf(['lose', 'maintain', 'gain'], 'lose: -500, maintain, gain: +300') },
      ['sex', 'age', 'weight_kg', 'height_cm', 'goal'],
    ),
    run({ sex, age: a, weight_kg, height_cm, activity, goal }) {
      const s = sexOf(sex)
      const tdee = bmr(s, weight(weight_kg), height(height_cm), age(a)) * activityOf(activity)[0]
      const delta = { lose: -500, maintain: 0, gain: 300 }[goal]
      if (delta === undefined) throw new Error('מטרה צריכה להיות lose, maintain או gain')
      const target = Math.round(tdee + delta)
      const floor = s === 'male' ? 1500 : 1200
      const warn = target < floor ? ` שים לב: מתחת ל-${floor} קלוריות ביום לא מומלץ בלי ליווי מקצועי.` : ''
      const rate = delta ? ` (כ-${Math.abs(delta) === 500 ? '0.45' : '0.25'} ק"ג בשבוע ${delta < 0 ? 'ירידה' : 'עלייה'})` : ''
      return `TDEE: ${Math.round(tdee)}. יעד יומי: ${target} קלוריות${rate}.${warn} ${NOTE}`
    },
  },
  {
    name: 'health_macros',
    description: 'מחלק יעד קלוריות לחלבון, פחמימות ושומן בגרמים לפי תבנית חלוקה.',
    parameters: obj({ calories: num('קלוריות ליום'), split: oneOf(['balanced', 'low_carb', 'high_protein'], 'balanced 30/40/30, low_carb 35/25/40, high_protein 40/35/25 (חלבון/פחמימה/שומן)') }, ['calories']),
    run({ calories, split = 'balanced' }) {
      const kcal = range(calories, 'קלוריות', 800, 8000)
      const sp = { balanced: [30, 40, 30], low_carb: [35, 25, 40], high_protein: [40, 35, 25] }[split]
      if (!sp) throw new Error('תבנית חלוקה לא מוכרת')
      const p = (kcal * sp[0]) / 100 / 4
      const c = (kcal * sp[1]) / 100 / 4
      const f = (kcal * sp[2]) / 100 / 9
      return `${Math.round(kcal)} קלוריות (${sp[0]}/${sp[1]}/${sp[2]}): חלבון ${Math.round(p)} גרם, פחמימות ${Math.round(c)} גרם, שומן ${Math.round(f)} גרם. ${NOTE}`
    },
  },
  {
    name: 'health_water',
    description: 'ממליץ על כמות מים יומית לפי משקל, זמן פעילות גופנית ויום חם.',
    parameters: obj({ weight_kg: num('משקל בק"ג'), exercise_minutes: num('דקות פעילות ביום, ברירת מחדל 0'), hot_day: { type: 'boolean', description: 'יום חם (+500 מ"ל)' } }, ['weight_kg']),
    run({ weight_kg, exercise_minutes = 0, hot_day = false }) {
      const w = weight(weight_kg)
      const ex = range(exercise_minutes, 'דקות פעילות', 0, 600)
      const ml = w * 33 + (ex / 30) * 350 + (hot_day ? 500 : 0)
      return `המלצה: כ-${Math.round(ml / 10) * 10} מ"ל מים ביום (כ-${r1(ml / 250)} כוסות של 250 מ"ל). חישוב: 33 מ"ל לק"ג + 350 מ"ל לכל 30 דקות פעילות${hot_day ? ' + 500 מ"ל ליום חם' : ''}. חלק מהכמות מגיע גם מאוכל ומשקאות. ${NOTE}`
    },
  },
  {
    name: 'health_sleep_times',
    description: 'מחשב שעות שינה או השכמה אידיאליות לפי מחזורי שינה של 90 דקות.',
    parameters: obj({ mode: oneOf(['wake_at', 'sleep_at'], 'wake_at: מתי ללכת לישון כדי לקום בשעה X. sleep_at: מתי לקום אם נרדמים בשעה X'), time: str('שעה בפורמט HH:MM'), fall_asleep_minutes: num('כמה דקות לוקח להירדם, ברירת מחדל 15') }, ['mode', 'time']),
    run({ mode, time, fall_asleep_minutes = 15 }) {
      const t = parseClock(time)
      const lag = range(fall_asleep_minutes, 'זמן הירדמות', 0, 120)
      if (mode === 'wake_at') {
        const opts = [6, 5, 4].map((n) => `${fmtClock(t - n * 90 - lag)} (${n} מחזורים, ${n * 1.5} שעות)`)
        return `כדי לקום ב-${time}, כדאי ללכת לישון ב: ${opts.join(' | ')}. מחשבים ${lag} דקות הירדמות ומחזור של 90 דקות.`
      }
      if (mode === 'sleep_at') {
        const opts = [4, 5, 6].map((n) => `${fmtClock(t + lag + n * 90)} (${n} מחזורים, ${n * 1.5} שעות)`)
        return `אם הולכים לישון ב-${time}, שעות קימה טובות: ${opts.join(' | ')}. מבוגרים צריכים בדרך כלל 7-9 שעות.`
      }
      throw new Error('מצב צריך להיות wake_at או sleep_at')
    },
  },
  {
    name: 'food_caffeine',
    description: 'מעריך קפאין במשקאות נפוצים, וכמה נשאר בגוף אחרי כמה שעות (מחצית חיים).',
    parameters: obj(
      { drink: oneOf(Object.keys(CAFFEINE), Object.entries(CAFFEINE).map(([k, v]) => `${k}=${v[0]}`).join(', ')), count: num('כמות, ברירת מחדל 1'), hours_since: num('שעות מאז השתייה, ברירת מחדל 0'), half_life_hours: num('מחצית חיים בשעות, ברירת מחדל 5') },
      ['drink'],
    ),
    run({ drink, count = 1, hours_since = 0, half_life_hours = 5 }) {
      const d = CAFFEINE[drink]
      if (!d) throw new Error(`משקה לא מוכר. אפשרויות: ${Object.keys(CAFFEINE).join(', ')}`)
      const n = range(count, 'כמות', 0.5, 50)
      const hrs = range(hours_since, 'שעות', 0, 72)
      const half = range(half_life_hours, 'מחצית חיים', 1, 24)
      const total = d[1] * n
      const left = total * 0.5 ** (hrs / half)
      return `${n} x ${d[0]}: כ-${Math.round(total)} מ"ג קפאין. אחרי ${hrs} שעות (מחצית חיים ${half} שעות) נשארים כ-${Math.round(left)} מ"ג. לשם השוואה, עד 400 מ"ג ביום נחשב בדרך כלל סביר למבוגר בריא; הערכים משתנים בין מוצרים. ${NOTE}`
    },
  },
  {
    name: 'health_heart_zones',
    description: 'מחשב דופק מקסימלי ואזורי דופק לאימון, עם דופק מנוחה בשיטת קרבונן.',
    parameters: obj({ age: num('גיל'), resting_hr: num('דופק מנוחה, אופציונלי (מפעיל שיטת קרבונן)') }, ['age']),
    run({ age: a, resting_hr }) {
      const maxHr = 220 - age(a)
      const zones = [
        ['1 התאוששות', 50, 60],
        ['2 שריפת שומן / סיבולת קלה', 60, 70],
        ['3 אירובי', 70, 80],
        ['4 סף', 80, 90],
        ['5 מקסימום', 90, 100],
      ]
      if (resting_hr === undefined || resting_hr === null || resting_hr === '') {
        const rows = zones.map(([n, lo, hi]) => `אזור ${n}: ${Math.round((maxHr * lo) / 100)}-${Math.round((maxHr * hi) / 100)}`)
        return lines2(`דופק מקסימלי (220 פחות גיל): ${maxHr}`, rows, 'אפשר להוסיף דופק מנוחה לחישוב מדויק יותר. ' + NOTE)
      }
      const rest = range(resting_hr, 'דופק מנוחה', 30, 130)
      if (rest >= maxHr) throw new Error('דופק המנוחה חייב להיות נמוך מהדופק המקסימלי')
      const reserve = maxHr - rest
      const rows = zones.map(([n, lo, hi]) => `אזור ${n}: ${Math.round((reserve * lo) / 100 + rest)}-${Math.round((reserve * hi) / 100 + rest)}`)
      return lines2(`דופק מקסימלי (220 פחות גיל): ${maxHr}, דופק מנוחה ${rest}, רזרבה ${reserve} (קרבונן)`, rows, NOTE)
    },
  },
  {
    name: 'health_one_rep_max',
    description: 'מעריך חזרה מקסימלית אחת (1RM) מתוך משקל ומספר חזרות, בנוסחאות Epley ו-Brzycki.',
    parameters: obj({ weight: num('המשקל שהורם בק"ג'), reps: num('מספר חזרות (1-12)') }),
    run({ weight: w, reps }) {
      const wt = range(w, 'משקל', 1, 700, ' ק"ג')
      const r = Math.floor(range(reps, 'חזרות', 1, 12))
      const epley = r === 1 ? wt : wt * (1 + r / 30)
      const brz = (wt * 36) / (37 - r)
      const avg = (epley + brz) / 2
      const pct = [90, 80, 70, 60].map((p) => `${p}%: ${r1((avg * p) / 100)}`).join(', ')
      return `1RM משוער: Epley ${r1(epley)} ק"ג, Brzycki ${r1(brz)} ק"ג (ממוצע ${r1(avg)}). אחוזים מהממוצע: ${pct}. הערכה בלבד, לבדוק מקסימום אמיתי רק עם מאבטח.`
    },
  },
  {
    name: 'health_pace',
    description: 'מחשב קצב ריצה למרחק וזמן, ומנבא זמני מירוץ (5K, 10K, חצי, מרתון) בנוסחת ריגל.',
    parameters: obj({ distance_km: num('מרחק בק"מ'), time: str('זמן: H:MM:SS, MM:SS או דקות כמספר') }),
    run({ distance_km, time }) {
      const d = range(distance_km, 'מרחק', 0.1, 500, ' ק"מ')
      const sec = parseDuration(time)
      if (sec <= 0) throw new Error('זמן חייב להיות חיובי')
      const pace = sec / d
      const kmh = d / (sec / 3600)
      const preds = [['5K', 5], ['10K', 10], ['חצי מרתון', 21.0975], ['מרתון', 42.195]].map(([n, km]) => `${n}: ${fmtDur(sec * (km / d) ** 1.06)}`)
      return `קצב: ${fmtDur(pace)} לק"מ, מהירות ${r1(kmh)} קמ"ש. תחזית לפי ריגל (הערכה, בהנחה של אימון מתאים): ${preds.join(', ')}`
    },
  },
  {
    name: 'health_calories_burned',
    description: 'מעריך קלוריות שנשרפו בפעילות לפי MET, משקל ומשך (הערכה גסה).',
    parameters: obj({ activity: oneOf(Object.keys(MET), Object.entries(MET).map(([k, v]) => `${k}=${v[0]}`).join(', ')), weight_kg: num('משקל בק"ג'), minutes: num('משך בדקות') }),
    run({ activity, weight_kg, minutes }) {
      const m = MET[activity]
      if (!m) throw new Error(`פעילות לא מוכרת. אפשרויות: ${Object.keys(MET).join(', ')}`)
      const mins = range(minutes, 'דקות', 1, 1440)
      const kcal = m[1] * weight(weight_kg) * (mins / 60)
      return `${m[0]} (MET ${m[1]}) למשך ${mins} דקות: כ-${Math.round(kcal)} קלוריות. נוסחה: MET x משקל x שעות. ההערכה משתנה בין אנשים. ${NOTE}`
    },
  },
  {
    name: 'health_body_fat',
    description: 'מעריך אחוז שומן בגוף בשיטת הצבא האמריקאי לפי היקפי מותניים, צוואר וגובה.',
    parameters: obj(
      { sex: oneOf(['male', 'female'], 'מין'), height_cm: num('גובה בס"מ'), waist_cm: num('היקף מותניים בס"מ (בטבור)'), neck_cm: num('היקף צוואר בס"מ'), hip_cm: num('היקף ירכיים בס"מ, לנשים בלבד') },
      ['sex', 'height_cm', 'waist_cm', 'neck_cm'],
    ),
    run({ sex, height_cm, waist_cm, neck_cm, hip_cm }) {
      const s = sexOf(sex)
      const h = height(height_cm)
      const waist = range(waist_cm, 'היקף מותניים', 40, 250)
      const neck = range(neck_cm, 'היקף צוואר', 20, 80)
      let bf
      if (s === 'male') {
        if (waist <= neck) throw new Error('היקף המותניים חייב להיות גדול מהיקף הצוואר')
        bf = 495 / (1.0324 - 0.19077 * Math.log10(waist - neck) + 0.15456 * Math.log10(h)) - 450
      } else {
        const hip = range(hip_cm, 'היקף ירכיים', 50, 250)
        if (waist + hip <= neck) throw new Error('נתוני ההיקפים לא הגיוניים')
        bf = 495 / (1.29579 - 0.35004 * Math.log10(waist + hip - neck) + 0.221 * Math.log10(h)) - 450
      }
      if (!(bf > 0 && bf < 70)) throw new Error('התוצאה לא הגיונית, בדוק את המדידות')
      return `אחוז שומן משוער: ${r1(bf)}% (שיטת הצבא האמריקאי, שגיאה אופיינית של כמה אחוזים). ${NOTE}`
    },
  },
  {
    name: 'health_protein',
    description: 'מעריך צריכת חלבון יומית בגרמים לפי משקל ומטרה.',
    parameters: obj({ weight_kg: num('משקל בק"ג'), goal: oneOf(['sedentary', 'maintain', 'lose_fat', 'build_muscle', 'endurance', 'senior'], 'sedentary, maintain, lose_fat, build_muscle, endurance, senior') }),
    run({ weight_kg, goal }) {
      const w = weight(weight_kg)
      const g = {
        sedentary: [0.8, 1.0, 'יושבני (מינימום מומלץ)'],
        maintain: [1.0, 1.4, 'שמירה על כושר'],
        lose_fat: [1.6, 2.2, 'הורדת שומן תוך שמירה על שריר'],
        build_muscle: [1.6, 2.2, 'בניית שריר'],
        endurance: [1.2, 1.6, 'ספורט סיבולת'],
        senior: [1.0, 1.2, 'גיל מבוגר'],
      }[goal]
      if (!g) throw new Error('מטרה לא מוכרת')
      return `${g[2]}: ${Math.round(w * g[0])}-${Math.round(w * g[1])} גרם חלבון ביום (${g[0]}-${g[1]} גרם לק"ג). מי שיש לו מחלת כליות או מצב רפואי צריך להתייעץ עם רופא או דיאטן. ${NOTE}`
    },
  },
  {
    name: 'food_scale_recipe',
    description: 'מכפיל או מקטין מתכון ממספר מנות אחד לאחר, משורות כמו "2 כוסות קמח".',
    parameters: obj({ ingredients: str('רכיבים, כל רכיב בשורה: "כמות יחידה שם"'), from_servings: num('מספר מנות במתכון המקורי'), to_servings: num('מספר מנות רצוי') }),
    run({ ingredients, from_servings, to_servings }) {
      const from = range(from_servings, 'מנות מקוריות', 1, 1000)
      const to = range(to_servings, 'מנות רצויות', 1, 1000)
      const factor = to / from
      const rows = String(need(ingredients, 'רכיבים')).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      if (!rows.length) throw new Error('חסרים רכיבים')
      if (rows.length > 100) throw new Error('יותר מדי שורות')
      const out = rows.map((line) => {
        const q = parseQuantity(line)
        if (!q) return `${line} (ללא כמות, לפי הטעם)`
        return `${fmtQuantity(q.value * factor)} ${q.rest}`.trim()
      })
      return `מתכון ל-${to} מנות (פי ${r1(factor * 100) / 100}):\n${out.join('\n')}\nלתבלינים ולחומרי תפיחה כדאי להתאים בזהירות ולטעום.`
    },
  },
  {
    name: 'food_cooking_guide',
    description: 'טבלת בישול מהירה: טמפרטורות פנימיות וזמנים לעוף, סטייק, ביצים, אורז ופסטה.',
    parameters: obj({ food: oneOf(Object.keys(COOKING), Object.entries(COOKING).map(([k, v]) => `${k}=${v[0]}`).join(', ')) }),
    run({ food }) {
      const c = COOKING[food]
      if (!c) throw new Error(`מאכל לא מוכר. אפשרויות: ${Object.keys(COOKING).join(', ')}`)
      return `${c[0]}: ${c[1]} הזמנים משתנים לפי עובי, תנור וציוד; מדחום בשר הוא הדרך הבטוחה.`
    },
  },
  {
    name: 'food_nutrition_lookup',
    description: 'מחפש מוצר מזון ב-Open Food Facts ומחזיר קלוריות, חלבון, שומן ופחמימות ל-100 גרם.',
    network: true,
    parameters: obj({ query: str('שם המוצר, באנגלית או בעברית') }),
    async run({ query }) {
      const q = String(need(query, 'שם מוצר')).trim().slice(0, FOOD_LOOKUP_MAX)
      const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&json=1&page_size=3&fields=product_name,brands,nutriments`
      const data = await fetchJson(url, { timeoutMs: 15000 })
      const rows = (data.products ?? []).map((p) => {
        const n = p.nutriments ?? {}
        const val = (k) => (Number.isFinite(Number(n[k])) && n[k] !== '' ? r1(Number(n[k])) : '?')
        const name = [p.product_name, p.brands].filter(Boolean).join(' - ') || 'ללא שם'
        return `${name}: ${val('energy-kcal_100g')} קלוריות, חלבון ${val('proteins_100g')} ג', שומן ${val('fat_100g')} ג', פחמימות ${val('carbohydrates_100g')} ג' (ל-100 גרם)`
      })
      if (!rows.length) return `לא נמצא מוצר עבור "${q}".`
      return `${rows.join('\n')}\nמקור: Open Food Facts, נתונים מהקהילה ועלולים להיות לא מדויקים.`
    },
  },
  {
    name: 'health_first_aid',
    description: 'עזרה ראשונה בסיסית למצבים נפוצים ומתי להתקשר למד"א 101 (לא תחליף לרופא).',
    parameters: obj({ topic: str('המצב, למשל כוויה, דימום, חנק, עילפון. ריק להצגת הרשימה') }, []),
    run({ topic }) {
      const t = String(topic ?? '').trim().toLowerCase()
      const list = Object.values(FIRST_AID).map((x) => x.name).join(', ')
      if (!t) return `מצבים זמינים: ${list}. ${NOTE} בכל מצב חירום התקשרו ל-101 (מד"א).`
      const hit = Object.values(FIRST_AID).find((x) => x.name.includes(t) || x.keys.some((k) => t.includes(k.toLowerCase()) || k.toLowerCase().includes(t)))
      if (!hit) return `לא נמצא מצב מתאים. מצבים זמינים: ${list}. בספק התקשרו ל-101.`
      return lines2(`${hit.name}:`, hit.steps.map((s, i) => `${i + 1}. ${s}`), `להתקשר ל-101 (מד"א) כש: ${hit.call}.`, 'זה מידע כללי בלבד, לא ייעוץ רפואי ולא תחליף להדרכה מוסמכת. בספק, או כשהמצב חמור, התקשרו ל-101.')
    },
  },
]

function lines2(...parts) {
  return parts.flat().filter(Boolean).join('\n')
}

const VULGAR = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125 }
function parseQuantity(line) {
  const m = /^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?[½¼¾⅓⅔⅛]?|[½¼¾⅓⅔⅛])\s*(.*)$/.exec(line)
  if (!m) return null
  const raw = m[1]
  let value
  if (/[½¼¾⅓⅔⅛]/.test(raw)) {
    const ch = raw.slice(-1)
    value = Number(raw.slice(0, -1) || 0) + VULGAR[ch]
  } else if (raw.includes('/')) {
    const parts = raw.split(/\s+/)
    const [a, b] = parts[parts.length - 1].split('/').map(Number)
    if (!b) return null
    value = (parts.length === 2 ? Number(parts[0]) : 0) + a / b
  } else value = Number(raw)
  return { value, rest: m[2] }
}
function fmtQuantity(v) {
  const whole = Math.floor(v + 1e-9)
  const frac = v - whole
  const fracs = [[0.25, '1/4'], [1 / 3, '1/3'], [0.5, '1/2'], [2 / 3, '2/3'], [0.75, '3/4']]
  if (frac < 0.02) return String(whole)
  if (frac > 0.98) return String(whole + 1)
  const f = fracs.find(([x]) => Math.abs(x - frac) < 0.02)
  if (f) return whole ? `${whole} ${f[1]}` : f[1]
  return String(Math.round(v * 100) / 100)
}

export const tests = [
  { tool: 'health_bmi', args: { weight_kg: 70, height_cm: 175 }, check: (r) => r.includes('22.9') && r.includes('משקל תקין') },
  { tool: 'health_bmi', args: { weight_kg: 10, height_cm: 175 }, throws: true, check: () => false },
  { tool: 'health_tdee', args: { sex: 'male', age: 30, weight_kg: 80, height_cm: 180, activity: 'moderate' }, check: (r) => r.includes('1780') && r.includes('2759') },
  { tool: 'health_tdee', args: { sex: 'female', age: 30, weight_kg: 60, height_cm: 165 }, check: (r) => r.includes('1320') },
  { tool: 'health_calorie_target', args: { sex: 'male', age: 30, weight_kg: 80, height_cm: 180, activity: 'sedentary', goal: 'lose' }, check: (r) => r.includes('1636') },
  { tool: 'health_macros', args: { calories: 2000 }, check: (r) => r.includes('חלבון 150') && r.includes('פחמימות 200') && r.includes('שומן 67') },
  { tool: 'health_water', args: { weight_kg: 70, exercise_minutes: 30 }, check: (r) => r.includes('2660') },
  { tool: 'health_sleep_times', args: { mode: 'wake_at', time: '07:00' }, check: (r) => r.includes('21:45') && r.includes('23:15') },
  { tool: 'health_sleep_times', args: { mode: 'sleep_at', time: '23:00' }, check: (r) => r.includes('05:15') && r.includes('06:45') && r.includes('08:15') },
  { tool: 'food_caffeine', args: { drink: 'filter_coffee', count: 2, hours_since: 5 }, check: (r) => r.includes('190') && r.includes('95') },
  { tool: 'health_heart_zones', args: { age: 30, resting_hr: 60 }, check: (r) => r.includes('190') && r.includes('138-151') },
  { tool: 'health_heart_zones', args: { age: 40 }, check: (r) => r.includes('180') && r.includes('108-126') },
  { tool: 'health_one_rep_max', args: { weight: 100, reps: 5 }, check: (r) => r.includes('116.7') && r.includes('112.5') },
  { tool: 'health_pace', args: { distance_km: 10, time: '50:00' }, check: (r) => r.includes('5:00') && r.includes('12 קמ"ש') && r.includes('5K: 23:5') },
  { tool: 'health_calories_burned', args: { activity: 'running_10', weight_kg: 70, minutes: 30 }, check: (r) => r.includes('343') },
  { tool: 'health_body_fat', args: { sex: 'male', height_cm: 178, waist_cm: 85, neck_cm: 38 }, check: (r) => /1(6\.[3-9]|7\.0)/.test(r) },
  { tool: 'health_protein', args: { weight_kg: 70, goal: 'build_muscle' }, check: (r) => r.includes('112-154') },
  { tool: 'food_scale_recipe', args: { ingredients: '2 כוסות קמח\n1/2 כפית מלח\n3 ביצים\nקורט פלפל', from_servings: 4, to_servings: 6 }, check: (r) => r.includes('3 כוסות קמח') && r.includes('3/4 כפית מלח') && r.includes('4 1/2 ביצים') && r.includes('קורט פלפל') },
  { tool: 'food_cooking_guide', args: { food: 'steak_medium_rare' }, check: (r) => r.includes('57°C') },
  { tool: 'food_nutrition_lookup', args: { query: 'nutella' }, check: (r) => r.includes('קלוריות') },
  { tool: 'health_first_aid', args: { topic: 'כוויה' }, check: (r) => r.includes('101') && r.includes('20 דקות') && r.includes('לא ייעוץ רפואי') },
  { tool: 'health_first_aid', args: {}, check: (r) => r.includes('חנק') },
]
