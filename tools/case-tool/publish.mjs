// Publishing a reviewed case = copy its workbook and JSON into the app's data and add a catalogue entry.
// It never commits, never pushes, and never runs unless the author explicitly asks for it.
import fs from "node:fs";
import path from "node:path";
import { metaOf, validateCase } from "./case-validation.mjs";

export function nextCaseId(catalogue) {
  const numbers = catalogue.cases.map((entry) => Number(/^CASE-(\d+)$/.exec(entry.id)?.[1])).filter(Number.isFinite);
  return `CASE-${String((numbers.length ? Math.max(...numbers) : 0) + 1).padStart(3, "0")}`;
}

export const demographicsOf = (initials, sex, age) => `${initials} · ${sex} · ${sex === "אישה" ? "בת" : "בן"} ${age}`;

/**
 * Checks everything and returns what would be written, without touching any file.
 * @returns {{ok: boolean, errors: string[], warnings: string[], entry?: object, jsonName?: string}}
 */
export function planPublish({ file, template, catalogue, chiefComplaint, replace = false }) {
  const { errors, warnings } = validateCase(file, template, { chiefComplaint });
  const meta = metaOf(file);
  if (!String(chiefComplaint ?? "").trim()) errors.push("חסרה תלונה מרכזית (--chief-complaint): זה הטקסט שהתלמיד רואה לפני הפגישה");
  const caseId = meta["מזהה מקרה"];
  if (!replace && catalogue.cases.some((entry) => entry.id === caseId)) errors.push(`המזהה ${caseId} כבר קיים בקטלוג (השתמשו ב---replace רק כדי להחליף במכוון)`);
  if (errors.length) return { ok: false, errors, warnings };
  const jsonName = `case-${caseId.slice(5)}.json`;
  const entry = {
    id: caseId, file: jsonName, initials: meta["ראשי תיבות מטופל"], sex: meta["מין"], age: Number(meta["גיל"]),
    demographics: demographicsOf(meta["ראשי תיבות מטופל"], meta["מין"], meta["גיל"]), chiefComplaint: chiefComplaint.trim(),
  };
  return { ok: true, errors, warnings, entry, jsonName };
}

/** Writes the case JSON, copies the workbook to data/source, and updates index.json. */
export function applyPublish({ root, plan, file, workbookPath, replace = false }) {
  const casesDir = path.join(root, "data", "cases");
  fs.writeFileSync(path.join(casesDir, plan.jsonName), JSON.stringify(file, null, 2), "utf8");
  fs.copyFileSync(workbookPath, path.join(root, "data", "source", path.basename(workbookPath)));
  const indexPath = path.join(casesDir, "index.json");
  const catalogue = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  const existing = catalogue.cases.findIndex((entry) => entry.id === plan.entry.id);
  if (existing >= 0) {
    if (!replace) throw new Error("המקרה כבר קיים");
    catalogue.cases[existing] = { ...catalogue.cases[existing], ...plan.entry };
  } else catalogue.cases.push(plan.entry);
  catalogue.cases.sort((a, b) => a.id.localeCompare(b.id));
  fs.writeFileSync(indexPath, JSON.stringify(catalogue, null, 2) + "\n", "utf8");
}
