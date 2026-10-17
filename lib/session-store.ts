/**
 * Progress is kept in this browser only (no server). A recovery code restores a session on the same
 * browser and device; it cannot move work to another device.
 */
const PREFIX = "clinical-sim-session:";
const DAY = 24 * 60 * 60 * 1000;

type Stored = { expiresAt: number; updatedAt: number; payload: { completed?: boolean } & Record<string, unknown> };

export const codePattern = /^SIM-[A-Z0-9]{6,10}$/;

export function saveSession(code: string, payload: Stored["payload"]): void {
  if (!codePattern.test(code)) throw new Error("נתוני שמירה לא תקינים.");
  const now = Date.now();
  const stored: Stored = { expiresAt: now + (payload.completed ? 14 : 30) * DAY, updatedAt: now, payload };
  try { localStorage.setItem(PREFIX + code, JSON.stringify(stored)); }
  catch { throw new Error("השמירה בדפדפן אינה זמינה."); }
}

export function loadSession(code: string): Stored["payload"] {
  if (!codePattern.test(code)) throw new Error("קוד שחזור לא תקין.");
  let stored: Stored | null = null;
  try { stored = JSON.parse(localStorage.getItem(PREFIX + code) || "null"); } catch { stored = null; }
  if (!stored || stored.expiresAt <= Date.now()) throw new Error("לא נמצאה סימולציה פעילה עבור הקוד הזה בדפדפן הזה.");
  return stored.payload;
}
