// Builds the case JSON (the same shape the Excel converter produces) directly from the blank template
// and an AI/author draft ("fills"), without Excel. Mirrors xlsx_tool.py fill + approve, so a case
// edited in the admin interface and a case edited in Excel end up identical.
import { table } from "./case-validation.mjs";

const KEYS = {
  "אנמנזה": "מזהה רכיב בסיס",
  "בדיקה_גופנית": "מזהה רכיב בסיס",
  "בדיקות_מיידיות": "מזהה רכיב בסיס",
  "בדיקות_המשך": "מזהה רכיב בסיס",
  "תוצאות_מספריות": "מזהה מדד",
  "החלטות_וטיפול": "מזהה",
  "כללי_משוב": "מזהה",
};
/**
 * Extra items: a case may add its own questions, exam components, tests and follow-up tests (for example a
 * urine culture in a kidney case) on top of the template's fixed list. Their ids start with "X-" and are unique
 * per case. A numeric result of an extra test is its own row in the numeric-results sheet, linked by test id.
 */
export const EXTRA = {
  "אנמנזה": { prefix: "X-AN", label: "כוונת הבירור", columns: ["תשובת המטופל", "חשיבות במקרה", "היגיון למשוב"] },
  "בדיקה_גופנית": { prefix: "X-PE", label: "רכיב בדיקה", columns: ["ממצא במקרה", "חשיבות במקרה", "היגיון למשוב"] },
  "בדיקות_מיידיות": { prefix: "X-IT", label: "בדיקה או רכיב", columns: ["תוצאה להצגה", "פרשנות במקרה", "חשיבות במקרה", "היגיון למשוב"] },
  "בדיקות_המשך": { prefix: "X-FT", label: "בדיקה", columns: ["תוצאה קבועה", "השפעה על החשיבה", "חשיבות במקרה", "היגיון למשוב"] },
  "תוצאות_מספריות": { prefix: "X-IT", label: "שם המדד", columns: ["ערך", "טווח ייחוס", "פרשנות במקרה"] },
};
export const EXTRA_ID = {
  "אנמנזה": /^X-AN-\d{3}$/, "בדיקה_גופנית": /^X-PE-\d{3}$/, "בדיקות_מיידיות": /^X-IT-\d{3}$/, "בדיקות_המשך": /^X-FT-\d{3}$/, "תוצאות_מספריות": /^X-IT-\d{3}-N\d+$|^IT-\d{3}-N\d+$/,
};
export const AUTO_DISPLAY = "נוצר אוטומטית מתוצאות_מספריות.";

export const DRAFT = "טיוטה";
export const APPROVED = "מאושר";
export const META_APPROVED = "מאושר לבניית אב-טיפוס";
const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

function headerIndexOf(rows, marker) {
  return rows.findIndex((row) => row.some((cell) => typeof cell === "string" && cell.includes(marker)));
}

/**
 * @param {{sheets: Record<string, unknown[][]>}} template
 * @param {{caseId: string, sheets: Record<string, Record<string, {fields: Record<string, string>}>>}} fills
 * @param {{approved?: boolean, source?: string}} [options] `approved` turns every "draft" status into "approved" (done only after the author's review)
 */
export function applyFillsToTemplate(template, fills, { approved = false, source } = {}) {
  const file = JSON.parse(JSON.stringify(template));
  if (source) file.source = source;
  for (const rows of Object.values(file.sheets)) {
    for (const row of rows) row.forEach((cell, index) => { if (typeof cell === "string" && cell.includes("CASE-XXX")) row[index] = cell.replace(/CASE-XXX/g, fills.caseId); });
  }

  for (const [sheet, entries] of Object.entries(fills.sheets ?? {})) {
    const rows = file.sheets[sheet];
    if (!rows) throw new Error(`הגיליון ${sheet} אינו בתבנית`);
    if (sheet === "מטא_מקרה") {
      const start = headerIndexOf(rows, "שדה");
      const index = new Map(rows.slice(start + 1).map((row, offset) => [text(row[0]), start + 1 + offset]));
      for (const [field, entry] of Object.entries(entries)) {
        if (!index.has(field)) throw new Error(`שדה מטא שאינו בתבנית: ${field}`);
        rows[index.get(field)][1] = entry.fields["ערך"];
      }
      continue;
    }
    const start = headerIndexOf(rows, "מזהה");
    const header = rows[start].map((cell) => text(cell));
    const keyColumn = header.indexOf(KEYS[sheet]);
    const index = new Map(rows.slice(start + 1).map((row, offset) => [text(row[keyColumn]), start + 1 + offset]));
    for (const [id, entry] of Object.entries(entries)) {
      if (entry.extra) continue;
      if (!index.has(id)) throw new Error(`${sheet}: מזהה שאינו בתבנית: ${id}`);
      for (const [column, value] of Object.entries(entry.fields)) {
        const position = header.indexOf(column);
        if (position < 0) throw new Error(`${sheet}: עמודה שאינה בתבנית: ${column}`);
        rows[index.get(id)][position] = value;
      }
    }
  }

  // Extra items go below the template's rows, aligned to the sheet's own columns.
  for (const [sheet, extraRows] of Object.entries(buildExtraRows(template, fills))) {
    const rows = file.sheets[sheet];
    const header = rows[headerIndexOf(rows, "מזהה")].map((cell) => text(cell));
    for (const row of extraRows) rows.push(header.map((name) => (row[name] === undefined || row[name] === "" ? null : row[name])));
  }

  if (approved) {
    for (const [sheet, rows] of Object.entries(file.sheets)) {
      if (sheet === "טיוטת_AI") continue;
      if (sheet === "מטא_מקרה") {
        const start = headerIndexOf(rows, "שדה");
        for (const row of rows.slice(start + 1)) if (text(row[0]) === "סטטוס" && (text(row[1]) === DRAFT || text(row[1]) === "")) row[1] = META_APPROVED;
        continue;
      }
      const start = headerIndexOf(rows, "מזהה");
      if (start < 0) continue;
      const statusColumn = rows[start].map((cell) => text(cell)).indexOf("סטטוס");
      if (statusColumn < 0) continue;
      for (const row of rows.slice(start + 1)) if (row[statusColumn] === DRAFT) row[statusColumn] = APPROVED;
    }
  }
  return file;
}

/** The unit written in the template for a numeric measure, shown next to the value being edited. */
export function unitOf(template, metricId) {
  const row = (table(template, "תוצאות_מספריות") ?? []).find((item) => text(item["מזהה מדד"]) === metricId);
  return row ? text(row["יחידה"]) : "";
}

const entriesOf = (fills, sheet) => Object.entries(fills.sheets?.[sheet] ?? {});

/** Numeric rows (extra) that belong to an extra test, by test id. */
export function numericOf(fills, testId) {
  return entriesOf(fills, "תוצאות_מספריות").filter(([, entry]) => entry.extra && entry.testId === testId);
}

/**
 * The rows to append for the extra items of a draft, as {column name: value} per sheet, in the same column
 * order the template uses. Both the JSON builder and the Excel filler append exactly these rows.
 */
export function buildExtraRows(template, fills) {
  const caseId = fills.caseId;
  const rows = {};
  for (const sheet of Object.keys(EXTRA)) {
    const config = EXTRA[sheet];
    const defaults = (table(template, sheet) ?? [])[0] ?? {};
    for (const [id, entry] of entriesOf(fills, sheet).sort(([a], [b]) => a.localeCompare(b))) {
      if (!entry.extra) continue;
      const f = entry.fields ?? {};
      let row;
      if (sheet === "תוצאות_מספריות") {
        row = { "מזהה מדד": id, "מזהה בדיקה": entry.testId, "שם המדד": entry.label, "ערך": f["ערך"], "יחידה": entry.unit ?? "", "טווח ייחוס": f["טווח ייחוס"], "פרשנות במקרה": f["פרשנות במקרה"], "חובת הצגה": "כן", "סטטוס": DRAFT };
      } else {
        row = { "מזהה ערך בתיק": `${caseId}-${id}`, "מזהה רכיב בסיס": id, [config.label]: entry.label, "סטטוס": DRAFT };
        for (const column of config.columns) row[column] = f[column];
        for (const column of ["הערות הפעלה", "זמינות"]) if (column in defaults) row[column] = defaults[column];
        if (sheet === "בדיקות_מיידיות") row["תוצאה להצגה"] = numericOf(fills, id).length ? AUTO_DISPLAY : f["תוצאה להצגה"];
      }
      (rows[sheet] ??= []).push(row);
    }
  }
  return rows;
}
