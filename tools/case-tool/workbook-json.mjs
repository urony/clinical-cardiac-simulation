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
      if (!index.has(id)) throw new Error(`${sheet}: מזהה שאינו בתבנית: ${id}`);
      for (const [column, value] of Object.entries(entry.fields)) {
        const position = header.indexOf(column);
        if (position < 0) throw new Error(`${sheet}: עמודה שאינה בתבנית: ${column}`);
        rows[index.get(id)][position] = value;
      }
    }
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
