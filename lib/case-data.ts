import { availableCases, validCaseId, type CaseId } from "./case-catalog";

/** Server-only: holds every case's full clinical data. Import `case-catalog` instead in browser code. */
type Cell = string | number | boolean | null;
type Sheet = Cell[][];
type CaseFile = { source: string; sheets: Record<string, Sheet> };
export type CaseItem = { id: string; label: string; answer: string; importance: string; rationale: string; fields: Record<string, Cell> };

const files = import.meta.glob<CaseFile>("../data/cases/case-*.json", { eager: true, import: "default" });

export { validCaseId, type CaseId };
function getCase(caseId: CaseId = availableCases[0].id): CaseFile {
  const entry = availableCases.find((item) => item.id === caseId);
  const file = entry && files[`../data/cases/${entry.file}`];
  if (!file) throw new Error(`Case data not found: ${caseId}`);
  return file;
}
function text(value: Cell | undefined) { return value === null || value === undefined ? "" : String(value).trim(); }

function table(name: string, caseId: CaseId = availableCases[0].id) {
  const rows = getCase(caseId).sheets[name] ?? [];
  const headerIndex = rows.findIndex((row) => row.some((cell) => text(cell).includes("מזהה")));
  if (headerIndex < 0) return [] as Record<string, Cell>[];
  const headers = rows[headerIndex].map(text);
  return rows.slice(headerIndex + 1).filter((row) => row.some((cell) => text(cell))).map((row) => Object.fromEntries(headers.map((header, index) => [header || `field_${index}`, row[index] ?? null])));
}

function field(row: Record<string, Cell>, terms: string[]) {
  const key = Object.keys(row).find((candidate) => terms.some((term) => candidate.includes(term)));
  return key ? text(row[key]) : "";
}

const phaseSheets: Record<string, string> = { anamnesis: "אנמנזה", examination: "בדיקה_גופנית", immediateTests: "בדיקות_מיידיות", followupTests: "בדיקות_המשך" };

export function phaseItems(phase: string, caseId: CaseId = availableCases[0].id): CaseItem[] {
  const sheet = phaseSheets[phase];
  if (!sheet) return [];
  return table(sheet, caseId).map((row, index) => {
    const id = text(row["מזהה רכיב בסיס"]) || text(row["מזהה בדיקה"]) || field(row, ["מזהה ערך בתיק"]) || `${phase}-${index + 1}`;
    const labelTerms: Record<string, string[]> = { anamnesis: ["כוונת הבירור"], examination: ["רכיב בדיקה"], immediateTests: ["בדיקה או רכיב"], followupTests: ["בדיקה"] };
    const label = field(row, labelTerms[phase] || []) || `פריט ${index + 1}`;
    let answer = field(row, ["תשובת המטופל", "ממצא", "תוצאה קבועה", "תוצאה"]);
    if (phase === "immediateTests") {
      const numeric = table("תוצאות_מספריות", caseId).filter((result) => field(result, ["מזהה בדיקה"]) === id).map((result) => {
        const name = field(result, ["שם המדד"]); const value = field(result, ["ערך"]); const unit = field(result, ["יחידה"]); const reference = field(result, ["טווח ייחוס"]);
        return `${name}: ${value}${unit ? ` ${unit}` : ""}${reference ? ` (טווח ייחוס: ${reference})` : ""}`;
      });
      if (numeric.length) answer = numeric.join("; ");
    }
    // Several qualitative tests deliberately carry the marker “created
    // automatically from numeric results” in the source workbook.  That marker
    // is editorial metadata, never a learner-facing result.  When no numeric
    // source row exists, the approved clinical interpretation is the actual
    // result to present.
    if (!answer || answer.startsWith("נוצר אוטומטית")) answer = field(row, ["פרשנות במקרה"]);
    if (!answer) answer = Object.entries(row).filter(([key]) => !key.includes("מזהה") && !key.includes("חשיבות") && !key.includes("היגיון") && !key.includes("לא להזנה")).map(([key, value]) => `${key}: ${text(value)}`).filter((line) => !line.endsWith(":") && !line.includes("נוצר אוטומטית")).join("; ");
    return { id, label, answer, importance: field(row, ["חשיבות"]), rationale: field(row, ["היגיון"]), fields: row };
  }).filter((item) => item.id && item.label);
}

export function caseMeta(caseId: CaseId = availableCases[0].id) {
  const rows = getCase(caseId).sheets["מטא_מקרה"] ?? [];
  const headerIndex = rows.findIndex((row) => text(row[0]) === "שדה" && text(row[1]) === "ערך");
  const lookup = Object.fromEntries(rows.slice(headerIndex + 1).filter((row) => text(row[0])).map((row) => [text(row[0]), text(row[1])]));
  return { id: lookup["מזהה מקרה"] || caseId, initials: lookup["ראשי תיבות מטופל"] || "א׳ ש׳", age: lookup["גיל"], sex: lookup["מין"], opening: lookup["נוסח פתיחה לתלמיד"], persona: lookup["פרסונה קצרה"], retentionDays: lookup["משך שמירה"] || "14", learningGoal: lookup["מטרת למידה"] };
}

export function allFeedbackItems(caseId: CaseId = availableCases[0].id) { return ["anamnesis", "examination", "immediateTests", "followupTests"].flatMap((phase) => phaseItems(phase, caseId)); }
export function decisions(caseId: CaseId = availableCases[0].id) { return table("החלטות_וטיפול", caseId).map((row) => ({ id: field(row, ["מזהה"]), stage: field(row, ["שלב"]), action: field(row, ["פעולה או אפשרות"]), status: field(row, ["מעמד במקרה"]), rationale: field(row, ["היגיון צפוי"]) })); }
export function feedbackRules(caseId: CaseId = availableCases[0].id) { return table("כללי_משוב", caseId).map((row) => ({ domain: field(row, ["תחום"]), type: field(row, ["סוג כלל"]), instruction: field(row, ["הנחיה למערכת"]) })); }
