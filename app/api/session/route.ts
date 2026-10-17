import { NextResponse } from "next/server";
import { validCaseId } from "../../../lib/case-catalog";

const CREATE = "CREATE TABLE IF NOT EXISTS simulation_sessions (code TEXT PRIMARY KEY, case_id TEXT NOT NULL, payload TEXT NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)";

async function database() {
  // Kept dynamic so the server bundle can also be rendered by the Node-only
  // HTML smoke test; the module exists in the hosted Cloudflare runtime.
  const { env } = await import("cloudflare:workers");
  if (!env.DB) throw new Error("שירות השמירה אינו זמין כרגע.");
  await env.DB.prepare(CREATE).run();
  return env.DB;
}

export async function GET(request: Request) {
  const code = new URL(request.url).searchParams.get("code")?.trim();
  if (!code || !/^SIM-[A-Z0-9]{6,10}$/.test(code)) return NextResponse.json({ error: "קוד שחזור לא תקין." }, { status: 400 });
  try {
    const db = await database();
    const row = await db.prepare("SELECT payload FROM simulation_sessions WHERE code = ?1 AND expires_at > ?2").bind(code, Date.now()).first<{ payload: string }>();
    if (!row) return NextResponse.json({ error: "לא נמצאה סימולציה פעילה עבור הקוד הזה." }, { status: 404 });
    return NextResponse.json({ session: JSON.parse(row.payload) });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "השמירה לא זמינה." }, { status: 503 }); }
}

export async function PUT(request: Request) {
  let body: { code?: string; caseId?: string; payload?: { completed?: boolean } };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "בקשה לא תקינה." }, { status: 400 }); }
  const code = body.code?.trim();
  if (!code || !/^SIM-[A-Z0-9]{6,10}$/.test(code) || !validCaseId(body.caseId) || !body.payload) return NextResponse.json({ error: "נתוני שמירה לא תקינים." }, { status: 400 });
  const now = Date.now(); const days = body.payload.completed ? 14 : 30; const expiresAt = now + days * 24 * 60 * 60 * 1000;
  try {
    const db = await database();
    await db.prepare("INSERT INTO simulation_sessions (code, case_id, payload, expires_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(code) DO UPDATE SET case_id = excluded.case_id, payload = excluded.payload, expires_at = excluded.expires_at, updated_at = excluded.updated_at").bind(code, body.caseId, JSON.stringify(body.payload), expiresAt, now).run();
    return NextResponse.json({ saved: true, expiresAt });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "השמירה לא זמינה." }, { status: 503 }); }
}
