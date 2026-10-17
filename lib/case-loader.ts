import { catalogEntry, validCaseId, type CaseId } from "./case-catalog";
import type { CaseFile } from "./case-data";

// Each case file becomes its own lazily loaded chunk: a student downloads only the case they open,
// and adding a case does not enlarge the application code.
const loaders = import.meta.glob<CaseFile>("../data/cases/case-*.json", { import: "default" });
const cache = new Map<CaseId, CaseFile>();

export async function loadCase(caseId: CaseId): Promise<CaseFile> {
  const cached = cache.get(caseId);
  if (cached) return cached;
  if (!validCaseId(caseId)) throw new Error(`Unknown case: ${caseId}`);
  const load = loaders[`../data/cases/${catalogEntry(caseId).file}`];
  if (!load) throw new Error(`Case file not found for ${caseId}`);
  const file = await load();
  cache.set(caseId, file);
  return file;
}
