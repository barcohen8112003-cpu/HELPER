// The model's handle on the homework list (src/schoolwork.js). Reading it never needs approval. "done" only marks
// the item in Helper's own list, on his word; nothing is changed in Classroom, Webtop or a group.
import * as schoolwork from './schoolwork.js'
import { obj } from './tool-helpers.js'

const nums = (list) => [].concat(list || []).map(Number).filter(Number.isInteger)
const OFF = 'מעקב שיעורי הבית עוד לא הופעל (SCHOOLWORK=on, אחרי שהוא מאשר). עד אז אפשר classroom_assignments ל-Classroom בלבד.'

export const schoolworkTools = [
  {
    name: 'school_homework',
    description:
      'שיעורי בית ומטלות פתוחות מכל מקורות בית הספר יחד: Classroom, Webtop וקבוצות הוואטסאפ של בית הספר שהוא בחר. ' +
      'list = מה פתוח עכשיו, עם מועד, מקור, כמה בטוח, ומה לא נבדק ("מה יש לי להגיש?", "יש שיעורי בית?"). ' +
      'status = אילו מקורות מחוברים, מתי נבדקו, ומה חסר. done = הוא אמר שסיים מטלה (לפי מספר מהרשימה): מסומן רק אצל Helper. ' +
      'undo = להחזיר מטלה שסומנה בטעות. forget = למחוק את כל מה שנשמר (רק כשהוא מבקש). ' +
      'אסור להגיד "אין שיעורי בית" כשמקור לא נבדק: להגיד מה לא נבדק.',
    parameters: obj(
      {
        action: { type: 'string', enum: ['list', 'status', 'done', 'undo', 'forget'] },
        items: { type: 'array', items: { type: 'number' }, description: 'done/undo: מספרי המטלות מהרשימה' },
      },
      ['action']
    ),
    async run({ action, items }) {
      if (action === 'status') return schoolwork.statusText()
      if (!schoolwork.enabled()) return OFF
      if (action === 'list') return schoolwork.summaryText()
      if (action === 'done') return schoolwork.markDone(nums(items))
      if (action === 'undo') return schoolwork.reopen(nums(items))
      if (action === 'forget') return schoolwork.forget()
      return 'פעולה לא מוכרת'
    },
  },
]
