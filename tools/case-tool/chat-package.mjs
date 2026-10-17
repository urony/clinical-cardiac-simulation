// Work with the author's OWN AI chat instead of a paid API call: the author downloads one document, gives it
// to a chat assistant (ChatGPT, Claude, Gemini ...), talks the case through with it, and pastes the answers back.
// This module builds that document and reads the pasted answers; nothing here calls any service.
import { IMPORTANCE, PLACEHOLDER } from "./case-validation.mjs";
import { SHEETS, SYSTEM, emptyFills, groupsOf, chunkSize, normalizeMetaValue } from "./draft.mjs";
import { EXTRA, unitOf } from "./workbook-json.mjs";
import { addExtra } from "./view.mjs";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

function chunk(list, size) { const out = []; for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size)); return out; }

/** The groups the chat assistant produces one message at a time, in order. */
export function chatGroups(template) {
  const groups = [];
  for (const spec of SHEETS) {
    for (const group of groupsOf(template, spec)) {
      for (const part of chunk(group.items, chunkSize(spec.sheet))) {
        groups.push({ spec, columns: group.columns, items: part.map((item) => ({ id: item.id, topic: item.label, template_hint: item.hint || undefined, unit: spec.sheet === "תוצאות_מספריות" ? unitOf(template, item.id) || undefined : undefined })) });
      }
    }
  }
  return groups;
}

const EXAMPLE = `\`\`\`json
{
  "items": [
    {
      "id": "AN-001",
      "fields": { "תשובת המטופל": "…", "חשיבות במקרה": "חשוב", "היגיון למשוב": "…" },
      "needsReview": false,
      "note": ""
    }
  ]
}
\`\`\``;

/** One Markdown document: instructions for the assistant, the case so far, and every group of items to produce. */
const EXTRAS_EXAMPLE = `\`\`\`json
{
  "extras": [
    {
      "sheet": "בדיקות_מיידיות", "label": "תרבית שתן",
      "fields": { "תוצאה להצגה": "…", "פרשנות במקרה": "…", "חשיבות במקרה": "חשוב", "היגיון למשוב": "…" },
      "needsReview": true, "note": ""
    },
    {
      "sheet": "תוצאות_מספריות", "test": "תרבית שתן", "label": "ספירת מושבות", "unit": "CFU/mL",
      "fields": { "ערך": "…", "טווח ייחוס": "…", "פרשנות במקרה": "…" },
      "needsReview": true, "note": ""
    }
  ]
}
\`\`\``;

export function buildChatPackage({ template, brief = "", caseId }) {
  const groups = chatGroups(template);
  const total = groups.length + 1;
  const lines = [];
  lines.push(`# מסמך עבודה ל-AI: יצירת המקרה ${caseId} בסימולטור`, "");
  lines.push("## למחבר: איך משתמשים בזה", "",
    "1. העלו את הקובץ הזה לצ'אט של ה-AI שלכם (או הדביקו את כולו), וכתבו: **״קרא את המסמך ובצע את ההוראות בו״.**",
    "2. ספרו ל-AI על המקרה במילים שלכם. הוא ישאל שאלות. כשהכול ברור, כתבו **״התחל״**, ואחר כך **״המשך״** אחרי כל קבוצה.",
    "3. בכל הודעה ה-AI ייתן בלוק JSON אחד. העתיקו אותו (אפשר להדביק את כל השיחה בבת אחת) לממשק הניהול, בשלב 2, ולחצו ״ייבא״.", "",
    "---", "", "## הוראה ל-AI", "",
    `אתה עוזר לי ליצור מקרה לימודי (${caseId}) לסימולטור קליני לתלמידי מדעי הבריאות בתיכון, בעברית. קרא את כל המסמך לפני שתענה.`, "",
    "**אל תפיק שום קבוצה לפני שאגיד ״התחל״.** קודם שאל אותי שאלות על המקרה עד שיש לך מספיק מידע: אבחנה, המטופל וסגנון הדיבור שלו, התמונה הקלינית, ממצאי בדיקה ותוצאות (כולל מספריות), החלטות וטיפול. שאל מעט שאלות בכל פעם.", "",
    "אחרי ״התחל״ הפק **קבוצה אחת בכל הודעה**, לפי הרשימה בסוף המסמך, בסדר שלה. בכל הודעה: בלוק קוד JSON **אחד** בפורמט שלמטה, בלי טקסט בתוך הבלוק, ואחריו שורה אחת: ״קבוצה X מתוך Y. כתבו ׳המשך׳ לקבוצה הבאה.״ שמור על עקביות מלאה עם כל מה שנקבע קודם בשיחה.", "",
    "### כללים מחייבים", "", ...SYSTEM.split("\n").filter((line) => /^\d\./.test(line)), "",
    "### פורמט", "",
    "לכל פריט ברשימת הקבוצה החזר פריט אחד, עם אותם `id`. בתוך `fields` רק העמודות שהקבוצה מבקשת (השמות בדיוק כפי שהם). `needsReview` הוא `true` לכל פריט שלא נאמר עליו כלום בשיחה והמצאת אותו, או שאינך בטוח בו, וב-`note` במה מדובר. `חשיבות במקרה` חייבת להיות אחד מהערכים: " + IMPORTANCE.join(" / ") + ".", "",
    EXAMPLE, "");
  if (text(brief)) lines.push("---", "", "## מה המחבר כבר כתב על המקרה", "", text(brief), "");
  lines.push("---", "", `## רשימת הקבוצות להפקה (${total} קבוצות)`, "");
  groups.forEach((group, index) => {
    lines.push(`### קבוצה ${index + 1} מתוך ${total}: ${group.spec.sheet.replace(/_/g, " ")} (${group.items.length} פריטים)`, "",
      group.spec.guide, "", `העמודות למילוי: ${group.columns.join(", ")}`, "",
      "רשימת הפריטים (זה קלט, לא הפלט; ה-`topic` הוא שם הפריט):", "", "```json", JSON.stringify(group.items, null, 1), "```", "");
  });
  lines.push(`### קבוצה ${total} מתוך ${total}: פריטים נוספים שהמקרה הזה דורש`, "",
    "הרשימות שלמעלה זהות לכל מקרה. אם המקרה הזה דורש שאלות, רכיבי בדיקה גופנית, בדיקות או בדיקות המשך **שאינם ברשימות** (למשל במקרה כליה: תרבית שתן, ביופסיית כליה), הצע אותם עכשיו. הצע רק מה שחשוב באמת לתמונה הקלינית (עד 12 פריטים), ואל תחזור על פריט שכבר קיים ברשימות. אם אין צורך, החזר `{ \"extras\": [] }`.", "",
    "לכל פריט: `sheet` (אחד מ: אנמנזה, בדיקה_גופנית, בדיקות_מיידיות, בדיקות_המשך, תוצאות_מספריות), `label` (שם הפריט), ובתוך `fields` את העמודות לפי הטבלה:", "",
    ...Object.entries(EXTRA).map(([sheet, config]) => `- ${sheet}: ${config.columns.join(", ")}${sheet === "בדיקות_מיידיות" ? " (את ״תוצאה להצגה״ כותבים רק אם לבדיקה אין תוצאות מספריות)" : ""}${sheet === "תוצאות_מספריות" ? "; בנוסף `test` (שם הבדיקה הנוספת בדיוק כפי שהצעת) ו-`unit` (יחידה)" : ""}`), "",
    EXTRAS_EXAMPLE, "");
  return lines.join("\n");
}

// ---- reading pasted answers ------------------------------------------------------------------------------------

/** Every JSON value that looks like an answer in a pasted text: fenced blocks first, otherwise balanced { } found in the text. */
export function extractJsonBlocks(raw) {
  const candidates = [];
  for (const match of raw.matchAll(/```(?:json|JSON)?\s*([\s\S]*?)```/g)) candidates.push(match[1]);
  if (!candidates.length) {
    for (let start = raw.indexOf("{"); start >= 0 && start < raw.length;) {
      let depth = 0, inString = false, escaped = false, end = -1;
      for (let i = start; i < raw.length; i += 1) {
        const ch = raw[i];
        if (inString) { if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === '"') inString = false; continue; }
        if (ch === '"') inString = true;
        else if (ch === "{") depth += 1;
        else if (ch === "}") { depth -= 1; if (depth === 0) { end = i; break; } }
      }
      if (end < 0) break;
      candidates.push(raw.slice(start, end + 1));
      start = raw.indexOf("{", end + 1);
    }
  }
  const parsed = [];
  for (const candidate of candidates) {
    const attempt = candidate.trim();
    try { parsed.push(JSON.parse(attempt)); continue; } catch { /* maybe a trailing comma, which chat assistants often leave */ }
    try { parsed.push(JSON.parse(attempt.replace(/,\s*([}\]])/g, "$1"))); } catch { /* not JSON: ignore this piece of the conversation */ }
  }
  return parsed;
}

/**
 * Merges the pasted answers into a draft. Returns what was accepted and what was not, with reasons.
 * Entries the author edited by hand are kept unless `replace` is set.
 */
export function importReplies({ template, fills, raw, caseId, replace = false }) {
  const blocks = extractJsonBlocks(String(raw ?? ""));
  const items = blocks.flatMap((block) => (Array.isArray(block) ? block : Array.isArray(block?.items) ? block.items : []));
  const extras = blocks.flatMap((block) => (Array.isArray(block?.extras) ? block.extras : []));
  if (!items.length && !extras.length) throw new Error("לא נמצא בטקסט שהודבק JSON עם פריטים. הדביקו את בלוקי ה-JSON שה-AI נתן.");

  const known = new Map();
  for (const spec of SHEETS) for (const group of groupsOf(template, spec)) for (const item of group.items) if (!known.has(item.id)) known.set(item.id, { spec, columns: group.columns, label: item.label });

  const result = { fills: fills ?? emptyFills(template, caseId), accepted: [], rejected: [], keptEdited: [], blocks: blocks.length };
  const seen = new Set();
  for (const entry of items) {
    const id = text(entry?.id);
    const target = known.get(id);
    const reject = (reason) => result.rejected.push({ id: id || "(ללא מזהה)", label: target?.label ?? "", reason });
    if (!target) { reject("מזהה שאינו בתבנית"); continue; }
    if (seen.has(id)) { reject("מופיע יותר מפעם אחת (נלקח הראשון)"); continue; }
    seen.add(id);
    const bad = target.columns.find((column) => typeof entry.fields?.[column] !== "string" || !entry.fields[column].trim());
    if (bad) { reject(`העמודה "${bad}" חסרה או ריקה`); continue; }
    const placeholder = target.columns.find((column) => PLACEHOLDER.test(entry.fields[column]));
    if (placeholder) { reject(`העמודה "${placeholder}" כוללת הוראת תבנית`); continue; }
    if (target.columns.includes("חשיבות במקרה") && !IMPORTANCE.includes(entry.fields["חשיבות במקרה"].trim())) { reject("חשיבות לא תקינה"); continue; }
    const entries = (result.fills.sheets[target.spec.sheet] ??= {});
    if (entries[id]?.edited && !replace) { result.keptEdited.push({ id, label: target.label }); continue; }
    entries[id] = {
      ...entries[id],
      fields: { ...entries[id]?.fields, ...Object.fromEntries(target.columns.map((column) => [column, target.spec.sheet === "מטא_מקרה" ? normalizeMetaValue(id, entry.fields[column]) : entry.fields[column].trim()])) },
      needsReview: entry.needsReview === true || entry.needsReview === "true", note: text(entry.note), reviewed: false, source: "chat",
    };
    delete entries[id].edited;
    result.accepted.push(id);
  }
  importExtras(result, extras, replace);
  return result;
}

const SHEET_ORDER = ["בדיקות_מיידיות", "תוצאות_מספריות"];

/** Items the case adds to the template's list. A sheet's own items first, numeric results last (they refer to a test). */
function importExtras(result, extras, replace) {
  const ordered = [...extras].sort((a, b) => SHEET_ORDER.indexOf(a?.sheet) - SHEET_ORDER.indexOf(b?.sheet));
  for (const extra of ordered) {
    const sheet = text(extra?.sheet);
    const label = text(extra?.label);
    const reject = (reason) => result.rejected.push({ id: label || "(ללא שם)", label, reason });
    const config = EXTRA[sheet];
    if (!config) { reject("גיליון לא מוכר לפריט נוסף"); continue; }
    if (!label) { reject("חסר שם לפריט"); continue; }
    const numeric = sheet === "תוצאות_מספריות";
    const required = config.columns.filter((column) => !(sheet === "בדיקות_מיידיות" && column === "תוצאה להצגה"));
    const bad = required.find((column) => typeof extra.fields?.[column] !== "string" || !extra.fields[column].trim());
    if (bad) { reject(`העמודה "${bad}" חסרה או ריקה`); continue; }
    const placeholder = Object.values(extra.fields ?? {}).find((value) => typeof value === "string" && PLACEHOLDER.test(value));
    if (placeholder) { reject("יש בפריט הוראת תבנית שלא הוחלפה"); continue; }
    if (config.columns.includes("חשיבות במקרה") && !IMPORTANCE.includes(text(extra.fields["חשיבות במקרה"]))) { reject("חשיבות לא תקינה"); continue; }
    const entries = (result.fills.sheets[sheet] ??= {});
    let testId;
    if (numeric) {
      const tests = result.fills.sheets["בדיקות_מיידיות"] ?? {};
      testId = Object.keys(tests).find((id) => tests[id].extra && (id === text(extra.test) || tests[id].label === text(extra.test)));
      if (!testId) { reject("תוצאה מספרית שייכת לבדיקה נוספת, ולא נמצאה בדיקה בשם הזה"); continue; }
    }
    let id = Object.keys(entries).find((key) => entries[key].extra && entries[key].label === label && (!numeric || entries[key].testId === testId));
    if (id && entries[id].edited && !replace) { result.keptEdited.push({ id, label }); continue; }
    if (!id) { try { id = addExtra(result.fills, { sheet, label, testId, unit: extra.unit }); } catch (error) { reject(error.message); continue; } }
    const entry = entries[id];
    entry.fields = { ...entry.fields, ...Object.fromEntries(Object.entries(extra.fields).filter(([column, value]) => config.columns.includes(column) && typeof value === "string" && value.trim()).map(([column, value]) => [column, value.trim()])) };
    if (numeric) entry.unit = text(extra.unit).slice(0, 30);
    Object.assign(entry, { needsReview: extra.needsReview === true || extra.needsReview === "true", note: text(extra.note), reviewed: false, source: "chat" });
    delete entry.edited;
    result.accepted.push(id);
  }
}
