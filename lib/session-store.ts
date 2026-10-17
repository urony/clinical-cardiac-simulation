/**
 * Progress is kept in this browser only (no server). Each patient (case) has its own saved session
 * under the student's recovery code, so leaving one patient for another never overwrites the first.
 * A recovery code restores sessions on the same browser and device; it cannot move work elsewhere.
 */
const PREFIX = "clinical-sim-session:";
const DAY = 24 * 60 * 60 * 1000;

type Payload = { caseId?: string; stage?: string; completed?: boolean } & Record<string, unknown>;
type Stored = { expiresAt: number; updatedAt: number; payload: Payload };

export type SessionSummary = { caseId: string; stage: string; completed: boolean; updatedAt: number };

export const codePattern = /^SIM-[A-Z0-9]{6,10}$/;
const casePattern = /^CASE-\d{3,}$/;

const keyFor = (code: string, caseId: string) => `${PREFIX}${code}:${caseId}`;

function read(key: string): Stored | null {
  try {
    const stored = JSON.parse(localStorage.getItem(key) || "null") as Stored | null;
    return stored && stored.expiresAt > Date.now() ? stored : null;
  } catch { return null; }
}

export function saveSession(code: string, payload: Payload): void {
  if (!codePattern.test(code) || !casePattern.test(payload.caseId ?? "")) throw new Error("נתוני שמירה לא תקינים.");
  const now = Date.now();
  const stored: Stored = { expiresAt: now + (payload.completed ? 14 : 30) * DAY, updatedAt: now, payload };
  try { localStorage.setItem(keyFor(code, payload.caseId!), JSON.stringify(stored)); }
  catch { throw new Error("השמירה בדפדפן אינה זמינה."); }
}

/** Every saved patient of this recovery code, newest first. Includes a session saved by an older version (one per code). */
function all(code: string): Stored[] {
  const found = new Map<string, Stored>();
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key || !key.startsWith(`${PREFIX}${code}:`)) continue;
      const stored = read(key);
      if (stored?.payload.caseId) found.set(stored.payload.caseId, stored);
    }
  } catch { /* storage unavailable */ }
  const legacy = read(PREFIX + code);
  if (legacy?.payload.caseId && !found.has(legacy.payload.caseId)) found.set(legacy.payload.caseId, legacy);
  return [...found.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function listSessions(code: string): SessionSummary[] {
  if (!codePattern.test(code)) return [];
  return all(code).map((stored) => ({ caseId: stored.payload.caseId!, stage: String(stored.payload.stage ?? ""), completed: Boolean(stored.payload.completed), updatedAt: stored.updatedAt }));
}

/** One patient's saved session; without `caseId`, the most recently saved one. */
export function loadSession(code: string, caseId?: string): Payload {
  if (!codePattern.test(code)) throw new Error("קוד שחזור לא תקין.");
  const stored = caseId ? all(code).find((item) => item.payload.caseId === caseId) : all(code)[0];
  if (!stored) throw new Error("לא נמצאה סימולציה פעילה עבור הקוד הזה בדפדפן הזה.");
  return stored.payload;
}

export function deleteSession(code: string, caseId: string): void {
  try { localStorage.removeItem(keyFor(code, caseId)); } catch { /* storage unavailable */ }
  const legacy = read(PREFIX + code);
  if (legacy?.payload.caseId === caseId) { try { localStorage.removeItem(PREFIX + code); } catch { /* storage unavailable */ } }
}
