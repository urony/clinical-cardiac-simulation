// What the admin interface shows for review: for every sheet, the rows that need content, their labels,
// the columns the author can edit, and what the AI (or author) wrote so far.
import { IMPORTANCE } from "./case-validation.mjs";
import { SHEETS, groupsOf } from "./draft.mjs";
import { unitOf } from "./workbook-json.mjs";

export const SHEET_TITLES = {
  "מטא_מקרה": "פרטי המקרה",
  "אנמנזה": "אנמנזה (שאלות למטופל)",
  "בדיקה_גופנית": "בדיקה גופנית",
  "תוצאות_מספריות": "תוצאות מספריות",
  "בדיקות_מיידיות": "בדיקות בסיסיות",
  "בדיקות_המשך": "בדיקות המשך",
  "החלטות_וטיפול": "החלטות וטיפול",
  "כללי_משוב": "כללי משוב",
};

/** Columns that are chosen from a fixed list instead of typed. */
export const CHOICES = { "חשיבות במקרה": IMPORTANCE };

export function buildView(template, fills) {
  return SHEETS.map((spec) => {
    const items = [];
    for (const group of groupsOf(template, spec)) {
      for (const item of group.items) {
        const entry = fills.sheets?.[spec.sheet]?.[item.id];
        items.push({
          id: item.id,
          label: item.label,
          unit: spec.sheet === "תוצאות_מספריות" ? unitOf(template, item.id) : "",
          columns: group.columns,
          values: Object.fromEntries(group.columns.map((column) => [column, entry?.fields?.[column] ?? ""])),
          filled: group.columns.every((column) => Boolean(entry?.fields?.[column])),
          needsReview: Boolean(entry?.needsReview),
          reviewed: Boolean(entry?.reviewed),
          note: entry?.note ?? "",
        });
      }
    }
    return { sheet: spec.sheet, title: SHEET_TITLES[spec.sheet] ?? spec.sheet, guide: spec.guide, items };
  });
}

/** Flagged items the author has not yet ticked as checked (all must be checked before publishing). */
export function unreviewedItems(fills) {
  const open = [];
  for (const [sheet, entries] of Object.entries(fills.sheets ?? {})) {
    for (const [id, entry] of Object.entries(entries)) if (entry.needsReview && !entry.reviewed) open.push({ sheet, id, note: entry.note ?? "" });
  }
  return open;
}

/** Writes an edit into the draft: a typed value, or the "checked" tick. Creates the entry when the AI left the row empty. */
export function applyEdit(fills, { sheet, id, column, value, reviewed }) {
  const spec = SHEETS.find((item) => item.sheet === sheet);
  if (!spec) throw new Error("גיליון לא מוכר");
  fills.sheets ??= {};
  const entries = (fills.sheets[sheet] ??= {});
  const entry = (entries[id] ??= { fields: {}, needsReview: false, note: "", authored: true });
  if (column !== undefined) {
    const allowed = new Set([...spec.columns, spec.extra?.column].filter(Boolean));
    if (!allowed.has(column)) throw new Error("עמודה לא ניתנת לעריכה");
    if (typeof value !== "string" || value.length > 4000) throw new Error("ערך לא תקין");
    if (CHOICES[column] && value !== "" && !CHOICES[column].includes(value)) throw new Error("ערך שאינו מהרשימה");
    entry.fields[column] = value;
    entry.edited = true;
  }
  if (reviewed !== undefined) entry.reviewed = Boolean(reviewed);
  return fills;
}
