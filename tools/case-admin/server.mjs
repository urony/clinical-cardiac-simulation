#!/usr/bin/env node
// Local case-management interface. It runs ONLY on the author's computer (127.0.0.1), is not part of the
// published site, and has no dependencies. Start it with `npm run admin`.
//
// Safety rules enforced here:
//  - listens on 127.0.0.1 only; every API call needs the random token that was embedded in the page
//    when it was served, and the Host/Origin must be this server (blocks other websites and DNS rebinding);
//  - the AI key lives only in this process's memory: never written to disk, never sent back to the page;
//  - nothing reaches the site's data until the author explicitly confirms, after validation passes and every
//    item the AI flagged was ticked as checked. Publishing never commits or pushes.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateCase } from "../case-tool/case-validation.mjs";
import { draftCase, emptyFills, planDraft } from "../case-tool/draft.mjs";
import { buildChatPackage, importReplies } from "../case-tool/chat-package.mjs";
import { applyPublish, nextCaseId, planPublish } from "../case-tool/publish.mjs";
import { findPython, runXlsxTool } from "../case-tool/python.mjs";
import { addExtra, applyEdit, buildView, removeExtra, unreviewedItems } from "../case-tool/view.mjs";
import { applyFillsToTemplate, buildExtraRows } from "../case-tool/workbook-json.mjs";
import { demoComplete } from "./demo-model.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(here, "../..");
const CASE_ID = /^CASE-\d{3,}$/;
const MAX_BODY = 2 * 1024 * 1024;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

const BRIEF_SECTIONS = [
  ["topic", "נושא ואבחנה"], ["goals", "מטרות למידה"], ["patient", "המטופל"], ["complaint", "תלונה מרכזית ופתיחה"],
  ["history", "אנמנזה: עובדות מרכזיות"], ["exam", "בדיקה גופנית: ממצאים מרכזיים"], ["tests", "בדיקות עזר"],
  ["followup", "בדיקות המשך"], ["decisions", "החלטות וטיפול"], ["feedback", "נקודות לחשיבה ולמשוב"],
];

/** Runs a fixed command in the project folder and returns its exit code and the end of its output. Never called with user input. */
function defaultExec(root) {
  return (command, args) => new Promise((resolve) => {
    // On Windows "npm" is a .cmd file and needs a shell; the arguments are fixed strings, never user input.
    const child = spawn(command, args, { cwd: root, shell: process.platform === "win32" && command === "npm", env: process.env });
    let output = "";
    const collect = (chunk) => { output = (output + chunk.toString("utf8")).slice(-6000); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    child.on("error", (error) => resolve({ code: -1, output: error.message }));
    child.on("close", (code) => resolve({ code, output }));
  });
}

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

export function composeBrief(fields) {
  const parts = ["# תיאור מקרה חדש"];
  for (const [key, heading] of BRIEF_SECTIONS) {
    const value = String(fields?.[key] ?? "").trim();
    if (value) parts.push(`## ${heading}\n${value}`);
  }
  return parts.join("\n\n") + "\n";
}

/**
 * @param {{root?: string, demo?: boolean, complete?: Function, env?: object, providers?: Function, python?: boolean}} [options]
 * `complete`/`providers` let tests replace the AI and the provider list; `python:false` skips the Excel copy.
 */
export function createAdminServer(options = {}) {
  const root = options.root ?? defaultRoot;
  const demo = Boolean(options.demo);
  const env = options.env ?? process.env;
  const token = crypto.randomBytes(24).toString("hex");
  const publicDir = path.join(here, "public");
  const draftsDir = path.join(root, "drafts");
  const templatePath = path.join(root, "data", "template", "case-template.json");
  const templateXlsx = path.join(root, "data", "template", "clinical-simulation-case-template-v2-he.xlsx");
  const indexPath = path.join(root, "data", "cases", "index.json");
  const jobs = new Map();
  const exec = options.exec ?? defaultExec(root);
  let port = 0;
  // The AI settings. The key is kept here only; it is never returned by any endpoint.
  const ai = { providerId: env.CASE_TOOL_PROVIDER || "gemini", apiKey: env.CASE_TOOL_API_KEY || "", model: env.CASE_TOOL_MODEL || "" };

  const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
  const template = () => readJson(templatePath);
  const catalogue = () => readJson(indexPath);
  const caseDir = (id) => { if (!CASE_ID.test(id)) throw new HttpError(400, "מזהה מקרה לא תקין"); return path.join(draftsDir, id); };
  const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8"); };
  const readDraftFile = (id, name, fallback) => { try { return readJson(path.join(caseDir(id), name)); } catch { return fallback; } };

  function draftIds() {
    try { return fs.readdirSync(draftsDir).filter((name) => CASE_ID.test(name)); } catch { return []; }
  }
  function nextId() {
    const used = [...catalogue().cases.map((entry) => entry.id), ...draftIds()];
    return nextCaseId({ cases: used.map((id) => ({ id })) });
  }
  function describeDraft(id) {
    const meta = readDraftFile(id, "meta.json", {});
    return { id, topic: String(meta.fields?.topic ?? "").split("\n")[0].slice(0, 80), status: meta.status ?? "draft", hasDraft: fs.existsSync(path.join(caseDir(id), "fills.json")), updatedAt: meta.updatedAt ?? null };
  }
  function saveMeta(id, patch) {
    const meta = { ...readDraftFile(id, "meta.json", { caseId: id, createdAt: new Date().toISOString() }), ...patch, updatedAt: new Date().toISOString() };
    writeJson(path.join(caseDir(id), "meta.json"), meta);
    return meta;
  }
  const loadFills = (id) => {
    const fills = readDraftFile(id, "fills.json", null);
    if (!fills) throw new HttpError(404, "עדיין אין טיוטה למקרה הזה");
    return fills;
  };
  const saveFills = (id, fills) => writeJson(path.join(caseDir(id), "fills.json"), fills);

  async function getComplete() {
    if (options.complete) return options.complete;
    if (demo) return demoComplete;
    if (!ai.apiKey) throw new HttpError(400, "לא הוגדר מפתח API. הזינו אותו בהגדרות ה-AI בשלב 2.");
    const { completeFromConfig } = await import("../case-tool/load-ai.mjs");
    return (await completeFromConfig(ai)).complete;
  }
  async function providerList() {
    if (options.providers) return options.providers();
    const { listProviders } = await import("../case-tool/load-ai.mjs");
    return listProviders();
  }

  function statusFor(id) {
    const fills = readDraftFile(id, "fills.json", null);
    const meta = readDraftFile(id, "meta.json", {});
    const t = template();
    const file = fills ? applyFillsToTemplate(t, fills, { approved: true }) : null;
    const validation = file ? validateCase(file, t, { chiefComplaint: meta.chiefComplaint }) : { errors: ["עדיין אין טיוטה"], warnings: [] };
    // Readable names for the technical ids (the author should never have to decode "AN-011").
    const names = new Map();
    if (fills) for (const sheet of buildView(t, fills)) for (const item of sheet.items) names.set(`${sheet.sheet}:${item.id}`, { label: item.label, sheetTitle: sheet.title });
    const unreviewed = (fills ? unreviewedItems(fills) : []).map((item) => ({ ...item, label: names.get(`${item.sheet}:${item.id}`)?.label ?? item.id, sheetTitle: names.get(`${item.sheet}:${item.id}`)?.sheetTitle ?? item.sheet }));
    const chiefComplaint = String(meta.chiefComplaint ?? "").trim();
    const blockers = [];
    if (demo) blockers.push("מצב הדגמה: תוכן דוגמה בלבד, אי אפשר להוסיף לאתר");
    if (validation.errors.length) blockers.push(`יש ${validation.errors.length} שגיאות בדיקה`);
    if (unreviewed.length) blockers.push(`${unreviewed.length} פריטים שסומנו לבדיקה טרם אושרו כנבדקו`);
    if (!chiefComplaint) blockers.push("חסרה תלונה מרכזית לתלמיד");
    return { file, validation, unreviewed, chiefComplaint, blockers, canPublish: blockers.length === 0 };
  }

  // ---- routes ------------------------------------------------------------------------------------
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern: new RegExp(`^${pattern}$`), handler });

  route("GET", "/api/state", async () => ({
    nextCaseId: nextId(), demo, cases: catalogue().cases.map((entry) => ({ id: entry.id, demographics: entry.demographics, chiefComplaint: entry.chiefComplaint })),
    drafts: draftIds().map(describeDraft), providers: await providerList(),
    ai: { providerId: ai.providerId, model: ai.model, keySet: Boolean(ai.apiKey) }, python: options.python === false ? false : Boolean(findPython()),
  }));

  route("POST", "/api/ai-config", async (body) => {
    const providers = await providerList();
    if (!providers.some((provider) => provider.id === body.providerId)) throw new HttpError(400, "ספק לא מוכר");
    if (body.apiKey !== undefined && body.apiKey !== "") {
      if (typeof body.apiKey !== "string" || !/^[\w.\-~+/=]{8,300}$/.test(body.apiKey.trim())) throw new HttpError(400, "המפתח נראה לא תקין (אורך או תווים)");
      ai.apiKey = body.apiKey.trim();
    }
    if (body.clearKey) ai.apiKey = "";
    ai.providerId = body.providerId;
    ai.model = typeof body.model === "string" && /^[\w.:\-/@]{0,100}$/.test(body.model.trim()) ? body.model.trim() : "";
    return { providerId: ai.providerId, model: ai.model, keySet: Boolean(ai.apiKey) };
  });

  route("POST", "/api/drafts", async (body) => {
    const id = nextId();
    saveMeta(id, { caseId: id, fields: {}, chiefComplaint: "", status: "draft" });
    void body;
    return { id };
  });

  // Deletes only the working folder of a draft (drafts/CASE-NNN). A case that was already added to the site stays there.
  route("DELETE", "/api/drafts/(CASE-\\d+)", async (_body, [id]) => {
    const dir = caseDir(id);
    if (!fs.existsSync(dir)) throw new HttpError(404, "הטיוטה לא נמצאה");
    if ([...jobs.values()].some((job) => job.caseId === id && job.status === "running")) throw new HttpError(409, "ההפקה עדיין רצה. נסו שוב בעוד רגע.");
    fs.rmSync(dir, { recursive: true, force: true });
    return { deleted: true };
  });

  route("GET", "/api/drafts/(CASE-\\d+)", async (_body, [id]) => {
    const meta = readDraftFile(id, "meta.json", null);
    if (!meta) throw new HttpError(404, "הטיוטה לא נמצאה");
    const fills = readDraftFile(id, "fills.json", null);
    const t = template();
    return { id, meta, brief: composeBrief(meta.fields), plan: planDraft(t), hasDraft: Boolean(fills), problems: fills?.problems ?? [], demo };
  });

  route("PUT", "/api/drafts/(CASE-\\d+)/brief", async (body, [id]) => {
    if (!readDraftFile(id, "meta.json", null)) throw new HttpError(404, "הטיוטה לא נמצאה");
    const fields = {};
    for (const [key] of BRIEF_SECTIONS) fields[key] = String(body.fields?.[key] ?? "").slice(0, 8000);
    const chiefComplaint = String(body.chiefComplaint ?? "").slice(0, 200);
    const meta = saveMeta(id, { fields, chiefComplaint });
    fs.writeFileSync(path.join(caseDir(id), "brief.md"), composeBrief(fields), "utf8");
    return { saved: true, updatedAt: meta.updatedAt };
  });

  route("POST", "/api/drafts/(CASE-\\d+)/generate", async (body, [id]) => {
    const meta = readDraftFile(id, "meta.json", null);
    if (!meta) throw new HttpError(404, "הטיוטה לא נמצאה");
    const hasDraft = fs.existsSync(path.join(caseDir(id), "fills.json"));
    if (hasDraft && body.overwrite !== true) throw new HttpError(409, "כבר יש טיוטה. יצירה מחדש תמחק את העריכות שלך (נדרש אישור).");
    if (body.mode === "empty") {
      saveFills(id, emptyFills(template(), id));
      return { done: true };
    }
    const brief = composeBrief(meta.fields);
    if (brief.trim().length < 80) throw new HttpError(400, "התיאור קצר מדי. מלאו לפחות כמה פרטים על המקרה.");
    const complete = await getComplete();
    if ([...jobs.values()].some((job) => job.caseId === id && job.status === "running")) throw new HttpError(409, "ההפקה כבר רצה");
    const job = { id: crypto.randomUUID(), caseId: id, status: "running", progress: [], error: null, problems: [] };
    jobs.set(job.id, job);
    void (async () => {
      try {
        const fills = await draftCase({ brief, template: template(), caseId: id, complete, onProgress: (step) => job.progress.push(step) });
        saveFills(id, fills);
        job.problems = fills.problems;
        job.status = "done";
      } catch (error) {
        job.status = "error";
        job.error = `${error.message}${error.detail ? ` (פרטי הספק: ${error.detail})` : ""}`;
      }
    })();
    return { jobId: job.id };
  });

  // Work with the author's own AI chat: one document to give to the chat, and a place to paste its answers back.
  route("GET", "/api/drafts/(CASE-\\d+)/ai-package", async (_body, [id]) => {
    const meta = readDraftFile(id, "meta.json", null);
    if (!meta) throw new HttpError(404, "הטיוטה לא נמצאה");
    const hasBrief = Object.values(meta.fields ?? {}).some((value) => String(value).trim());
    return { filename: `${id}-ai-work-document.md`, text: buildChatPackage({ template: template(), brief: hasBrief ? composeBrief(meta.fields) : "", caseId: id }) };
  });

  route("POST", "/api/drafts/(CASE-\\d+)/import", async (body, [id]) => {
    if (!readDraftFile(id, "meta.json", null)) throw new HttpError(404, "הטיוטה לא נמצאה");
    let result;
    try { result = importReplies({ template: template(), fills: readDraftFile(id, "fills.json", null), raw: String(body.text ?? "").slice(0, MAX_BODY), caseId: id, replace: body.replace === true }); }
    catch (error) { throw new HttpError(400, error.message); }
    saveFills(id, result.fills);
    saveMeta(id, {});
    const items = buildView(template(), result.fills).flatMap((sheet) => sheet.items);
    return { accepted: result.accepted.length, rejectedCount: result.rejected.length, rejected: result.rejected.slice(0, 100), keptEdited: result.keptEdited, blocks: result.blocks, remaining: items.filter((item) => !item.filled).length, total: items.length };
  });

  route("GET", "/api/jobs/([0-9a-f-]{36})", async (_body, [jobId]) => {
    const job = jobs.get(jobId);
    if (!job) throw new HttpError(404, "המשימה לא נמצאה");
    return { status: job.status, progress: job.progress, error: job.error, problems: job.problems, steps: job.steps ?? [] };
  });

  route("GET", "/api/drafts/(CASE-\\d+)/view", async (_body, [id]) => {
    const fills = loadFills(id);
    const view = buildView(template(), fills);
    const items = view.flatMap((sheet) => sheet.items);
    return {
      view,
      stats: { total: items.length, filled: items.filter((item) => item.filled).length, flagged: items.filter((item) => item.needsReview).length, flaggedChecked: items.filter((item) => item.needsReview && item.reviewed).length },
    };
  });

  route("PATCH", "/api/drafts/(CASE-\\d+)/entry", async (body, [id]) => {
    const fills = loadFills(id);
    try { applyEdit(fills, body, { template: template() }); } catch (error) { throw new HttpError(400, error.message); }
    saveFills(id, fills);
    saveMeta(id, {});
    return { saved: true };
  });

  // Items the case adds on top of the template's list (for example a urine culture in a kidney case).
  route("POST", "/api/drafts/(CASE-\\d+)/extra", async (body, [id]) => {
    const fills = loadFills(id);
    let newId;
    try { newId = addExtra(fills, body); } catch (error) { throw new HttpError(400, error.message); }
    saveFills(id, fills);
    saveMeta(id, {});
    return { id: newId };
  });

  route("DELETE", "/api/drafts/(CASE-\\d+)/extra", async (body, [id]) => {
    const fills = loadFills(id);
    try { removeExtra(fills, body); } catch (error) { throw new HttpError(400, error.message); }
    saveFills(id, fills);
    saveMeta(id, {});
    return { deleted: true };
  });

  route("POST", "/api/drafts/(CASE-\\d+)/check", async (_body, [id]) => {
    const { validation, unreviewed, blockers, canPublish } = statusFor(id);
    return { errors: validation.errors.slice(0, 200), errorCount: validation.errors.length, warnings: validation.warnings, unreviewed, blockers, canPublish };
  });

  route("POST", "/api/drafts/(CASE-\\d+)/publish", async (body, [id]) => {
    if (demo) throw new HttpError(403, "מצב הדגמה: אי אפשר להוסיף לאתר");
    if (body.confirm !== true) throw new HttpError(400, "נדרש אישור מפורש שבדקת את התוכן הקליני");
    const status = statusFor(id);
    if (!status.canPublish) throw new HttpError(400, `אי אפשר להוסיף עדיין: ${status.blockers.join("; ")}`);
    const t = template();
    const fills = loadFills(id);
    // The Excel copy is the approved source of truth for later edits; it is created when Python is available.
    let workbookPath;
    let excel = "לא נוצר (Python עם openpyxl לא נמצא)";
    if (options.python !== false && findPython()) {
      const out = fs.mkdtempSync(path.join(os.tmpdir(), "case-admin-"));
      const draftXlsx = path.join(out, `${id}-draft.xlsx`);
      workbookPath = path.join(caseDir(id), `${id.toLowerCase()}-patient-database-he.xlsx`);
      // The Excel filler appends exactly the extra rows computed here, so both paths give the same case.
      const fillsForExcel = path.join(out, "fills.json");
      fs.writeFileSync(fillsForExcel, JSON.stringify({ ...fills, extraRows: buildExtraRows(t, fills) }), "utf8");
      runXlsxTool(["fill", templateXlsx, fillsForExcel, draftXlsx]);
      runXlsxTool(["approve", draftXlsx, workbookPath]);
      excel = path.basename(workbookPath);
    }
    const file = applyFillsToTemplate(t, fills, { approved: true, source: workbookPath ? path.basename(workbookPath) : `${id}-created-in-admin` });
    const plan = planPublish({ file, template: t, catalogue: catalogue(), chiefComplaint: status.chiefComplaint, replace: Boolean(body.replace) });
    if (!plan.ok) throw new HttpError(400, plan.errors.join("; "));
    applyPublish({ root, plan, file, workbookPath, replace: Boolean(body.replace) });
    saveMeta(id, { status: "published", publishedAt: new Date().toISOString() });
    return {
      published: true, entry: plan.entry, excel,
      written: [`data/cases/${plan.jsonName}`, "data/cases/index.json", ...(workbookPath ? [`data/source/${path.basename(workbookPath)}`] : [])],
      nextSteps: ["npm test", `git add data && git commit -m "Add ${id}" && git push`],
    };
  });

  // Publishes an already-added case to the live site: tests, commit of the case files only, push. Each step must pass.
  route("POST", "/api/drafts/(CASE-\\d+)/go-live", async (body, [id]) => {
    if (demo) throw new HttpError(403, "מצב הדגמה: אי אפשר לפרסם");
    if (body.confirm !== true) throw new HttpError(400, "נדרש אישור מפורש לפרסום");
    if (readDraftFile(id, "meta.json", {}).status !== "published" || !catalogue().cases.some((entry) => entry.id === id)) throw new HttpError(400, "המקרה עוד לא נוסף לקבצי הפרויקט (שלב 4)");
    if ([...jobs.values()].some((job) => job.kind === "go-live" && job.status === "running")) throw new HttpError(409, "פרסום כבר רץ");
    const job = { id: crypto.randomUUID(), caseId: id, kind: "go-live", status: "running", progress: [], steps: [], error: null, problems: [] };
    jobs.set(job.id, job);
    const step = async (name, run) => {
      const entry = { name, status: "running", output: "" };
      job.steps.push(entry);
      const result = await run();
      entry.status = result.ok ? "ok" : "error"; entry.output = result.output ?? "";
      if (!result.ok) throw new Error(result.message ?? `השלב "${name}" נכשל`);
    };
    void (async () => {
      try {
        let hasChanges = false;
        await step("בדיקה שנשלחים רק קובצי המקרה", async () => {
          const status = await exec("git", ["status", "--porcelain", "--untracked-files=all"]);
          if (status.code !== 0) return { ok: false, output: status.output, message: "לא ניתן לקרוא את מצב git. האם התיקייה היא מאגר git?" };
          const changed = status.output.split("\n").map((line) => line.slice(3).trim().replace(/^"|"$/g, "")).filter(Boolean);
          const foreign = changed.filter((file) => !file.startsWith("data/cases/") && !file.startsWith("data/source/"));
          if (foreign.length) return { ok: false, output: foreign.join("\n"), message: `יש בפרויקט שינויים נוספים שאינם קובצי המקרה, ולכן לא אפרסם אוטומטית: ${foreign.slice(0, 5).join(", ")}` };
          hasChanges = changed.length > 0;
          return { ok: true, output: hasChanges ? changed.join("\n") : "אין שינויים חדשים (ייתכן שהמקרה כבר נשמר)" };
        });
        await step("הרצת הבדיקות (npm test)", async () => {
          const tests = await exec("npm", ["run", "test"]);
          return { ok: tests.code === 0, output: tests.output, message: "הבדיקות נכשלו, ולכן שום דבר לא פורסם. ראו את הפלט למטה." };
        });
        if (hasChanges) {
          await step("שמירת הקבצים (commit)", async () => {
            const add = await exec("git", ["add", "data/cases", "data/source"]);
            if (add.code !== 0) return { ok: false, output: add.output };
            const commit = await exec("git", ["commit", "-m", `Add ${id}`]);
            return { ok: commit.code === 0, output: commit.output };
          });
        }
        await step("שליחה ל-GitHub (push)", async () => {
          const push = await exec("git", ["push", "origin", "main"]);
          return { ok: push.code === 0, output: push.output, message: "השליחה ל-GitHub נכשלה. ייתכן שחסרה הרשאה או שיש עדכונים חדשים במאגר." };
        });
        job.status = "done";
      } catch (error) {
        job.status = "error"; job.error = error.message;
      }
    })();
    return { jobId: job.id };
  });

  // ---- http plumbing -----------------------------------------------------------------------------
  function hostAllowed(request) {
    const host = String(request.headers.host ?? "");
    const ok = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!ok.has(host)) return false;
    const origin = request.headers.origin;
    return !origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
  }
  const send = (response, status, body, type = "application/json; charset=utf-8") => {
    response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
    response.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  function readBody(request) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      // Too large: keep reading (and discarding) so the 413 reply can be delivered; give up on absurd sizes.
      request.on("data", (chunk) => { size += chunk.length; if (size > 20 * MAX_BODY) request.destroy(); else if (size <= MAX_BODY) chunks.push(chunk); });
      request.on("end", () => {
        if (size > MAX_BODY) return reject(new HttpError(413, "הבקשה גדולה מדי"));
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new HttpError(400, "גוף הבקשה אינו JSON תקין")); }
      });
      request.on("error", reject);
    });
  }

  const server = http.createServer(async (request, response) => {
    try {
      if (!hostAllowed(request)) throw new HttpError(403, "הבקשה נדחתה");
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      if (url.pathname.startsWith("/api/")) {
        if (request.headers["x-admin-token"] !== token) throw new HttpError(403, "חסר אסימון גישה. רעננו את הדף.");
        const match = routes.map((item) => ({ item, found: item.pattern.exec(url.pathname) })).find((entry) => entry.found && entry.item.method === request.method);
        if (!match) throw new HttpError(404, "נתיב לא קיים");
        const body = request.method === "GET" ? {} : await readBody(request);
        return send(response, 200, await match.item.handler(body, match.found.slice(1)));
      }
      if (request.method !== "GET") throw new HttpError(405, "שיטה לא נתמכת");
      const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (!["index.html", "app.js", "style.css"].includes(name)) throw new HttpError(404, "לא נמצא");
      let content = fs.readFileSync(path.join(publicDir, name));
      if (name === "index.html") content = Buffer.from(content.toString("utf8").replace("__ADMIN_TOKEN__", token));
      return send(response, 200, content, TYPES[path.extname(name)]);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error("admin error:", error);
      send(response, status, { error: status === 500 ? "שגיאה פנימית בשרת המקומי" : error.message });
    }
  });

  return {
    server, token, jobs,
    listen: (wantedPort = 4180) => new Promise((resolve) => server.listen(wantedPort, "127.0.0.1", () => { port = server.address().port; resolve(port); })),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// ---- command line ---------------------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const demo = args.includes("--demo");
  const portArg = args.indexOf("--port");
  const admin = createAdminServer({ demo });
  const port = await admin.listen(portArg >= 0 ? Number(args[portArg + 1]) : 4180);
  console.log(`ממשק הניהול המקומי פועל: http://127.0.0.1:${port}/${demo ? "\nמצב הדגמה: תוכן דוגמה בלבד, בלי AI אמיתי ובלי אפשרות להוסיף לאתר." : ""}\nהוא נגיש מהמחשב הזה בלבד. לעצירה: Ctrl+C.`);
}
