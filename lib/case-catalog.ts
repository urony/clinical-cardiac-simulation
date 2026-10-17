import catalog from "../data/cases/index.json";

/**
 * The catalogue lists the cases students can choose from. It holds only what is visible before the
 * learner approaches the patient (name initials, sex, age, chief complaint) — never the diagnosis,
 * persona or any clinical fact, which stay in each case's own file. Safe to import in the browser.
 * Adding a case = add its JSON file under data/cases and one entry in data/cases/index.json.
 */
export type CaseId = string;
export type CatalogEntry = { id: CaseId; file: string; initials: string; sex: string; age: number; demographics: string; chiefComplaint: string; maxAnamnesisFacts?: number };

export const availableCases: CatalogEntry[] = catalog.cases;
export const DEFAULT_MAX_FACTS = 12;

export function validCaseId(value: unknown): value is CaseId {
  return typeof value === "string" && availableCases.some((entry) => entry.id === value);
}

export function catalogEntry(caseId: CaseId): CatalogEntry {
  return availableCases.find((entry) => entry.id === caseId) ?? availableCases[0];
}
