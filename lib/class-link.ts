import { SimulationError } from "./ai-client";
import { getProvider, type ModelRole } from "./providers";

/**
 * A "class link" carries a teacher's settings (provider, model, API key, limits) in the URL fragment
 * (the part after `#`, which browsers do not send to servers). It is NOT encrypted: anyone who has
 * the link, including a student who inspects the page, can read the key. The teacher is warned and
 * advised to use a dedicated, capped or free key. Limits stored here are soft: they are enforced in
 * the student's browser and can be bypassed; the real cap is the one set with the AI provider.
 */
export type ClassConfig = {
  version: 1;
  /** Random id so each class has its own local usage counter. */
  classId: string;
  providerId: string;
  apiKey: string;
  models?: Partial<Record<ModelRole, string>>;
  className?: string;
  /** Expiry as epoch milliseconds. */
  expiresAt?: number;
  /** Soft limit on provider calls per student browser. */
  maxCalls?: number;
  /** Soft cap on output tokens per answer. */
  maxOutputTokens?: number;
};

export type ParsedHash =
  | { status: "none" }
  | { status: "ok"; config: ClassConfig }
  | { status: "expired"; config: ClassConfig }
  | { status: "invalid"; reason: string };

const ROLES: ModelRole[] = ["classifier", "response", "feedback"];
const MAX_LINK_CHARS = 4000;

type Wire = { v: 1; i: string; p: string; k: string; m?: Partial<Record<ModelRole, string>>; n?: string; e?: number; c?: number; t?: number };

function toBase64Url(text: string) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

export function newClassId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join("").slice(0, 8);
}

/** Checks a config the teacher is about to publish. Returns the first problem in Hebrew, or null. */
export function validateConfig(config: ClassConfig): string | null {
  if (!getProvider(config.providerId)) return "הספק שנבחר אינו מוכר.";
  if (!/^[\w.\-~+/=]{8,300}$/.test(config.apiKey)) return "המפתח נראה לא תקין (אורך או תווים).";
  if (!/^[a-z0-9]{4,16}$/.test(config.classId)) return "מזהה הכיתה אינו תקין.";
  for (const role of ROLES) {
    const model = config.models?.[role];
    if (model !== undefined && (typeof model !== "string" || !/^[\w.:\-/@]{1,100}$/.test(model))) return "שם מודל לא תקין.";
  }
  if (config.className !== undefined && (typeof config.className !== "string" || config.className.length > 60)) return "שם הכיתה ארוך מדי.";
  if (config.expiresAt !== undefined && !Number.isFinite(config.expiresAt)) return "תוקף לא תקין.";
  if (config.maxCalls !== undefined && !(Number.isInteger(config.maxCalls) && config.maxCalls >= 1 && config.maxCalls <= 100000)) return "מכסת הפניות אינה תקינה.";
  if (config.maxOutputTokens !== undefined && !(Number.isInteger(config.maxOutputTokens) && config.maxOutputTokens >= 100 && config.maxOutputTokens <= 8000)) return "אורך התשובה אינו תקין.";
  return null;
}

export function encodeConfig(config: ClassConfig): string {
  const problem = validateConfig(config);
  if (problem) throw new Error(problem);
  const wire: Wire = { v: 1, i: config.classId, p: config.providerId, k: config.apiKey };
  const models = Object.fromEntries(ROLES.filter((role) => config.models?.[role]).map((role) => [role, config.models![role]]));
  if (Object.keys(models).length) wire.m = models;
  if (config.className) wire.n = config.className;
  if (config.expiresAt !== undefined) wire.e = config.expiresAt;
  if (config.maxCalls !== undefined) wire.c = config.maxCalls;
  if (config.maxOutputTokens !== undefined) wire.t = config.maxOutputTokens;
  return toBase64Url(JSON.stringify(wire));
}

export function buildClassLink(baseUrl: string, config: ClassConfig): string {
  return `${baseUrl.split("#")[0]}#c=${encodeConfig(config)}`;
}

/** Reads a class config from `location.hash`. Never trusts the input: every field is re-validated. */
export function parseHash(hash: string, now = Date.now()): ParsedHash {
  const match = /^#c=([A-Za-z0-9_-]+)$/.exec(hash);
  if (!match) return { status: "none" };
  if (hash.length > MAX_LINK_CHARS) return { status: "invalid", reason: "הקישור ארוך מדי." };
  let wire: Partial<Wire>;
  try { wire = JSON.parse(fromBase64Url(match[1])); } catch { return { status: "invalid", reason: "הקישור פגום." }; }
  if (!wire || typeof wire !== "object" || wire.v !== 1) return { status: "invalid", reason: "גרסת קישור לא נתמכת." };
  const config: ClassConfig = {
    version: 1, classId: String(wire.i ?? ""), providerId: String(wire.p ?? ""), apiKey: String(wire.k ?? ""),
    models: wire.m && typeof wire.m === "object" ? Object.fromEntries(ROLES.filter((role) => wire.m![role] !== undefined).map((role) => [role, wire.m![role]])) as ClassConfig["models"] : undefined,
    className: wire.n === undefined ? undefined : String(wire.n),
    expiresAt: wire.e, maxCalls: wire.c, maxOutputTokens: wire.t,
  };
  const problem = validateConfig(config);
  if (problem) return { status: "invalid", reason: problem };
  if (config.expiresAt !== undefined && config.expiresAt <= now) return { status: "expired", config };
  return { status: "ok", config };
}

type CounterStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * Returns a function to call before every provider request. It counts requests in this browser and
 * throws once the teacher's per-student limit is reached. If storage is unavailable the limit cannot
 * be enforced, so requests are allowed (soft limit).
 */
export function createCallBudget(classId: string, maxCalls: number | undefined, storage?: CounterStorage) {
  const key = `clinical-sim-calls:${classId}`;
  return function beforeCall() {
    if (maxCalls === undefined || !storage) return;
    let used = 0;
    try { used = Number(storage.getItem(key)) || 0; } catch { return; }
    if (used >= maxCalls) throw new SimulationError("הגעת למכסת הפניות שהמורה הגדיר לסימולציה הזו. פנה למורה.", 429, "teacher_limit");
    try { storage.setItem(key, String(used + 1)); } catch { /* soft limit */ }
  };
}

export function callsUsed(classId: string, storage?: CounterStorage): number {
  try { return Number(storage?.getItem(`clinical-sim-calls:${classId}`)) || 0; } catch { return 0; }
}
