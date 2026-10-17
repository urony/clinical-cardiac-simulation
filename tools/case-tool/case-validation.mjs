// Structural and content checks for a case file (the JSON form of a filled case workbook).
// A case that fails any `error` must not be published. Warnings are for the author to look at.
// Plain JS (no build step) so the command-line tool and the tests can import it directly.

export const IMPORTANCE = ["חיוני במקרה", "חשוב", "משלים", "בדרך כלל לא מרכזי"];
export const APPROVED = "מאושר";
export const SEXES = ["גבר", "אישה"];
export const PLACEHOLDER = /\[(?:למילוי|לבחירה|פרשנות|היגיון|השפעה|מעמד|אבחנה|חלופה|פעולה|נוצר|DIS-XXX)[^\]]*\]|CASE-XXX/;
const HELPER_SHEETS = new Set(["קרא_אותי", "הפניה_לתבנית", "בקרת_איכות", "מילון_מזהים", "מדדים_מספריים", "טיוטת_AI"]);

// phase sheet -> { text columns that must be filled, base id column }
export const PHASES = {
  "אנמנזה": { required: ["תשובת המטופל", "היגיון למשוב"] },
  "בדיקה_גופנית": { required: ["ממצא במקרה", "היגיון למשוב"] },
  "בדיקות_מיידיות": { required: ["פרשנות במקרה", "היגיון למשוב"] },
  "בדיקות_המשך": { required: ["תוצאה קבועה", "השפעה על החשיבה", "זמינות", "היגיון למשוב"] },
};
const BASE_ID = "מזהה רכיב בסיס";
const ENTRY_ID = "מזהה ערך בתיק";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

/** Rows of a sheet as objects, using the first row that mentions an id column as the header. */
export function table(file, name, marker = "מזהה") {
  const rows = file.sheets?.[name];
  if (!rows) return null;
  const headerIndex = rows.findIndex((row) => row.some((cell) => text(cell).includes(marker)));
  if (headerIndex < 0) return [];
  const headers = rows[headerIndex].map(text);
  return rows.slice(headerIndex + 1)
    .filter((row) => row.some((cell) => text(cell)))
    .map((row) => Object.fromEntries(headers.map((header, index) => [header || `field_${index}`, row[index] ?? null])));
}

export function metaOf(file) {
  const rows = file.sheets?.["מטא_מקרה"] ?? [];
  const headerIndex = rows.findIndex((row) => text(row[0]) === "שדה" && text(row[1]) === "ערך");
  return Object.fromEntries(rows.slice(headerIndex + 1).filter((row) => text(row[0])).map((row) => [text(row[0]), text(row[1])]));
}

const normalise = (value) => text(value).replace(/[׳'’"“”״]/g, "").replace(/\s+/g, " ").toLowerCase();

/**
 * @param {{sheets: Record<string, unknown[][]>}} file   the case to check
 * @param {{sheets: Record<string, unknown[][]>}} template   the blank template (defines the required ids)
 * @param {{chiefComplaint?: string}} [options]
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateCase(file, template, options = {}) {
  const errors = [];
  const warnings = [];
  const error = (message) => errors.push(message);

  for (const sheet of ["מטא_מקרה", ...Object.keys(PHASES), "החלטות_וטיפול", "כללי_משוב", "תוצאות_מספריות"]) {
    if (!file.sheets?.[sheet]) error(`חסר גיליון: ${sheet}`);
  }
  if (errors.length) return { errors, warnings };

  // --- meta ---------------------------------------------------------------------------------
  const meta = metaOf(file);
  const caseId = meta["מזהה מקרה"];
  if (!/^CASE-\d{3,}$/.test(caseId || "")) error(`מזהה המקרה אינו תקין: "${caseId}"`);
  for (const field of ["אבחנה ידועה למערכת", "ראשי תיבות מטופל", "נוסח פתיחה לתלמיד", "אמת קלינית", "מטרת למידה", "פרסונה קצרה", "מצב בזמן הכניסה"]) {
    if (!text(meta[field])) error(`מטא: השדה "${field}" ריק`);
  }
  const age = Number(meta["גיל"]);
  if (!Number.isInteger(age) || age < 1 || age > 120) error(`מטא: גיל לא תקין "${meta["גיל"]}"`);
  if (!SEXES.includes(meta["מין"])) error(`מטא: מין חייב להיות אחד מ-${SEXES.join(" / ")} (נמצא "${meta["מין"]}")`);
  if (/טיוטה/.test(meta["סטטוס"] || "")) error("מטא: הסטטוס עדיין \"טיוטה\"");
  const diagnosis = normalise(meta["אבחנה ידועה למערכת"]);
  if (diagnosis.length >= 4 && normalise(meta["נוסח פתיחה לתלמיד"]).includes(diagnosis)) error("נוסח הפתיחה לתלמיד חושף את האבחנה");
  if (diagnosis.length >= 4 && options.chiefComplaint && normalise(options.chiefComplaint).includes(diagnosis)) error("התלונה המרכזית חושפת את האבחנה");

  // --- phase sheets (anamnesis, examination, tests) -----------------------------------------------
  const importantIds = new Set();
  for (const [sheet, spec] of Object.entries(PHASES)) {
    const rows = table(file, sheet);
    const expected = new Set((table(template, sheet) ?? []).map((row) => text(row[BASE_ID])).filter(Boolean));
    const seen = new Map();
    for (const row of rows) {
      const baseId = text(row[BASE_ID]);
      seen.set(baseId, (seen.get(baseId) ?? 0) + 1);
      const label = `${sheet} ${baseId || "(ללא מזהה)"}`;
      if (!expected.has(baseId)) error(`${label}: מזהה בסיס שאינו בתבנית`);
      if (caseId && !text(row[ENTRY_ID]).startsWith(`${caseId}-`)) error(`${label}: מזהה הערך בתיק "${text(row[ENTRY_ID])}" אינו מתחיל ב-${caseId}-`);
      if (text(row["סטטוס"]) !== APPROVED) error(`${label}: סטטוס "${text(row["סטטוס"])}" (נדרש "${APPROVED}")`);
      if (!IMPORTANCE.includes(text(row["חשיבות במקרה"]))) error(`${label}: חשיבות לא תקינה "${text(row["חשיבות במקרה"])}"`);
      for (const column of spec.required) if (!text(row[column])) error(`${label}: "${column}" ריק`);
      if (sheet === "אנמנזה" && diagnosis.length >= 4 && normalise(row["תשובת המטופל"]).includes(diagnosis)) warnings.push(`${label}: תשובת המטופל כוללת את שם האבחנה`);
    }
    for (const id of expected) if (!seen.has(id)) error(`${sheet}: חסר מזהה ${id}`);
    for (const [id, count] of seen) if (count > 1) error(`${sheet}: המזהה ${id} מופיע ${count} פעמים`);
    if (sheet === "בדיקות_מיידיות") for (const row of rows) importantIds.add(text(row[BASE_ID]));
  }

  // --- numeric results: the single source of truth for measured values ---------------------------------------
  const numeric = table(file, "תוצאות_מספריות") ?? [];
  const metricIds = new Set();
  for (const row of numeric) {
    const id = text(row["מזהה מדד"]);
    const label = `תוצאות_מספריות ${id || "(ללא מזהה)"}`;
    if (metricIds.has(id)) error(`${label}: מזהה מדד כפול`);
    metricIds.add(id);
    if (!importantIds.has(text(row["מזהה בדיקה"]))) error(`${label}: מזהה בדיקה "${text(row["מזהה בדיקה"])}" אינו בגיליון הבדיקות המיידיות`);
    if (text(row["ערך"]) === "") error(`${label}: ערך ריק`);
    if (text(row["חובת הצגה"]) === "כן" && !text(row["טווח ייחוס"])) warnings.push(`${label}: חובת הצגה "כן" ללא טווח ייחוס`);
    if (text(row["סטטוס"]) !== APPROVED) error(`${label}: סטטוס "${text(row["סטטוס"])}"`);
  }

  // --- decisions and feedback rules ---------------------------------------------------------------------
  for (const [sheet, columns] of [["החלטות_וטיפול", ["שלב", "פעולה או אפשרות", "מעמד במקרה", "היגיון צפוי"]], ["כללי_משוב", ["תחום", "סוג כלל", "הנחיה למערכת"]]]) {
    const ids = new Set();
    for (const row of table(file, sheet) ?? []) {
      const id = text(row["מזהה"]);
      if (ids.has(id)) error(`${sheet}: המזהה ${id} מופיע יותר מפעם אחת`);
      ids.add(id);
      for (const column of columns) if (!text(row[column])) error(`${sheet} ${id}: "${column}" ריק`);
    }
    if (!ids.size) error(`${sheet}: אין שורות`);
  }

  // --- leftover template placeholders anywhere in the content sheets -----------------------------
  for (const [sheet, rows] of Object.entries(file.sheets)) {
    if (HELPER_SHEETS.has(sheet)) continue;
    rows.forEach((row, index) => row.forEach((cell) => {
      if (typeof cell === "string" && PLACEHOLDER.test(cell)) error(`${sheet} שורה ${index + 1}: נשארה הוראת תבנית "${cell.slice(0, 40)}"`);
    }));
  }
  return { errors, warnings };
}
