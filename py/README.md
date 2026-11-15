# Scrapling ל-fetch_page

כשהדגל דלוק, הכלי `fetch_page` קורא דפים ציבוריים ב-https דרך [Scrapling](https://github.com/D4Vinci/Scrapling) (ספריית Python) ומחזיר כתובת מקור, כותרת וטקסט. הדגל כבוי כברירת מחדל, ואז שום דבר לא משתנה.

זה לא "קורא כל אתר". הוא קורא HTML ציבורי ב-HTTP רגיל, בלי דפדפן. דף שנבנה רק ב-JavaScript ייצא עם מעט טקסט, וכך גם ייאמר בתשובה.

## מה הוא עושה ומה לא

| עושה | לא עושה |
|---|---|
| GET אחד לדף, עד 5 הפניות, כל אחת נבדקת מחדש | התחברות, cookies, טפסים, POST |
| https ופורט 443 בלבד | http, file, ftp, data, פורטים אחרים |
| בודק כל כתובת ש-DNS מחזיר (IPv4 ו-IPv6) ומצמיד את החיבור אליה | גישה ל-localhost, רשתות פרטיות, link-local, metadata של ענן |
| מכבד robots.txt | עקיפת CAPTCHA, חסימה או robots.txt |
| מחזיר 401/403/התחברות/CAPTCHA כשגיאה עם סיבה | סריקה של אתר שלם, ניטור חוזר ברקע |
| עוצר את ההורדה ב-2MB, טקסט עד 30,000 תווים, 30 שניות, 2 במקביל | התקנת דפדפנים (`scrapling install` לא רץ) |

מה שכתוב בדף מגיע למודל כתוכן, עם שורה שאומרת שזה לא הוראות. האישורים הרגילים של Helper (שליחה, מייל, זיכרון) נשארים כמו שהם.

כש-Scrapling לא מותקן בכלל, `fetch_page` חוזר לקורא הרגיל ואומר את זה. בכל כשל אחר (כתובת אסורה, חסימה, התחברות, robots.txt, תשובה שבורה) אין נפילה לקורא הרגיל, כי הוא לא בודק כתובות.

## התקנה במחשב (פיתוח)

צריך Python 3.10 ומעלה. נבדק על 3.13 ועל 3.11.

Linux / macOS:

```bash
python3 --version
python3 -m venv .venv-scrapling
.venv-scrapling/bin/python -m pip install -r py/requirements-scrapling.txt
.venv-scrapling/bin/python -I -c 'from scrapling.fetchers import Fetcher; print("fetcher import OK")'
npm run check:scrapling-py
```

Windows:

```bat
py -3 --version
py -3 -m venv .venv-scrapling
.venv-scrapling\Scripts\python.exe -m pip install -r py\requirements-scrapling.txt
.venv-scrapling\Scripts\python.exe -I -c "from scrapling.fetchers import Fetcher; print('fetcher import OK')"
npm run check:scrapling-py
```

אחר כך ב-`.env`:

```
SCRAPLING_ENABLED=true
```

ו-restart ל-Helper. `SCRAPLING_PYTHON` צריך רק אם ה-venv במקום אחר.

ה-venv תופס כ-360MB (רובו playwright ו-patchright, שמגיעים עם `scrapling[fetchers]` גם בלי דפדפנים). הוא ב-`.gitignore`.

## בשרת (Docker)

ה-Dockerfile לא מתקין את זה כברירת מחדל, כך שבנייה רגילה וה-auto-update בשרת לא משתנים. כדי להתקין:

```bash
INSTALL_SCRAPLING=true docker compose up -d --build
```

ואז `SCRAPLING_ENABLED=true` ב-`.env` של השרת ו-restart. בתוך התמונה המפרש הוא `/opt/scrapling-venv/bin/python` (כבר מוגדר). בנייה כזו לא נבדקה עדיין: אין Docker בסביבה שבה זה נכתב.

## כיבוי וחזרה למצב הקודם

1. `SCRAPLING_ENABLED=false` (או למחוק את השורה) ו-restart. `fetch_page` חוזר לקורא הרגיל מיד.
2. להסיר את ההתקנה: למחוק את `.venv-scrapling/`. בדוקר: לבנות שוב בלי `INSTALL_SCRAPLING`.
3. להסיר את הקוד: revert לקומיט של השינוי. אין נתונים או מיגרציה לנקות.

## בדיקות

- `npm run check:scrapling`: הצד של Node, בלי רשת. רץ גם ב-`check:all`.
- `npm run check:scrapling-py`: ה-worker עצמו, עם DNS ו-HTTP מדומים ושרת fixture מקומי (`fixture.test` מוצמד ל-127.0.0.1).

## הגדרות

| משתנה | ברירת מחדל |
|---|---|
| `SCRAPLING_ENABLED` | כבוי |
| `SCRAPLING_PYTHON` | `.venv-scrapling/bin/python` (Windows: `.venv-scrapling\Scripts\python.exe`) |
| `SCRAPLING_TIMEOUT_MS` | 30000 (5,000 עד 60,000) |
| `SCRAPLING_MAX_BYTES` | 2097152 |
| `SCRAPLING_MAX_CHARS` | 30000 |
| `SCRAPLING_CONCURRENCY` | 2 (עד 4) |
| `SCRAPLING_EGRESS_PROXY` | ריק. רק לפרוקסי יציאה מבוקר: אז שם בלי תשובת DNS מקומית נשלח לפרוקסי לפתרון, וההצמדה לכתובת לא חלה |
