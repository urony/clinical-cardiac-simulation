// What the admin interface shows for review: for every sheet, the rows that need content, their labels,
// the columns the author can edit, and what the AI (or author) wrote so far.
import { IMPORTANCE } from "./case-validation.mjs";
import { SHEETS, groupsOf } from "./draft.mjs";
import { EXTRA, numericOf, unitOf } from "./workbook-json.mjs";

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

/** Meta fields (by name) whose value must be one of a fixed set. */
export const FIELD_CHOICES = { "מין": ["גבר", "אישה"] };

/** Columns that are chosen from a fixed list instead of typed. */
export const CHOICES = { "חשיבות במקרה": IMPORTANCE };

/** Columns an extra item is edited in (an extra test with numeric results shows its result in those rows instead). */
function extraColumns(sheet, id, fills) {
  const columns = EXTRA[sheet].columns;
  return sheet === "בדיקות_מיידיות" && numericOf(fills, id).length ? columns.filter((column) => column !== "תוצאה להצגה") : columns;
}

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
          choices: spec.sheet === "מטא_מקרה" && FIELD_CHOICES[item.id] ? { "ערך": FIELD_CHOICES[item.id] } : {},
          values: Object.fromEntries(group.columns.map((column) => [column, entry?.fields?.[column] ?? ""])),
          filled: group.columns.every((column) => Boolean(entry?.fields?.[column])),
          needsReview: Boolean(entry?.needsReview),
          reviewed: Boolean(entry?.reviewed),
          note: entry?.note ?? "",
        });
      }
    }
    // The case's own additional items come after the template's list.
    for (const [id, entry] of Object.entries(fills.sheets?.[spec.sheet] ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      if (!entry.extra) continue;
      const columns = extraColumns(spec.sheet, id, fills);
      items.push({
        id, label: entry.label, extra: true, testId: entry.testId ?? "", unit: entry.unit ?? "", columns, choices: {},
        values: Object.fromEntries(columns.map((column) => [column, entry.fields?.[column] ?? ""])),
        filled: columns.every((column) => Boolean(entry.fields?.[column])),
        needsReview: Boolean(entry.needsReview), reviewed: Boolean(entry.reviewed), note: entry.note ?? "",
      });
    }
    const extraTests = Object.entries(fills.sheets?.["בדיקות_מיידיות"] ?? {}).filter(([, entry]) => entry.extra).map(([id, entry]) => ({ id, label: entry.label }));
    return { sheet: spec.sheet, title: SHEET_TITLES[spec.sheet] ?? spec.sheet, guide: spec.guide, items, extrasAllowed: spec.sheet in EXTRA, testOptions: spec.sheet === "תוצאות_מספריות" ? extraTests : undefined };
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
export function applyEdit(fills, { sheet, id, column, value, reviewed }, context = {}) {
  const spec = SHEETS.find((item) => item.sheet === sheet);
  if (!spec) throw new Error("גיליון לא מוכר");
  fills.sheets ??= {};
  const entries = (fills.sheets[sheet] ??= {});
  if (!entries[id] && context.template && !knownIds(context.template, spec).has(id)) throw new Error("פריט לא מוכר");
  const entry = (entries[id] ??= { fields: {}, needsReview: false, note: "", authored: true });
  if (column !== undefined) {
    const allowed = new Set([...spec.columns, spec.extra?.column].filter(Boolean));
    if (!allowed.has(column)) throw new Error("עמודה לא ניתנת לעריכה");
    if (typeof value !== "string" || value.length > 4000) throw new Error("ערך לא תקין");
    if (CHOICES[column] && value !== "" && !CHOICES[column].includes(value)) throw new Error("ערך שאינו מהרשימה");
    if (sheet === "מטא_מקרה" && FIELD_CHOICES[id] && value !== "" && !FIELD_CHOICES[id].includes(value)) throw new Error("ערך שאינו מהרשימה");
    entry.fields[column] = value;
    entry.edited = true;
  }
  if (reviewed !== undefined) entry.reviewed = Boolean(reviewed);
  return fills;
}

const knownIds = (template, spec) => new Set(groupsOf(template, spec).flatMap((group) => group.items.map((item) => item.id)));
const pad = (number) => String(number).padStart(3, "0");

/** The id the next extra item of a sheet gets: X-AN-001, X-AN-002 ... (numeric rows: <test id>-N1, -N2 ...). */
export function nextExtraId(fills, sheet, testId) {
  const used = Object.keys(fills.sheets?.[sheet] ?? {});
  if (sheet === "תוצאות_מספריות") {
    const taken = used.filter((id) => id.startsWith(`${testId}-N`)).map((id) => Number(id.slice(testId.length + 2))).filter(Number.isFinite);
    return `${testId}-N${(taken.length ? Math.max(...taken) : 0) + 1}`;
  }
  const taken = used.filter((id) => id.startsWith(EXTRA[sheet].prefix)).map((id) => Number(id.slice(EXTRA[sheet].prefix.length + 1))).filter(Number.isFinite);
  return `${EXTRA[sheet].prefix}-${pad((taken.length ? Math.max(...taken) : 0) + 1)}`;
}

/** Adds an empty extra item to the draft and returns its id. A numeric result must belong to an extra test of this case. */
export function addExtra(fills, { sheet, label, testId, unit }) {
  if (!(sheet in EXTRA)) throw new Error("אי אפשר להוסיף פריט לגיליון הזה");
  const name = String(label ?? "").trim();
  if (!name || name.length > 120 || /[\r\n]/.test(name)) throw new Error("שם הפריט חסר או ארוך מדי");
  fills.sheets ??= {};
  const entries = (fills.sheets[sheet] ??= {});
  if (Object.values(entries).some((entry) => entry.extra && entry.label === name && (sheet !== "תוצאות_מספריות" || entry.testId === testId))) throw new Error("פריט בשם הזה כבר קיים");
  const entry = { extra: true, label: name, fields: {}, needsReview: false, reviewed: false, note: "", authored: true };
  if (sheet === "תוצאות_מספריות") {
    const test = fills.sheets["בדיקות_מיידיות"]?.[testId];
    if (!test?.extra) throw new Error("תוצאה מספרית שייכת לבדיקה נוספת של המקרה. הוסיפו קודם את הבדיקה.");
    entry.testId = testId;
    entry.unit = String(unit ?? "").trim().slice(0, 30);
  }
  const id = nextExtraId(fills, sheet, testId);
  entries[id] = entry;
  return id;
}

/** Removes an extra item (never a template item); a test also takes its numeric results with it. */
export function removeExtra(fills, { sheet, id }) {
  const entry = fills.sheets?.[sheet]?.[id];
  if (!entry?.extra) throw new Error("אפשר למחוק רק פריט שנוסף למקרה");
  delete fills.sheets[sheet][id];
  if (sheet === "בדיקות_מיידיות") for (const [metricId, metric] of Object.entries(fills.sheets["תוצאות_מספריות"] ?? {})) if (metric.extra && metric.testId === id) delete fills.sheets["תוצאות_מספריות"][metricId];
}
