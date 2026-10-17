// Tests for the local case-management interface: its safety rules, the whole flow with a fake AI,
// the review rules, and that it produces exactly what the Excel path produces. No network, no real key.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAdminServer, composeBrief } from "../tools/case-admin/server.mjs";
import { IMPORTANCE, validateCase } from "../tools/case-tool/case-validation.mjs";
import { draftCase } from "../tools/case-tool/draft.mjs";
import { findPython, runXlsxTool } from "../tools/case-tool/python.mjs";
import { applyFillsToTemplate } from "../tools/case-tool/workbook-json.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const template = JSON.parse(fs.readFileSync(path.join(repo, "data/template/case-template.json"), "utf8"));
const realIndexBefore = fs.readFileSync(path.join(repo, "data/cases/index.json"), "utf8");
const providers = () => [{ id: "gemini", label: "Google Gemini (מומלץ)" }, { id: "openai", label: "OpenAI" }];
const python = findPython();

/** A fake model that fills every requested item with content that passes validation; every 7th id is flagged for review. */
const META = { "ראשי תיבות מטופל": "א׳ ש׳", "גיל": "58", "מין": "גבר", "אבחנה ידועה למערכת": "מחלת בדיקה פיקטיבית", "נוסח פתיחה לתלמיד": "א׳ ש׳, גבר בן 58, פונה בשל אי-נוחות." };
async function fakeComplete(request) {
  const columns = request.json.schema.properties.items.items.properties.fields.required;
  const listed = JSON.parse(request.user.split("הפריטים (החזר פריט אחד לכל מזהה):\n")[1].split("\n\n")[0]);
  return JSON.stringify({ items: listed.map((item) => ({
    id: item.id, needsReview: item.id.endsWith("7"), note: item.id.endsWith("7") ? "הומצא" : "",
    fields: Object.fromEntries(columns.map((column) => [column, column === "חשיבות במקרה" ? IMPORTANCE[1] : column === "ערך" && META[item.id] ? META[item.id] : `${column} של ${item.id}`])),
  })) });
}

/** A scratch copy of the parts of the project the admin server reads and writes. */
function scratchRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "case-admin-root-"));
  fs.mkdirSync(path.join(root, "data", "template"), { recursive: true });
  fs.mkdirSync(path.join(root, "data", "cases"), { recursive: true });
  fs.mkdirSync(path.join(root, "data", "source"), { recursive: true });
  for (const name of ["case-template.json", "clinical-simulation-case-template-v2-he.xlsx"]) fs.copyFileSync(path.join(repo, "data/template", name), path.join(root, "data/template", name));
  fs.copyFileSync(path.join(repo, "data/cases/index.json"), path.join(root, "data/cases/index.json"));
  return root;
}

async function startAdmin(options = {}) {
  const root = options.root ?? scratchRoot();
  const admin = createAdminServer({ root, providers, complete: fakeComplete, python: false, env: {}, ...options });
  const port = await admin.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, url, body, headers = {}) => {
    const response = await fetch(base + url, { method, headers: { "content-type": "application/json", "x-admin-token": admin.token, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, json: await response.json().catch(() => ({})), response };
  };
  return { admin, root, base, port, call, close: () => admin.close() };
}

const BRIEF_FIELDS = { topic: "אבחנה בדיקה פיקטיבית, תלמידי י״ב", goals: "זיהוי התמונה הקלינית", patient: "א׳ ש׳, גבר בן 58, מדבר מעט", complaint: "אי-נוחות", history: "תסמין במאמץ, ללא מחלות רקע", exam: "בדיקה תקינה", tests: "אק״ג תקין", followup: "אקו תקין", decisions: "שחרור עם מעקב", feedback: "חשיבה על גורמי סיכון" };

async function createWithDraft(ctx) {
  const { json: created } = await ctx.call("POST", "/api/drafts", {});
  await ctx.call("PUT", `/api/drafts/${created.id}/brief`, { fields: BRIEF_FIELDS, chiefComplaint: "אי-נוחות בחזה" });
  const { json: start } = await ctx.call("POST", `/api/drafts/${created.id}/generate`, { mode: "ai" });
  for (let i = 0; i < 200; i += 1) {
    const { json: job } = await ctx.call("GET", `/api/jobs/${start.jobId}`);
    if (job.status !== "running") { assert.equal(job.status, "done", job.error); return created.id; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the draft job never finished");
}

test.after(() => { assert.equal(fs.readFileSync(path.join(repo, "data/cases/index.json"), "utf8"), realIndexBefore, "the real catalogue must never be touched by these tests"); });

// ---------------------------------------------------------------------------------------------
// safety

test("every API call needs the page's token; the token is embedded in the page and the page is locked down", async () => {
  const ctx = await startAdmin();
  try {
    const noToken = await fetch(`${ctx.base}/api/state`);
    assert.equal(noToken.status, 403);
    const wrong = await ctx.call("GET", "/api/state", undefined, { "x-admin-token": "nope" });
    assert.equal(wrong.status, 403);
    assert.equal((await ctx.call("GET", "/api/state")).status, 200);
    const page = await fetch(`${ctx.base}/`);
    const html = await page.text();
    assert.ok(html.includes(ctx.admin.token), "the token is in the served page");
    assert.ok(!fs.readFileSync(path.join(repo, "tools/case-admin/public/app.js"), "utf8").includes(ctx.admin.token));
    assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  } finally { await ctx.close(); }
});

test("requests that name another host or come from another website are refused (DNS rebinding and cross-site calls)", async () => {
  const ctx = await startAdmin();
  try {
    const viaHost = (host, extra = {}) => new Promise((resolve, reject) => {
      const request = http.request({ host: "127.0.0.1", port: ctx.port, path: "/api/state", headers: { host, "x-admin-token": ctx.admin.token, ...extra } }, (response) => { response.resume(); resolve(response.statusCode); });
      request.on("error", reject); request.end();
    });
    assert.equal(await viaHost("evil.example"), 403);
    assert.equal(await viaHost(`127.0.0.1:${ctx.port}`, { origin: "https://evil.example" }), 403);
    assert.equal(await viaHost(`127.0.0.1:${ctx.port}`), 200);
    assert.equal(await viaHost(`localhost:${ctx.port}`), 200);
  } finally { await ctx.close(); }
});

test("only the three interface files are served, ids are validated, and oversized bodies are refused", async () => {
  const ctx = await startAdmin();
  try {
    for (const name of ["server.mjs", "../server.mjs", "..%2Fserver.mjs", "package.json", "demo-model.mjs"]) assert.equal((await fetch(`${ctx.base}/${name}`)).status, 404, name);
    for (const name of ["app.js", "style.css"]) assert.equal((await fetch(`${ctx.base}/${name}`)).status, 200);
    assert.equal((await ctx.call("GET", "/api/drafts/CASE-1/view")).status, 404, "malformed ids never reach the file system");
    assert.equal((await ctx.call("GET", "/api/drafts/..%2F..%2Fx/view")).status, 404);
    assert.equal((await ctx.call("PUT", "/api/drafts/CASE-999/brief", { fields: {} })).status, 404);
    assert.equal((await ctx.call("PUT", "/api/drafts/CASE-004/brief", { fields: { topic: "x".repeat(3 * 1024 * 1024) } })).status, 413);
    assert.equal((await ctx.call("DELETE", "/api/state")).status, 404);
  } finally { await ctx.close(); }
});

test("the interface code builds all text with textContent: no innerHTML, eval or inline scripts", () => {
  const app = fs.readFileSync(path.join(repo, "tools/case-admin/public/app.js"), "utf8");
  for (const forbidden of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /\beval\(/, /document\.write/, /new Function/]) assert.doesNotMatch(app, forbidden);
  const html = fs.readFileSync(path.join(repo, "tools/case-admin/public/index.html"), "utf8");
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/, "no inline script");
  assert.doesNotMatch(html, /https?:\/\//, "no external resources");
});

test("the AI key stays in memory: validated, never echoed back, never written to disk", async () => {
  const ctx = await startAdmin();
  const KEY = "AIza-fake-key-for-test-123456";
  try {
    assert.equal((await ctx.call("POST", "/api/ai-config", { providerId: "gemini", apiKey: "bad key with spaces" })).status, 400);
    assert.equal((await ctx.call("POST", "/api/ai-config", { providerId: "nonexistent", apiKey: KEY })).status, 400);
    const saved = await ctx.call("POST", "/api/ai-config", { providerId: "gemini", apiKey: KEY, model: "my-model" });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json, { providerId: "gemini", model: "my-model", keySet: true });
    const state = await ctx.call("GET", "/api/state");
    assert.equal(state.json.ai.keySet, true);
    assert.ok(!JSON.stringify(state.json).includes(KEY));
    assert.ok(!JSON.stringify(saved.json).includes(KEY));
    for (const file of walk(ctx.root)) assert.ok(!fs.readFileSync(file).includes(KEY), `${file} must not contain the key`);
    const cleared = await ctx.call("POST", "/api/ai-config", { providerId: "gemini", clearKey: true });
    assert.equal(cleared.json.keySet, false);
  } finally { await ctx.close(); }
});

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
}

test("without a key (and not in demo mode) the AI draft is refused with a clear message and no call", async () => {
  const calls = [];
  const ctx = await startAdmin({ complete: undefined, env: {} });
  try {
    const { json: created } = await ctx.call("POST", "/api/drafts", {});
    await ctx.call("PUT", `/api/drafts/${created.id}/brief`, { fields: BRIEF_FIELDS, chiefComplaint: "אי-נוחות" });
    const result = await ctx.call("POST", `/api/drafts/${created.id}/generate`, { mode: "ai" });
    assert.equal(result.status, 400);
    assert.match(result.json.error, /מפתח API/);
    assert.equal(calls.length, 0);
  } finally { await ctx.close(); }
});

// ---------------------------------------------------------------------------------------------
// the whole flow

test("full flow: brief, AI draft, review, check, publish: a fourth case lands in the project files and nothing else is touched", async () => {
  const ctx = await startAdmin();
  try {
    const state = await ctx.call("GET", "/api/state");
    assert.equal(state.json.nextCaseId, "CASE-004");
    assert.equal(state.json.cases.length, 3);

    const id = await createWithDraft(ctx);
    assert.equal(id, "CASE-004");
    assert.ok(fs.existsSync(path.join(ctx.root, "drafts", id, "brief.md")));

    const { json: viewResponse } = await ctx.call("GET", `/api/drafts/${id}/view`);
    assert.equal(viewResponse.stats.filled, viewResponse.stats.total, "every row was filled by the model");
    assert.ok(viewResponse.stats.flagged > 0, "some rows are flagged for review");
    assert.deepEqual(viewResponse.view.map((sheet) => sheet.sheet), ["מטא_מקרה", "אנמנזה", "בדיקה_גופנית", "תוצאות_מספריות", "בדיקות_מיידיות", "בדיקות_המשך", "החלטות_וטיפול", "כללי_משוב"]);

    // blocked until the flagged items are checked
    let check = (await ctx.call("POST", `/api/drafts/${id}/check`, {})).json;
    assert.equal(check.canPublish, false);
    assert.ok(check.blockers.some((line) => /טרם אושרו/.test(line)));
    assert.equal(check.errorCount, 0, "the fake model's content is valid; only the human step is missing");
    assert.ok(check.unreviewed.every((item) => item.label && item.sheetTitle), "flagged items are listed by readable name");
    assert.ok(check.unreviewed.some((item) => item.sheet === "אנמנזה" && !/^AN-\d+$/.test(item.label)), "not by technical id");
    const early = await ctx.call("POST", `/api/drafts/${id}/publish`, { confirm: true });
    assert.equal(early.status, 400);

    for (const item of check.unreviewed) assert.equal((await ctx.call("PATCH", `/api/drafts/${id}/entry`, { sheet: item.sheet, id: item.id, reviewed: true })).status, 200);
    check = (await ctx.call("POST", `/api/drafts/${id}/check`, {})).json;
    assert.deepEqual(check.blockers, [], "reviewed, valid, with a chief complaint");
    assert.equal(check.canPublish, true);

    assert.equal((await ctx.call("POST", `/api/drafts/${id}/publish`, {})).status, 400, "no explicit confirmation");
    const published = await ctx.call("POST", `/api/drafts/${id}/publish`, { confirm: true });
    assert.equal(published.status, 200, JSON.stringify(published.json));
    assert.equal(published.json.entry.id, "CASE-004");
    assert.equal(published.json.entry.demographics, "א׳ ש׳ · גבר · בן 58");
    assert.equal(published.json.entry.chiefComplaint, "אי-נוחות בחזה");
    assert.ok(published.json.nextSteps.some((line) => /npm test/.test(line)));

    const index = JSON.parse(fs.readFileSync(path.join(ctx.root, "data/cases/index.json"), "utf8"));
    assert.deepEqual(index.cases.map((entry) => entry.id), ["CASE-001", "CASE-002", "CASE-003", "CASE-004"]);
    const file = JSON.parse(fs.readFileSync(path.join(ctx.root, "data/cases/case-004.json"), "utf8"));
    assert.deepEqual(validateCase(file, template, { chiefComplaint: "אי-נוחות בחזה" }).errors, []);

    const again = await ctx.call("POST", `/api/drafts/${id}/publish`, { confirm: true });
    assert.equal(again.status, 400, "publishing the same id twice is refused");
    assert.equal((await ctx.call("GET", "/api/state")).json.drafts.find((draft) => draft.id === id).status, "published");
  } finally { await ctx.close(); }
});

test("a chief complaint that names the diagnosis blocks publishing", async () => {
  const ctx = await startAdmin();
  try {
    const id = await createWithDraft(ctx);
    for (const item of (await ctx.call("POST", `/api/drafts/${id}/check`, {})).json.unreviewed) await ctx.call("PATCH", `/api/drafts/${id}/entry`, { sheet: item.sheet, id: item.id, reviewed: true });
    await ctx.call("PUT", `/api/drafts/${id}/brief`, { fields: BRIEF_FIELDS, chiefComplaint: "מחלת בדיקה פיקטיבית" });
    const check = (await ctx.call("POST", `/api/drafts/${id}/check`, {})).json;
    assert.equal(check.canPublish, false);
    assert.ok(check.blockers.some((line) => /שגיאות/.test(line)));
  } finally { await ctx.close(); }
});

test("edits are saved, validated, and do not silently count as a review", async () => {
  const ctx = await startAdmin();
  try {
    const id = await createWithDraft(ctx);
    const view = (await ctx.call("GET", `/api/drafts/${id}/view`)).json.view;
    const flagged = view.flatMap((sheet) => sheet.items.map((item) => ({ ...item, sheet: sheet.sheet }))).find((item) => item.needsReview && item.sheet === "אנמנזה");
    const edit = await ctx.call("PATCH", `/api/drafts/${id}/entry`, { sheet: flagged.sheet, id: flagged.id, column: "תשובת המטופל", value: "תשובה ערוכה על ידי המחבר" });
    assert.equal(edit.status, 200);
    const after = (await ctx.call("GET", `/api/drafts/${id}/view`)).json.view.find((sheet) => sheet.sheet === "אנמנזה").items.find((item) => item.id === flagged.id);
    assert.equal(after.values["תשובת המטופל"], "תשובה ערוכה על ידי המחבר");
    assert.equal(after.reviewed, false, "editing does not tick the review box");
    assert.equal(after.needsReview, true);

    const bad = (body) => ctx.call("PATCH", `/api/drafts/${id}/entry`, { sheet: flagged.sheet, id: flagged.id, ...body });
    assert.equal((await bad({ column: "עמודה שלא קיימת", value: "x" })).status, 400);
    assert.equal((await bad({ column: "חשיבות במקרה", value: "חשיבות מומצאת" })).status, 400);
    assert.equal((await bad({ column: "תשובת המטופל", value: "x".repeat(5000) })).status, 400);
    assert.equal((await bad({ column: "תשובת המטופל", value: 5 })).status, 400);
    assert.equal((await ctx.call("PATCH", `/api/drafts/${id}/entry`, { sheet: "גיליון לא מוכר", id: "x", column: "ערך", value: "x" })).status, 400);
    assert.equal((await ctx.call("PATCH", `/api/drafts/${id}/entry`, { sheet: "אנמנזה", id: "AN-001", column: "סטטוס", value: "מאושר" })).status, 400, "status columns cannot be edited here");
  } finally { await ctx.close(); }
});

test("an empty draft needs no AI: the fixed values are filled, everything else is for the author, and it cannot be published", async () => {
  const ctx = await startAdmin({ complete: async () => { throw new Error("the AI must not be called"); } });
  try {
    const { json: created } = await ctx.call("POST", "/api/drafts", {});
    assert.equal((await ctx.call("POST", `/api/drafts/${created.id}/generate`, { mode: "empty" })).status, 200);
    const { json } = await ctx.call("GET", `/api/drafts/${created.id}/view`);
    assert.equal(json.stats.filled, 0);
    assert.ok(json.stats.total > 200);
    const check = (await ctx.call("POST", `/api/drafts/${created.id}/check`, {})).json;
    assert.equal(check.canPublish, false);
    assert.ok(check.errorCount > 100);
    const typed = await ctx.call("PATCH", `/api/drafts/${created.id}/entry`, { sheet: "אנמנזה", id: "AN-001", column: "תשובת המטופל", value: "בן 58" });
    assert.equal(typed.status, 200, "rows the AI left empty can be created by typing");
    assert.equal((await ctx.call("GET", `/api/drafts/${created.id}/view`)).json.view.find((s) => s.sheet === "אנמנזה").items.find((i) => i.id === "AN-001").values["תשובת המטופל"], "בן 58");
  } finally { await ctx.close(); }
});

test("an existing draft is never overwritten without an explicit request", async () => {
  const ctx = await startAdmin();
  try {
    const id = await createWithDraft(ctx);
    await ctx.call("PATCH", `/api/drafts/${id}/entry`, { sheet: "אנמנזה", id: "AN-001", column: "תשובת המטופל", value: "העריכה שלי" });
    const refused = await ctx.call("POST", `/api/drafts/${id}/generate`, { mode: "ai" });
    assert.equal(refused.status, 409);
    const empty = await ctx.call("POST", `/api/drafts/${id}/generate`, { mode: "empty" });
    assert.equal(empty.status, 409);
    const kept = (await ctx.call("GET", `/api/drafts/${id}/view`)).json.view.find((s) => s.sheet === "אנמנזה").items.find((i) => i.id === "AN-001");
    assert.equal(kept.values["תשובת המטופל"], "העריכה שלי");
  } finally { await ctx.close(); }
});

test("the brief is too short to send to a model is refused before any call", async () => {
  let called = false;
  const ctx = await startAdmin({ complete: async () => { called = true; return "{}"; } });
  try {
    const { json: created } = await ctx.call("POST", "/api/drafts", {});
    await ctx.call("PUT", `/api/drafts/${created.id}/brief`, { fields: { topic: "קצר" }, chiefComplaint: "" });
    const result = await ctx.call("POST", `/api/drafts/${created.id}/generate`, { mode: "ai" });
    assert.equal(result.status, 400);
    assert.equal(called, false);
  } finally { await ctx.close(); }
});

test("a failing AI call is reported on the job with its reason and the draft stays untouched", async () => {
  const ctx = await startAdmin({ complete: async () => { const error = new Error("הספק דחה את המפתח"); error.detail = "Incorrect API key provided"; throw error; } });
  try {
    const { json: created } = await ctx.call("POST", "/api/drafts", {});
    await ctx.call("PUT", `/api/drafts/${created.id}/brief`, { fields: BRIEF_FIELDS, chiefComplaint: "אי-נוחות" });
    const { json: start } = await ctx.call("POST", `/api/drafts/${created.id}/generate`, { mode: "ai" });
    let job;
    for (let i = 0; i < 100; i += 1) { job = (await ctx.call("GET", `/api/jobs/${start.jobId}`)).json; if (job.status !== "running") break; await new Promise((r) => setTimeout(r, 25)); }
    assert.equal(job.status, "error");
    assert.match(job.error, /הספק דחה את המפתח/);
    assert.match(job.error, /Incorrect API key provided/);
    assert.equal((await ctx.call("GET", `/api/drafts/${created.id}/view`)).status, 404, "no half-written draft");
  } finally { await ctx.close(); }
});

// ---------------------------------------------------------------------------------------------
// demo mode

test("demo mode works without a key and produces review items, but can never publish", async () => {
  const ctx = await startAdmin({ demo: true, complete: undefined });
  try {
    assert.equal((await ctx.call("GET", "/api/state")).json.demo, true);
    const id = await createWithDraft(ctx);
    const { json } = await ctx.call("GET", `/api/drafts/${id}/view`);
    assert.ok(json.stats.flagged > 0);
    assert.ok(json.view.find((s) => s.sheet === "אנמנזה").items[0].values["תשובת המטופל"].startsWith("[דוגמה]"));
    for (const item of (await ctx.call("POST", `/api/drafts/${id}/check`, {})).json.unreviewed) await ctx.call("PATCH", `/api/drafts/${id}/entry`, { sheet: item.sheet, id: item.id, reviewed: true });
    const check = (await ctx.call("POST", `/api/drafts/${id}/check`, {})).json;
    assert.equal(check.canPublish, false);
    assert.ok(check.blockers.some((line) => /מצב הדגמה/.test(line)));
    assert.equal((await ctx.call("POST", `/api/drafts/${id}/publish`, { confirm: true })).status, 403);
    assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.root, "data/cases/index.json"), "utf8")).cases.length, 3);
  } finally { await ctx.close(); }
});

// ---------------------------------------------------------------------------------------------
// the same result as the Excel path

test("the interface builds exactly the case that the Excel path produces (fill, approve, convert)", { skip: !python && "Python with openpyxl is not available" }, async () => {
  const fills = await draftCase({ brief: "גבר בן 58 עם כאב בחזה במאמץ", template, caseId: "CASE-004", complete: fakeComplete, now: () => new Date("2026-10-17T00:00:00Z") });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "case-admin-equiv-"));
  fs.writeFileSync(path.join(dir, "fills.json"), JSON.stringify(fills), "utf8");
  runXlsxTool(["fill", path.join(repo, "data/template/clinical-simulation-case-template-v2-he.xlsx"), path.join(dir, "fills.json"), path.join(dir, "draft.xlsx")]);
  runXlsxTool(["approve", path.join(dir, "draft.xlsx"), path.join(dir, "approved.xlsx")]);
  runXlsxTool(["convert", path.join(dir, "approved.xlsx"), path.join(dir, "approved.json")]);
  const viaExcel = JSON.parse(fs.readFileSync(path.join(dir, "approved.json"), "utf8"));
  const direct = applyFillsToTemplate(template, fills, { approved: true });
  for (const sheet of ["מטא_מקרה", "אנמנזה", "בדיקה_גופנית", "בדיקות_מיידיות", "בדיקות_המשך", "החלטות_וטיפול", "כללי_משוב", "תוצאות_מספריות"]) {
    assert.deepEqual(direct.sheets[sheet], viaExcel.sheets[sheet], sheet);
  }
});

test("publishing with Python available also creates the Excel source copy next to the case JSON", { skip: !python && "Python with openpyxl is not available" }, async () => {
  const ctx = await startAdmin({ python: true });
  try {
    const id = await createWithDraft(ctx);
    for (const item of (await ctx.call("POST", `/api/drafts/${id}/check`, {})).json.unreviewed) await ctx.call("PATCH", `/api/drafts/${id}/entry`, { sheet: item.sheet, id: item.id, reviewed: true });
    const published = await ctx.call("POST", `/api/drafts/${id}/publish`, { confirm: true });
    assert.equal(published.status, 200, JSON.stringify(published.json));
    assert.ok(published.json.written.some((line) => /^data\/source\/case-004-patient-database-he\.xlsx$/.test(line)));
    assert.ok(fs.existsSync(path.join(ctx.root, "data/source/case-004-patient-database-he.xlsx")));
    const file = JSON.parse(fs.readFileSync(path.join(ctx.root, "data/cases/case-004.json"), "utf8"));
    assert.equal(file.source, "case-004-patient-database-he.xlsx");
  } finally { await ctx.close(); }
});

// ---------------------------------------------------------------------------------------------
// small pieces

test("the brief is composed from the form fields in a fixed order, skipping empty sections", () => {
  const text = composeBrief({ topic: "אבחנה", patient: "גבר בן 50", goals: "", feedback: "משוב" });
  assert.match(text, /^# תיאור מקרה חדש/);
  assert.ok(text.indexOf("## נושא ואבחנה") < text.indexOf("## המטופל"));
  assert.ok(text.indexOf("## המטופל") < text.indexOf("## נקודות לחשיבה ולמשוב"));
  assert.doesNotMatch(text, /מטרות למידה/);
});

test("a draft can be deleted: only its working folder goes, ids are validated, and a running generation blocks it", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ctx = await startAdmin({ complete: async (request) => { await gate; return fakeComplete(request); } });
  try {
    const { json: first } = await ctx.call("POST", "/api/drafts", {});
    const { json: second } = await ctx.call("POST", "/api/drafts", {});
    assert.notEqual(first.id, second.id);
    assert.ok(fs.existsSync(path.join(ctx.root, "drafts", first.id)));
    assert.equal((await ctx.call("DELETE", `/api/drafts/${first.id}`)).status, 200);
    assert.ok(!fs.existsSync(path.join(ctx.root, "drafts", first.id)), "the folder is gone");
    assert.ok(fs.existsSync(path.join(ctx.root, "drafts", second.id)), "other drafts are untouched");
    assert.equal((await ctx.call("DELETE", `/api/drafts/${first.id}`)).status, 404, "deleting twice");
    assert.equal((await ctx.call("DELETE", "/api/drafts/CASE-1")).status, 400, "malformed id");
    assert.equal((await ctx.call("DELETE", "/api/drafts/..%2F..%2Fdata")).status, 404);
    assert.ok(fs.existsSync(path.join(ctx.root, "data", "cases", "index.json")), "the site data is untouched");
    assert.equal((await ctx.call("GET", "/api/state")).json.cases.length, 3);
    assert.ok(!(await ctx.call("GET", "/api/state")).json.drafts.some((draft) => draft.id === first.id));

    // a generation that is still running cannot be deleted from under itself
    await ctx.call("PUT", `/api/drafts/${second.id}/brief`, { fields: BRIEF_FIELDS, chiefComplaint: "אי-נוחות" });
    const { json: start } = await ctx.call("POST", `/api/drafts/${second.id}/generate`, { mode: "ai" });
    assert.equal((await ctx.call("DELETE", `/api/drafts/${second.id}`)).status, 409);
    release();
    for (let i = 0; i < 200; i += 1) { const { json: job } = await ctx.call("GET", `/api/jobs/${start.jobId}`); if (job.status !== "running") break; await new Promise((r) => setTimeout(r, 25)); }
    assert.equal((await ctx.call("DELETE", `/api/drafts/${second.id}`)).status, 200);
  } finally { release(); await ctx.close(); }
});

test("the interface offers deleting a draft, with a confirmation", () => {
  const app = fs.readFileSync(path.join(repo, "tools/case-admin/public/app.js"), "utf8");
  assert.match(app, /למחוק את הטיוטה/);
  assert.match(app, /"מחק את הטיוטה הזו"/);
  assert.match(app, /window\.confirm\(question\)/);
});
