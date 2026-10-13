# הקיוסק של 42

מערכת תוכן למסך במשרד 42: נגן שרץ על המסך (סטרימר אנדרואיד עם Fully Kiosk), ודף ניהול מהנייד. סטאק `sheets-platform`: HTML/JS בלי build, Google Sheets כמסד נתונים, Apps Script כשרת.

הקובץ הזה בריפו ציבורי. לא לכתוב כאן קוד גישה, מיילים או כתובות webhook.

## כתובות
- ניהול: https://orisamuel.github.io/kiosk-42/
- נגן (ה-Start URL ב-Fully): https://orisamuel.github.io/kiosk-42/player.html
- ריפו (ציבורי, בגלל Pages): https://github.com/orisamuel/kiosk-42
- גיליון: https://docs.google.com/spreadsheets/d/1sBuKpJyIpA_yZzQB0zIo9zQaM1Yb-ZZpE638tQRk3d4/edit
- Apps Script: פרויקט "הקיוסק של 42 - Backend", Web App (Execute as Me, Anyone). ה-deployment של הייצור: `AKfycbyvbwOZEVuVCjwOGMkzfcm9mpEnYMSYGL2AQoV7xTHlEVrhi_wMy_F_n4mBjhlxZIrp` (הכתובת שב-`config.js`).

## קבצים
- `player.html`: הנגן. `player.html?preview=1` הוא מצב תצוגה מקדימה שדף הניהול טוען ב-iframe (בלי polling, בלי heartbeat).
- `index.html`: דף הניהול.
- `appscript.gs` + `appsscript.json`: השרת. רק הם נדחפים ל-Apps Script (`.claspignore`).
- `utils.js`, `config.js`, `styles.css`: משותפים. כשמשנים אותם מעלים את `?v=` בתגיות ב-`index.html` וב-`player.html`. אחרת reload של המסך מביא דף חדש עם סקריפט ישן מהמטמון.
- `assets/`: אמנות הסטודיו (לוחות 9:16). המקורות ב-`source-art/`, מחוץ לגיט.
- `.env` (מחוץ לגיט): `KIOSK_KEY`, קוד הגישה.

## פריסה
- פרונט: commit ו-`git push` ל-main. GitHub Pages מתעדכן תוך כדקה. `_config.yml` מחריג קבצים פנימיים מהאתר.
- שרת, מהטרמינל (`@google/clasp` 3.3.0 גלובלי, מחובר):
  ```
  clasp push --force
  clasp create-deployment -d "תיאור"            # גרסה חדשה + deployment חדש (לבדיקה)
  clasp update-deployment <prod-id> -V <גרסה> -d "תיאור"   # העברת הייצור לגרסה
  ```
  `clasp list-deployments` מראה איזו גרסה רצה. אחרי פריסה יש כמה דקות של 404 לסירוגין.
- הנגן על המסך מתעדכן לגרסה חדשה רק ב-reload: כפתור "רענון המסך" בדף הניהול, או הריענון הלילי ב-04:00.
- סדר בטוח כשהשרת והנגן משתנים יחד: קודם פרונט, רענון המסך ווידוא שה-boot השתנה (getStatus), ורק אז השרת.

## גישה (מ-13/10/2026)
- כל פעולה חוץ מ-`ping` דורשת `key`. בקוד יש רק `KEY_HASH` (SHA-256 של הקוד), והקוד עצמו ב-`.env`.
- כל מכשיר שומר את הקוד ב-localStorage `kioskKey`. הנגן ודף הניהול באותו origin, אז מכשיר שיש לו גישה לאחד מחובר גם לשני.
- נייד: קישור `index.html#key=...` (הקוד ב-fragment ולא מגיע לשרת). בדף הניהול: "שיתוף גישה לנייד נוסף".
- מסך: נגן בלי קוד מבקש `getPlaylist` עם `boot`. השרת שומר אותו כ-`kioskPending` ב-CacheService, ודף הניהול מציג "מסך מבקש חיבור". אישור (`approveScreen`) שם את הקוד ב-cache לאותו boot, והבקשה הבאה של המסך מקבלת `screenKey`. עד אז המסך מנגן את הפלייליסט השמור אצלו.
- להחלפת קוד: קוד חדש ב-`.env`, ה-hash ב-`KEY_HASH`, פריסה, קישור חדש לנייד, וחיבור המסך מחדש.

## החלטות ולמה
- **המסך אנכי (1080×1920).** לכן `videoFit` (cover/contain) גלובלי וגם לכל פריט. במצב cover הנגן נותן ל-iframe של יוטיוב גודל פיקסלים אמיתי עד 2560 (`MAX_NATIVE_PX`), כי יוטיוב בוחר איכות לפי גודל הנגן. הגדלה ב-CSS transform בלבד נתנה תמונה מטושטשת (תוקן 16/08/2026).
- **דרייב לא מתאים לוידאו.** נבדק 13/08/2026 מול קובץ ציבורי אמיתי: גוגל לא מזרימה וידאו מדרייב לדף בדומיין אחר (שלוש כתובות ההזרמה מחזירות MEDIA_ERR_SRC_NOT_SUPPORTED). המלצה: יוטיוב Unlisted, או קובץ מקומי על המסך.
- **קבצים מקומיים:** IndexedDB `kioskFiles`/`files` (keyPath `name`) בדפדפן של המסך. הנגן מדווח את השמות ב-heartbeat. דף הניהול שנפתח על המסך עצמו כותב לאותו מאגר.
- **לופ:** הנגן עצמו מלופף (loop טבעי) ולא קופץ להתחלה ב-ended. ביוטיוב יש קפיצה של כחצי שנייה בכל סבב בכל מקרה (מגבלה של יוטיוב), ולכן לופ אמיתי = קובץ מקומי.
- **בלי מסך התחברות** (בקשה של אורי, גישה מהירה מהנייד). קוד הגישה נשמר פעם אחת לכל מכשיר ולא מבקשים אותו שוב.
- **עיצוב:** אמנות סטודיו בפורמט 9:16. מיקום הבלון נמדד מהפיקסלים: לוח הודעה left 13.7% / right 10.7% / top 29.9% / height 60.2%; לוחות שקופית והמתנה top 9.6% / height 77.2%; לוח ERROR: הטקסט בפס העליון (left/right 6%, top 3.5%, height 20.5%). צבעים: כתום = המתנה, ורוד = הודעה, סגול = שקופית, רובוט ERROR = כשל. טקסט: `#2E0B33` גוף, `#E5187F` ורוד, `#7B4BA6` סגול, `#F0A03C` כתום.
- **פונט:** Assistant מ-Google Fonts. Simpler מותקן אצל אורי אבל הוא מסחרי, ולכן לא עולה לריפו הציבורי.

## לקחים טכניים
- `requestAnimationFrame` לא רץ כשהדף ברקע. התאמת גודל טקסט נעשית סינכרונית, ועוד פעם ב-`document.fonts.ready`. בגרירה המיקום מתעדכן ב-pointermove, ו-rAF רק לגלילה בקצוות.
- תשובה לא-JSON מהשרת (דף שגיאה של גוגל בזמן פריסה) לא נחשבת פלייליסט ריק, אחרת מסך תקין מתרוקן.
- טעינת ה-API של יוטיוב שנכשלת מתאפסת (`loadYtApi`). promise שנשאר תלוי השבית בעבר את כל פריטי היוטיוב עד הריענון הלילי.
- באוטומציית כרום: קליקים לפי קואורדינטות מפספסים בגלל scaling. עדיף find/ref, form_input וקריאות JS.
