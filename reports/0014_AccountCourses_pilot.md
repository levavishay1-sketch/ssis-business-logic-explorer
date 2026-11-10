# פיילוט: 0014_AccountCourses

| | |
|---|---|
| קובץ | `DailyProcess/0014_AccountCourses.dtsx` |
| SHA256 | `BBB424F202337F9F76966509CACF3D52AA9306C800A09ECC3EA635E44F08DEF1` |
| גודל | 397,075 bytes · 6,385 שורות · 659 אלמנטי XML |
| גבול הבדיקה | חבילה זו בלבד. לא סופקו: `CRM2015.Proxy.dll`, קובץ הקונפיגורציה `C:\Generix\SSISConfigFile.dtsConfig`, Metadata של CRM והגדרות ה-Views/טבלאות |
| מצב | אימות טכני בוצע · **ממתין לאישורך** (שום דבר לא סומן "אושר") |

## 1. שערי דיוק שעברו

| בדיקה | תוצאה |
|---|---|
| Parser עצמאי מול Parser של ‎.NET | 659 = 659 אלמנטים |
| SHA256 מול Windows | זהה |
| התאמת ספירות: Executables / Precedence / EventHandlers / CM / Variables | 6/6 · 3/3 · 1/1 · 2/2 · 5/5 |
| Components / Paths / Input cols / Output cols / External cols | 10/10 · 8/8 · 36/36 · 57/57 · 14/14 |
| קובצי קוד (Script Task / Script Component) | 16/16 · 5/5 · 156/156 arrayElements |
| עמודות קלט ללא מקור Lineage | 0 |
| Log Providers / LoggingOptions | 1/1 · 6/6 |
| סוגי אלמנטי DTS שה-Extractor לא מטפל בהם | 0 |

> במהלך הפיילוט נמצאו שני פערים ב-Extractor, ושניהם תוקנו:
> (1) קוד ה-Script Component נקרא כזוגות במקום כשלשות. נוספה בדיקה שמשווה את מספר האלמנטים המוצהר למספר שנקרא.
> (2) **רישום הלוג של SSIS לא חולץ כלל.** את זה תפס הבודק העצמאי. כדי שזה לא יקרה שוב, נוספה רשת ביטחון: כל סוג אלמנט `DTS:*` שה-Extractor לא מכיר מכשיל את בדיקת השלמות.

## 2. מה החבילה עושה (עסקי)

החבילה מעדכנת ב-**מסלולי חשבון** (`gen_accountcourses`) את **יתרת החשבון** לפי רשומת `Gen_fundmain` המקושרת, כשההפרש הוא 0.01 לפחות.
היא אמורה לעדכן גם את **ארבעת דגלי ההגבלה** (`gen_isconfiscate`, `gen_iswarning`, `gen_ismortgaged`, `gen_isreceivership`). אבל לפי קוד המקור, דגל נכתב **רק כשהערך הקיים במסלול ריק** (F1).
העדכון חל רק על מסלולים שיש להם **תהליך פתוח** אחד לפחות: העברה נכנסת, שירות לקוחות או משיכה, כולם במצב 1. העדכון נשלח דרך CRM (ExecuteMultiple).
סביב העבודה העיקרית יש מסגרת רישום של תהליך ETL ב-CRM (פתיחה, אזהרות, סגירה וכשל), ובנוסף רישום לוג SSIS ל-SQL Server.

> שמות הישויות בעברית הם הצעה בלבד. אין עדיין Metadata של CRM.

## 3. סדר ריצה (מתוך Precedence Constraints, שורות 5505–5507)

| # | רכיב | טריגר |
|---|---|---|
| 1 | Get Organization Variables | התחלה |
| 2 | Create ETL Process record | אחרי 1 · Success |
| 3 | Update Account courses | אחרי 2 · Success |
| 4 | End ETL Process record | אחרי 3 · Success |
| ⚡ | Error ETL Process record | אירוע OnError ברמת החבילה |

אין ענפים מקבילים ואין רכיבים מושבתים.

## 4. פעולות כתיבה

| רכיב | פעולה | יעד | מנגנון | סיווג | שדות |
|---|---|---|---|---|---|
| 2 | CREATE | gen_etlprocess | CrmProxy.Create | Supported* | gen_name, gen_etlname, gen_etlversion, gen_runinserver |
| 3 | UPDATE | **gen_accountcourses** | ExecuteMultiple (אצוות של 10) | Supported* | gen_isconfiscate, gen_iswarning, gen_ismortgaged, gen_isreceivership, gen_accountbalance |
| 3 | CREATE | gen_etlprocesswarning | CrmProxy.Create | Supported* | gen_name, gen_etlubprocess, gen_recordkey=`""`, gen_warningdescription, gen_etlprocessid, gen_warningtype=`1` |
| 4 | UPDATE | gen_etlprocess | CrmProxy.Update | Supported* | statuscode = 277880000 (בלי אזהרות) או 277880002 (עם אזהרות), gen_runtime |
| ⚡ | UPDATE | gen_etlprocess | CrmProxy.Update | Supported* | statuscode=`277880001`, gen_runtime |
| ⚡ | CREATE | annotation | CrmProxy.Create | Supported* | objectid, objecttypecode=`gen_etlprocess`, subject=`Error Description`, notetext |

**כתיבה נוספת שאינה CRM:** לוג SSIS. ה-Provider `LogProviderSQLServer` מופעל ברמת החבילה ל-OnError, OnInformation, OnTaskFailed ו-OnWarning. ה-DB שאליו נכתב הלוג נקבע בזמן ריצה, מתוך `gen_etlvariable` (F8).

\* **Supported עם מגבלת היקף.** כל הכתיבות עוברות דרך `CRM2015.Proxy.dll`, שלא סופקה. הקוד משתמש ב-`CRM.Proxy.CrmSdk`, ב-`IOrganizationService` וב-`SoapException`, כלומר בשירות CRM ולא ב-SQL. אבל המימוש של ה-Proxy עצמו לא נבדק. בחבילה לא נמצא SQL DML.

**קריאות ישירות מ-DB של CRM** (‏SELECT בלבד, דרך ה-Connection `CRM`): `gen_etlvariable`, ‏`gen_accountcourses`, ‏`Gen_fundmain`, ‏`Gen_transferin`, ‏`Gen_customercare`, ‏`Gen_withdrawal`, ‏`gen_etlprocess`, ‏`gen_etlprocesswarning`.

## 5. מסלול כל שדה ברכיב העיקרי

| שדה ב-Pipeline | מקור SQL | הכרעה | יעד / שימוש |
|---|---|---|---|
| gen_accountcoursesId | ac.gen_accountcoursesId | מזהה רשומה | Entity.Id. לא נכתב כשדה |
| gen_accountbalance | Gen_fundmain.Gen_AccountBalance (ללא ISNULL) | כתיבת ערך ישיר | gen_accountbalance (Money). נכתב כשההפרש ≥ 0.01 או כשרק צד אחד ריק. **אם המקור ריק, היתרה נמחקת** (F10) |
| gen_isconfiscate / iswarning / ismortgaged / isreceivership | ISNULL(Gen_fundmain.…,0) | כתיבת ערך נגזר (ISNULL) | השדה התואם. **ראה F1** |
| gen_…DB (5 שדות) | הערך הנוכחי ב-gen_accountcourses | השוואה בלבד | לא נכתבים |
| gen_transactionpercent | ac.gen_transactionpercent | נשלף ולא בשימוש | — |

## 6. ממצאים לבדיקתך

- **F1 (חמור, הבודק העצמאי אימת):** בהשוואה של דגלי ה-bool, ‏`PropertyType.Name` מחזיר `"Boolean"`, אבל ב-`switch` יש רק `"bool"`. לכן הקוד חוזר ל-default, שמחזיר "שווה". **התוצאה: הדגלים מתעדכנים רק כשהערך ב-gen_accountcourses ריק.** שינוי מ-1 ל-0 או מ-0 ל-1 ב-Gen_fundmain לא יועבר. הממצא מבוסס על קוד המקור; ה-DLL המהודר לא נבדק. (`Helpers.cs:14-61,90`)
- **F2:** אזהרה על כשל עדכון לא מזהה את הרשומה, כי `RecordKey` מוגדר כ-`""` קבוע.
- **F3:** ‏`gen_transactionpercent` נשלף ולא נעשה בו שימוש.
- **F4:** הפלט `DontNeedToUpdate` לא מחובר, ולכן שורות שלא השתנו מסתיימות שם. Union All Input 3 הוא קלט placeholder רגיל, ואינו ממצא.
- **F9 (חמור):** כשל בשליחת אצווה באמצע הקלט נבלע. רק השורה הנוכחית מסומנת כשגיאה, עם הודעה שלא קשורה אליה. רשימת האצווה לא מתרוקנת, ולכן מאותו רגע הכול, כולל האצווה שנכשלה, נשלח בבקשה אחת גדולה בסוף. (`main.cs:151-171, 202, 211-214`)
- **F10:** היתרה במקור נשלפת בלי ISNULL. אם `Gen_AccountBalance` ריק, היתרה במסלול נמחקת (נכתב null).
- **F8:** רישום הלוג של SSIS ל-SQL Server הוא כתיבה נוספת. יעד הכתיבה נקבע בזמן ריצה.
- **F11 (אפשרות בלבד):** שגיאה לפני יצירת רשומת התהליך עלולה להכשיל גם את ה-OnError, כי `(Guid)` ממיר משתנה ריק. OnError גם עשוי לרוץ כמה פעמים באותה ריצה.
- **F5:** ‏`CRM2015.Proxy.dll` מופיעה עם שלושה HintPath שונים בפרויקטי הסקריפט.
- **F6:** קובץ הקונפיגורציה החיצוני עשוי לדרוס את מחרוזת החיבור. הערך בחבילה, `Psql / ALTSHULER_MSCRM`, הוא ערך זמן תכנון.
- **F7:** אם אותו `gen_key` קיים גם כ-global וגם ב-scope של החבילה, ‏`Dictionary.Add` נכשל והריצה נעצרת.

## 7. בדיקה עצמאית

סוכן נפרד בדק כל טענה מול קובץ ה-DTSX הגולמי, וניסה להפריך אותה. התיקונים שבוצעו בעקבותיו:

| סוג | פריט | תיקון |
|---|---|---|
| חסר | לוג SSIS ל-SQL Server | נוסף כ-F8. גם ה-Extractor עודכן |
| חסר | התנהגות כשל של אצווה באמצע הקלט | נוסף כ-F9. ה-decisionLogic הקודם תיאר את המקרה לא נכון |
| חסר | מחיקת יתרה כשהמקור ריק | נוסף כ-F10 |
| חסר (אפשרות) | כשל ב-OnError עצמו | נוסף כ-F11 |
| שגוי | נימוק ה-Lookup ברכיב 4 | תוקן: הראיה היא errorRowDisposition של Match Output (שורה 2244), ובפועל רצה השאילתה עם הפרמטר |
| שגוי | ציטוט שורה ב-F6 | תוקן לשורה 6 |
| טענת יתר | התקציר אמר שהדגלים מתעדכנים "כשיש הבדל" | תוקן כך שיתאים ל-F1 |
| טענת יתר | הרמה verified_end_to_end על 6 שדות | הורדה ל-verified_with_scope_limit, כי ה-DLL לא נבדק |
| טענת יתר | Union All Input 3 סומן כממצא | תוקן: זה placeholder רגיל |

הבודק אישר את: סדר הריצה, F1 (עם שורות ה-BufferWrapper), כל רשימות השדות והערכים הקבועים, F2, F3, F5, F7, וסיווג Supported עם מגבלת היקף. לא נמצא בחבילה SQL שכותב.

## 8. מה צריך ממך

1. לאשר או לתקן את ההבנה העסקית בסעיף 2.
2. להחליט אם F1 הוא באג ידוע. ייתכן שה-DLL בייצור שונה מהקוד המוטמע.
3. קבצים חסרים, אם אפשר: `CRM2015.Proxy.dll` (או הקוד שלו), ‏`SSISConfigFile.dtsConfig`, Metadata של CRM (שמות עבריים וסוגי שדות).
4. כלל לסיווג תחום (גמל / פנסיה / אחר) לחבילות ב-DailyProcess.
