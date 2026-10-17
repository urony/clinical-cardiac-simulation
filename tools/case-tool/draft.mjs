// Drafts a new case from a free-text brief by asking an AI model to fill the case template.
// The model never publishes anything: its output is only a DRAFT for the author to review in Excel.
// `complete` is injected (the command-line tool passes the app's provider layer; tests pass a fake).
import { IMPORTANCE, PLACEHOLDER, table, metaOf } from "./case-validation.mjs";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const DEFAULT_CHUNK = { "אנמנזה": 30, "בדיקה_גופנית": 25, "תוצאות_מספריות": 20, "בדיקות_מיידיות": 17, "בדיקות_המשך": 9, "החלטות_וטיפול": 10, "כללי_משוב": 16, "מטא_מקרה": 20 };

/** What to fill in each sheet: id column, label column, and the columns the model writes. */
export const SHEETS = [
  { sheet: "מטא_מקרה", idColumn: "שדה", labelColumn: "ערך", columns: ["ערך"], guide: "שדות המטא של המקרה. 'נוסח פתיחה לתלמיד' הוא המידע היחיד שהתלמיד רואה לפני הפגישה: שם בראשי תיבות, גיל, מין והתלונה בלבד, בלי מדדים חיוניים ובלי אבחנה. 'אמת קלינית' היא ההסבר הקליני המלא (מוסתר מהתלמיד). 'פרסונה קצרה': סגנון דיבור ומידת הפירוט של המטופל." },
  { sheet: "אנמנזה", idColumn: "מזהה רכיב בסיס", labelColumn: "כוונת הבירור", columns: ["תשובת המטופל", "חשיבות במקרה", "היגיון למשוב"], guide: "תשובת המטופל בגוף ראשון, בקול הפרסונה, במשפט או שניים, ורק על מה שנשאל. 'היגיון למשוב': משפט אחד מדוע הפריט חשוב או לא חשוב במקרה הזה." },
  { sheet: "בדיקה_גופנית", idColumn: "מזהה רכיב בסיס", labelColumn: "רכיב בדיקה", columns: ["ממצא במקרה", "חשיבות במקרה", "היגיון למשוב"], guide: "ממצא קבוע ותמציתי כפי שיירשם על ידי רופא. 'היגיון למשוב': משמעות הממצא במקרה." },
  { sheet: "תוצאות_מספריות", idColumn: "מזהה מדד", labelColumn: "שם המדד", columns: ["ערך", "טווח ייחוס", "פרשנות במקרה"], guide: "ערכים מספריים סבירים פיזיולוגית ועקביים עם התיאור. היחידה כבר נקבעה בתבנית ואין לשנותה. 'ערך': מספר בלבד (או ערך תקני אחר אם המדד איכותני). 'טווח ייחוס': טווח תקין למבוגרים, או 'לא חל'. 'פרשנות במקרה': משפט קצר." },
  { sheet: "בדיקות_מיידיות", idColumn: "מזהה רכיב בסיס", labelColumn: "בדיקה או רכיב", columns: ["פרשנות במקרה", "חשיבות במקרה", "היגיון למשוב"], extra: { column: "תוצאה להצגה", auto: "נוצר אוטומטית מתוצאות_מספריות." }, guide: "'תוצאה להצגה' (כשנדרשת): התוצאה המילולית כפי שתוצג לתלמיד. 'פרשנות במקרה': התוצאה המילולית והמשמעות שלה במקרה, בהתאם לערכים המספריים שכבר נקבעו. 'היגיון למשוב': מדוע הבדיקה מתאימה או לא מתאימה כאן." },
  { sheet: "בדיקות_המשך", idColumn: "מזהה רכיב בסיס", labelColumn: "בדיקה", columns: ["תוצאה קבועה", "השפעה על החשיבה", "חשיבות במקרה", "היגיון למשוב"], guide: "גם בדיקה שאינה מוצדקת במקרה מקבלת תוצאה קבועה. 'השפעה על החשיבה': כיצד התוצאה משנה את האבחנה או התכנית. 'היגיון למשוב': גם לגבי מידתיות הבדיקה." },
  { sheet: "החלטות_וטיפול", idColumn: "מזהה", labelColumn: "שלב", columns: ["פעולה או אפשרות", "מעמד במקרה", "היגיון צפוי"], guide: "אבחנות מבדלות, החלטות בטיחות וטיפול. 'מעמד במקרה': למשל 'אבחנה מובילה', 'חלופה סבירה', 'חיוני במקרה', 'פחות סביר'." },
  { sheet: "כללי_משוב", idColumn: "מזהה", labelColumn: "סוג כלל", columns: ["הנחיה למערכת"], guide: "כל כלל הוא הנחיה קצרה וממוקדת למשוב על התלמיד במקרה הזה: מה לצפות, מה נחשב טוב, ומה כדאי לשקול. בלי ציונים." },
];

export const SYSTEM = [
  "אתה עוזר לכותב תיק מטופל מדומה בעברית לסימולטור לימודי לתלמידי מדעי הבריאות בתיכון. מה שאתה כותב הוא טיוטה בלבד: מומחה רפואי יעבור על כל פרט לפני שימוש.",
  "כללים מחייבים:",
  "1. בסס הכול על תיאור המקרה. אל תמציא אבחנות, מחלות, תרופות, ניתוחים או ממצאים חריגים שאינם נובעים מהתיאור או מהאבחנה.",
  "2. לפרט שלא נאמר ואינו משפיע על התמונה הקלינית: בחר ערך תקין או שלילי העקבי עם התיאור, ובאנמנזה אפשר להשתמש ב'לא ידוע לי' או 'לא'. כל פריט שאתה ממציא או בטוח בו פחות סמן needsReview=true ורשום ב-note במה מדובר.",
  "3. שמור על עקביות מלאה: אל תסתור עובדות שכבר נקבעו (מופיעות בהקשר).",
  "4. לעולם אל תחשוף את האבחנה בשדות שהתלמיד רואה לפני הפגישה, ובתשובות המטופל השתמש בלשון של אדם רגיל ולא במונחים מקצועיים שהמטופל לא היה יודע.",
  "5. כל ערך מספרי חייב להיות סביר פיזיולוגית, והיחידות כפי שנקבעו בתבנית. אל תשתמש בנתונים של מטופל אמיתי.",
  "6. 'חשיבות במקרה' חייבת להיות אחד מהערכים: " + IMPORTANCE.join(" / ") + ".",
  "7. אל תכתוב הוראות תבנית בסוגריים מרובעים. החזר JSON תקין בלבד בסכמה שנתבקשה, ולכל מזהה ברשימה החזר פריט אחד בדיוק.",
].join("\n");

export const chunkSize = (sheet) => DEFAULT_CHUNK[sheet] ?? 20;

function chunk(list, size) { const out = []; for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size)); return out; }

function schemaFor(columns) {
  const fieldProps = Object.fromEntries(columns.map((column) => [column, column === "חשיבות במקרה" ? { type: "string", enum: IMPORTANCE } : { type: "string" }]));
  return {
    type: "object", additionalProperties: false, required: ["items"],
    properties: { items: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "fields", "needsReview", "note"], properties: { id: { type: "string" }, fields: { type: "object", additionalProperties: false, required: columns, properties: fieldProps }, needsReview: { type: "boolean" }, note: { type: "string" } } } } },
  };
}

/** Rows of the template that still need content, with their labels. */
export function pendingItems(template, spec) {
  if (spec.sheet === "מטא_מקרה") {
    const meta = metaOf(template);
    return Object.entries(meta)
      .filter(([field, value]) => PLACEHOLDER.test(value) && field !== "מזהה מקרה" && field !== "שיוך למסד המחלות")
      .map(([field, value]) => ({ id: field, label: field, hint: value }));
  }
  const rows = table(template, spec.sheet) ?? [];
  return rows
    .filter((row) => spec.columns.some((column) => PLACEHOLDER.test(text(row[column])) || text(row[column]) === ""))
    .map((row) => {
      const extra = spec.extra ? text(row[spec.extra.column]) : "";
      return { id: text(row[spec.idColumn]), label: text(row[spec.labelColumn]), hint: spec.columns.map((c) => text(row[c])).filter((v) => PLACEHOLDER.test(v)).join(" "), auto: Boolean(spec.extra) && /\[נוצר אוטומטית/.test(extra), needsExtra: Boolean(spec.extra) && /\[למילוי/.test(extra) };
    });
}

/** Items grouped by the columns the model must write (a few rows need one extra column). */
export function groupsOf(template, spec) {
  const items = pendingItems(template, spec);
  const withExtra = items.filter((item) => item.needsExtra);
  const groups = [{ columns: spec.columns, items: items.filter((item) => !item.needsExtra) }];
  if (withExtra.length) groups.push({ columns: [...spec.columns, spec.extra.column], items: withExtra });
  return groups.filter((group) => group.items.length);
}

function validEntry(entry, spec, allowedIds) {
  if (!entry || !allowedIds.has(entry.id)) return "מזהה לא ידוע";
  for (const column of spec.columns) {
    const value = entry.fields?.[column];
    if (typeof value !== "string" || !value.trim()) return `"${column}" ריק`;
    if (PLACEHOLDER.test(value)) return `"${column}" כולל הוראת תבנית`;
  }
  if (spec.columns.includes("חשיבות במקרה") && !IMPORTANCE.includes(entry.fields["חשיבות במקרה"])) return "חשיבות לא תקינה";
  return null;
}

function parseItems(raw) {
  try { const parsed = JSON.parse(raw); return Array.isArray(parsed?.items) ? parsed.items : []; } catch { return []; }
}

/** Short "label: value" lines of what has been decided so far, to keep later answers consistent. */
function factsSoFar(fills) {
  const lines = [];
  for (const [sheet, entries] of Object.entries(fills.sheets)) {
    for (const [id, entry] of Object.entries(entries)) {
      const value = Object.values(entry.fields)[0];
      lines.push(`${sheet} ${id}: ${String(value).slice(0, 140)}`);
    }
  }
  return lines.join("\n");
}

/** How many model calls a draft needs (before retries), so the author sees the cost first. */
export function planDraft(template) {
  const steps = SHEETS.map((spec) => {
    const groups = groupsOf(template, spec);
    return { sheet: spec.sheet, items: groups.reduce((sum, group) => sum + group.items.length, 0), calls: groups.reduce((sum, group) => sum + Math.ceil(group.items.length / (DEFAULT_CHUNK[spec.sheet] ?? 20)), 0) };
  });
  return { steps, calls: steps.reduce((sum, step) => sum + step.calls, 0) };
}

/**
 * @param {{brief: string, template: object, caseId: string, complete: Function, onProgress?: Function, now?: () => Date}} options
 * `complete({role, system, user, maxOutputTokens, json})` must return the model's text.
 */
export async function draftCase({ brief, template, caseId, complete, onProgress = () => {}, now = () => new Date() }) {
  if (!text(brief)) throw new Error("התיאור ריק.");
  const fills = { caseId, generatedAt: now().toISOString(), sheets: {}, problems: [] };
  for (const spec of SHEETS) {
    const groups = groupsOf(template, spec);
    if (!groups.length) continue;
    const entries = (fills.sheets[spec.sheet] = {});
    for (const group of groups) {
      const specForGroup = { ...spec, columns: group.columns };
      for (const part of chunk(group.items, DEFAULT_CHUNK[spec.sheet] ?? 20)) {
        let todo = part;
        const lastProblem = new Map();
        for (let attempt = 1; attempt <= 2 && todo.length; attempt += 1) {
          const allowed = new Set(todo.map((item) => item.id));
          onProgress({ sheet: spec.sheet, items: todo.length, attempt });
          const known = factsSoFar(fills);
          const user = [
            `תיאור המקרה מאת המחבר:\n${brief}`,
            `מזהה המקרה: ${caseId}`,
            known ? `עובדות שכבר נקבעו (אסור לסתור אותן):\n${known}` : "",
            `גיליון: ${spec.sheet}\n${spec.guide}\nהעמודות למילוי: ${group.columns.join(", ")}`,
            `הפריטים (החזר פריט אחד לכל מזהה):\n${JSON.stringify(todo.map((item) => ({ id: item.id, topic: item.label, template_hint: item.hint || undefined })))}`,
          ].filter(Boolean).join("\n\n");
          const raw = await complete({ role: "response", system: SYSTEM, user, maxOutputTokens: Math.min(8000, 400 + 260 * todo.length * group.columns.length), json: { name: "case_draft", schema: schemaFor(group.columns) } });
          for (const entry of parseItems(raw)) {
            const problem = validEntry(entry, specForGroup, allowed);
            if (problem) { if (allowed.has(entry?.id)) lastProblem.set(entry.id, problem); continue; }
            entries[entry.id] = { fields: Object.fromEntries(group.columns.map((column) => [column, entry.fields[column].trim()])), needsReview: Boolean(entry.needsReview), note: text(entry.note) };
          }
          todo = todo.filter((item) => !entries[item.id]);
        }
        // Only what is still missing after the retry is a problem for the author.
        for (const item of todo) fills.problems.push(`${spec.sheet} ${item.id}: ${lastProblem.get(item.id) ?? "לא התקבלה תשובה תקינה מהמודל"}`);
      }
    }
    // Rows whose displayed result is generated from the numeric results sheet get that fixed wording.
    if (spec.extra) for (const item of pendingItems(template, spec)) if (item.auto && entries[item.id]) entries[item.id].fields[spec.extra.column] = spec.extra.auto;
  }
  // Not an AI decision: a new case has no entry in the general disease database.
  fills.sheets["מטא_מקרה"] ??= {};
  fills.sheets["מטא_מקרה"]["שיוך למסד המחלות"] = { fields: { "ערך": "אין שיוך במסד הכללי (מקרה חדש)" }, needsReview: false, note: "" };
  return fills;
}

/** A draft with no AI content: only the values that are never written by a model. */
export function emptyFills(template, caseId, now = () => new Date()) {
  const fills = { caseId, generatedAt: now().toISOString(), sheets: {}, problems: [], emptyStart: true };
  for (const spec of SHEETS) {
    if (!spec.extra) continue;
    for (const item of pendingItems(template, spec)) {
      if (!item.auto) continue;
      (fills.sheets[spec.sheet] ??= {})[item.id] = { fields: { [spec.extra.column]: spec.extra.auto }, needsReview: false, note: "" };
    }
  }
  fills.sheets["מטא_מקרה"] = { "שיוך למסד המחלות": { fields: { "ערך": "אין שיוך במסד הכללי (מקרה חדש)" }, needsReview: false, note: "" } };
  return fills;
}
