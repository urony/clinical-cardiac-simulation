// Work with the author's OWN AI chat instead of a paid API call: the author downloads one document, gives it
// to a chat assistant (ChatGPT, Claude, Gemini ...), talks the case through with it, and pastes the answers back.
// This module builds that document and reads the pasted answers; nothing here calls any service.
import { IMPORTANCE, PLACEHOLDER } from "./case-validation.mjs";
import { SHEETS, SYSTEM, emptyFills, groupsOf, chunkSize } from "./draft.mjs";
import { unitOf } from "./workbook-json.mjs";

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
export function buildChatPackage({ template, brief = "", caseId }) {
  const groups = chatGroups(template);
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
  lines.push("---", "", `## רשימת הקבוצות להפקה (${groups.length} קבוצות)`, "");
  groups.forEach((group, index) => {
    lines.push(`### קבוצה ${index + 1} מתוך ${groups.length}: ${group.spec.sheet.replace(/_/g, " ")} (${group.items.length} פריטים)`, "",
      group.spec.guide, "", `העמודות למילוי: ${group.columns.join(", ")}`, "",
      "רשימת הפריטים (זה קלט, לא הפלט; ה-`topic` הוא שם הפריט):", "", "```json", JSON.stringify(group.items, null, 1), "```", "");
  });
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
  if (!items.length) throw new Error("לא נמצא בטקסט שהודבק JSON עם פריטים. הדביקו את בלוקי ה-JSON שה-AI נתן.");

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
      fields: { ...entries[id]?.fields, ...Object.fromEntries(target.columns.map((column) => [column, entry.fields[column].trim()])) },
      needsReview: entry.needsReview === true || entry.needsReview === "true", note: text(entry.note), reviewed: false, source: "chat",
    };
    delete entries[id].edited;
    result.accepted.push(id);
  }
  return result;
}
