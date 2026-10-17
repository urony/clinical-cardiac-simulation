// Tests for items a case adds on top of the template (for example a urine culture in a kidney case):
// building and validating them, that the simulation engine reads them, the Excel path, the admin interface
// and the chat document. No network and no real AI.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAdminServer } from "../tools/case-admin/server.mjs";
import { IMPORTANCE, validateCase, table } from "../tools/case-tool/case-validation.mjs";
import { buildChatPackage, importReplies } from "../tools/case-tool/chat-package.mjs";
import { draftCase } from "../tools/case-tool/draft.mjs";
import { findPython, runXlsxTool } from "../tools/case-tool/python.mjs";
import { addExtra, applyEdit, buildView, nextExtraId, removeExtra } from "../tools/case-tool/view.mjs";
import { applyFillsToTemplate, buildExtraRows } from "../tools/case-tool/workbook-json.mjs";
import { loadLib } from "./helpers/load-lib.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const template = JSON.parse(fs.readFileSync(path.join(repo, "data/template/case-template.json"), "utf8"));
const realIndexBefore = fs.readFileSync(path.join(repo, "data/cases/index.json"), "utf8");
const lib = await loadLib();
const python = findPython();
test.after(() => { assert.equal(fs.readFileSync(path.join(repo, "data/cases/index.json"), "utf8"), realIndexBefore, "the real catalogue is never touched"); });

const META = { "ראשי תיבות מטופל": "כ׳ ל׳", "גיל": "47", "מין": "אישה", "אבחנה ידועה למערכת": "מחלת כליה פיקטיבית", "נוסח פתיחה לתלמיד": "כ׳ ל׳, אישה בת 47, פונה בשל נפיחות." };
async function fakeComplete(request) {
  const columns = request.json.schema.properties.items.items.properties.fields.required;
  const listed = JSON.parse(request.user.split("הפריטים (החזר פריט אחד לכל מזהה):\n")[1].split("\n\n")[0]);
  return JSON.stringify({ items: listed.map((item) => ({ id: item.id, needsReview: false, note: "", fields: Object.fromEntries(columns.map((column) => [column, column === "חשיבות במקרה" ? IMPORTANCE[1] : column === "ערך" && META[item.id] ? META[item.id] : `${column} של ${item.id}`])) })) });
}
const baseFills = () => draftCase({ brief: "אישה בת 47 עם בעיה בכליה", template, caseId: "CASE-004", complete: fakeComplete, now: () => new Date("2026-10-17T00:00:00Z") });

function fill(fills, sheet, id, values) { for (const [column, value] of Object.entries(values)) applyEdit(fills, { sheet, id, column, value }); }

/** A kidney-style case: one extra of every kind, including a test with numeric results. */
async function kidneyFills() {
  const fills = await baseFills();
  const an = addExtra(fills, { sheet: "אנמנזה", label: "כאב בצד או במותן" });
  fill(fills, "אנמנזה", an, { "תשובת המטופל": "כן, כאב עמום בצד ימין.", "חשיבות במקרה": "חשוב", "היגיון למשוב": "מכוון לאבן או לזיהום." });
  const pe = addExtra(fills, { sheet: "בדיקה_גופנית", label: "רגישות בבית הכליה" });
  fill(fills, "בדיקה_גופנית", pe, { "ממצא במקרה": "רגישות קלה בצד ימין.", "חשיבות במקרה": "חיוני במקרה", "היגיון למשוב": "תומכת בבעיה בכליה." });
  const it = addExtra(fills, { sheet: "בדיקות_מיידיות", label: "תרבית שתן" });
  fill(fills, "בדיקות_מיידיות", it, { "פרשנות במקרה": "גדילה של חיידק.", "חשיבות במקרה": "חיוני במקרה", "היגיון למשוב": "מאשרת זיהום." });
  const n1 = addExtra(fills, { sheet: "תוצאות_מספריות", label: "ספירת מושבות", testId: it, unit: "CFU/mL" });
  fill(fills, "תוצאות_מספריות", n1, { "ערך": "120000", "טווח ייחוס": "פחות מ-10000", "פרשנות במקרה": "מעל הסף." });
  const ft = addExtra(fills, { sheet: "בדיקות_המשך", label: "ביופסיית כליה" });
  fill(fills, "בדיקות_המשך", ft, { "תוצאה קבועה": "דלקת בין-תאית קלה.", "השפעה על החשיבה": "מכוונת לטיפול.", "חשיבות במקרה": "חשוב", "היגיון למשוב": "מידתית רק במצב מסוים." });
  return { fills, ids: { an, pe, it, n1, ft } };
}

// ---- model --------------------------------------------------------------------------------------------

test("extra ids are sequential per kind and numeric results are numbered per test", async () => {
  const { fills, ids } = await kidneyFills();
  assert.deepEqual(ids, { an: "X-AN-001", pe: "X-PE-001", it: "X-IT-001", n1: "X-IT-001-N1", ft: "X-FT-001" });
  assert.equal(addExtra(fills, { sheet: "אנמנזה", label: "שאלה נוספת" }), "X-AN-002");
  assert.equal(addExtra(fills, { sheet: "תוצאות_מספריות", label: "מדד נוסף", testId: ids.it, unit: "mg" }), "X-IT-001-N2");
  removeExtra(fills, { sheet: "אנמנזה", id: "X-AN-001" });
  assert.equal(nextExtraId(fills, "אנמנזה"), "X-AN-003", "a removed id is not reused while a later one exists");
});

test("adding an extra item is checked: kind, name, duplicates, and numeric results need an extra test", async () => {
  const fills = await baseFills();
  assert.throws(() => addExtra(fills, { sheet: "כללי_משוב", label: "x" }), /אי אפשר להוסיף/);
  assert.throws(() => addExtra(fills, { sheet: "אנמנזה", label: "   " }), /שם הפריט/);
  assert.throws(() => addExtra(fills, { sheet: "אנמנזה", label: "ארוך".repeat(60) }), /שם הפריט/);
  assert.throws(() => addExtra(fills, { sheet: "אנמנזה", label: "שורה\nשנייה" }), /שם הפריט/);
  addExtra(fills, { sheet: "אנמנזה", label: "כפול" });
  assert.throws(() => addExtra(fills, { sheet: "אנמנזה", label: "כפול" }), /כבר קיים/);
  assert.throws(() => addExtra(fills, { sheet: "תוצאות_מספריות", label: "מדד", testId: "IT-031", unit: "mg" }), /בדיקה נוספת/, "a template test cannot get extra numeric rows");
  assert.throws(() => addExtra(fills, { sheet: "תוצאות_מספריות", label: "מדד", testId: "X-IT-009" }), /בדיקה נוספת/);
});

test("only extra items can be removed, and removing a test removes its numeric results", async () => {
  const { fills, ids } = await kidneyFills();
  assert.throws(() => removeExtra(fills, { sheet: "אנמנזה", id: "AN-001" }), /רק פריט שנוסף/);
  removeExtra(fills, { sheet: "בדיקות_מיידיות", id: ids.it });
  assert.equal(fills.sheets["תוצאות_מספריות"][ids.n1], undefined);
  assert.equal(fills.sheets["בדיקות_מיידיות"][ids.it], undefined);
});

test("editing needs a known item: an id that is neither in the template nor an extra is refused", async () => {
  const fills = await baseFills();
  assert.throws(() => applyEdit(fills, { sheet: "אנמנזה", id: "ZZ-999", column: "תשובת המטופל", value: "x" }, { template }), /פריט לא מוכר/);
  assert.doesNotThrow(() => applyEdit(fills, { sheet: "אנמנזה", id: "AN-001", column: "תשובת המטופל", value: "x" }, { template }));
});

test("extras appear in the review view after the template's items, with their own columns", async () => {
  const { fills, ids } = await kidneyFills();
  const view = buildView(template, fills);
  const anamnesis = view.find((sheet) => sheet.sheet === "אנמנזה");
  const extra = anamnesis.items.at(-1);
  assert.equal(extra.id, ids.an);
  assert.equal(extra.extra, true);
  assert.equal(extra.label, "כאב בצד או במותן");
  assert.equal(extra.filled, true);
  assert.ok(anamnesis.extrasAllowed);
  const tests = view.find((sheet) => sheet.sheet === "בדיקות_מיידיות").items.at(-1);
  assert.ok(!tests.columns.includes("תוצאה להצגה"), "a test with numeric results shows no separate displayed result");
  const numeric = view.find((sheet) => sheet.sheet === "תוצאות_מספריות");
  assert.deepEqual(numeric.testOptions, [{ id: ids.it, label: "תרבית שתן" }]);
  assert.equal(numeric.items.at(-1).unit, "CFU/mL");
  assert.equal(view.find((sheet) => sheet.sheet === "כללי_משוב").extrasAllowed, false);
});

// ---- case file and validation ----------------------------------------------------------------------------

test("a case with extras is built, appended below the template rows, approved, and passes validation", async () => {
  const { fills, ids } = await kidneyFills();
  const file = applyFillsToTemplate(template, fills, { approved: true });
  assert.deepEqual(validateCase(file, template, { chiefComplaint: "נפיחות" }).errors, []);
  const anamnesis = table(file, "אנמנזה");
  assert.equal(anamnesis.length, 90, "89 template rows plus one extra");
  const row = anamnesis.at(-1);
  assert.equal(row["מזהה רכיב בסיס"], ids.an);
  assert.equal(row["מזהה ערך בתיק"], `CASE-004-${ids.an}`);
  assert.equal(row["סטטוס"], "מאושר");
  assert.equal(row["הערות הפעלה"], table(template, "אנמנזה")[0]["הערות הפעלה"], "operating notes copied from the template");
  const test = table(file, "בדיקות_מיידיות").at(-1);
  assert.equal(test["תוצאה להצגה"], "נוצר אוטומטית מתוצאות_מספריות.");
  const metric = table(file, "תוצאות_מספריות").at(-1);
  assert.deepEqual([metric["מזהה מדד"], metric["מזהה בדיקה"], metric["שם המדד"], metric["ערך"], metric["יחידה"], metric["חובת הצגה"]], ["X-IT-001-N1", "X-IT-001", "ספירת מושבות", "120000", "CFU/mL", "כן"]);
  assert.equal(table(file, "בדיקות_המשך").at(-1)["זמינות"], "לא מיידי");
  assert.equal(buildExtraRows(template, fills)["אנמנזה"].length, 1);
});

test("validation catches mistakes in extras: bad id, empty field, bad importance, orphan result, test without a result", async () => {
  const check = async (change) => { const { fills, ids } = await kidneyFills(); change(fills, ids); return validateCase(applyFillsToTemplate(template, fills, { approved: true }), template).errors; };
  assert.ok((await check((f, ids) => { f.sheets["אנמנזה"]["X-AN-1"] = f.sheets["אנמנזה"][ids.an]; delete f.sheets["אנמנזה"][ids.an]; })).some((e) => /מזהה בסיס שאינו בתבנית/.test(e)), "malformed extra id");
  assert.ok((await check((f, ids) => { f.sheets["אנמנזה"][ids.an].fields["תשובת המטופל"] = ""; })).some((e) => /תשובת המטופל.*ריק/.test(e)), "empty field");
  assert.ok((await check((f, ids) => { f.sheets["אנמנזה"][ids.an].fields["חשיבות במקרה"] = "חשיבות מומצאת"; })).some((e) => /חשיבות לא תקינה/.test(e)), "bad importance");
  assert.ok((await check((f, ids) => { f.sheets["תוצאות_מספריות"][ids.n1].testId = "X-IT-099"; })).some((e) => /אינו בגיליון הבדיקות המיידיות/.test(e)), "orphan numeric result");
  assert.ok((await check((f, ids) => { f.sheets["תוצאות_מספריות"][ids.n1].fields["ערך"] = ""; })).some((e) => /ערך ריק/.test(e)), "empty numeric value");
  const missing = await check((f, ids) => { delete f.sheets["תוצאות_מספריות"][ids.n1]; });
  assert.ok(missing.some((e) => /לבדיקה נוספת ללא תוצאות מספריות חייבת להיות "תוצאה להצגה"/.test(e)), "an extra test needs a displayed result when it has no numeric results");
});

test("an extra test without numeric results is valid with a displayed result", async () => {
  const fills = await baseFills();
  const id = addExtra(fills, { sheet: "בדיקות_מיידיות", label: "אולטרסאונד כליות" });
  fill(fills, "בדיקות_מיידיות", id, { "תוצאה להצגה": "כליות בגודל תקין, ללא הידרונפרוזיס.", "פרשנות במקרה": "תקין.", "חשיבות במקרה": "משלים", "היגיון למשוב": "שולל חסימה." });
  assert.deepEqual(validateCase(applyFillsToTemplate(template, fills, { approved: true }), template).errors, []);
  assert.equal(table(applyFillsToTemplate(template, fills, { approved: true }), "בדיקות_מיידיות").at(-1)["תוצאה להצגה"], "כליות בגודל תקין, ללא הידרונפרוזיס.");
});

test("cases without extras are unchanged: no rows are added", async () => {
  const fills = await baseFills();
  const file = applyFillsToTemplate(template, fills, { approved: true });
  assert.deepEqual(buildExtraRows(template, fills), {});
  assert.equal(table(file, "אנמנזה").length, 89);
  assert.equal(table(file, "תוצאות_מספריות").length, 32);
});

// ---- the simulation engine -----------------------------------------------------------------------------------

test("the simulation engine reads the extras like any other item: names, answers, and numeric results", async () => {
  const { fills, ids } = await kidneyFills();
  const file = applyFillsToTemplate(template, fills, { approved: true });
  const { phaseItems } = lib.caseData;
  const pick = (phase, id) => phaseItems(file, phase).find((item) => item.id === id);
  assert.equal(pick("anamnesis", ids.an).label, "כאב בצד או במותן");
  assert.equal(pick("anamnesis", ids.an).answer, "כן, כאב עמום בצד ימין.");
  assert.equal(pick("examination", ids.pe).answer, "רגישות קלה בצד ימין.");
  assert.equal(pick("followupTests", ids.ft).label, "ביופסיית כליה");
  assert.equal(pick("followupTests", ids.ft).answer, "דלקת בין-תאית קלה.");
  const test = pick("immediateTests", ids.it);
  assert.equal(test.label, "תרבית שתן");
  assert.match(test.answer, /ספירת מושבות: 120000 CFU\/mL/);
  assert.match(test.answer, /טווח ייחוס: פחות מ-10000/);
  assert.equal(phaseItems(file, "anamnesis").length, 90);
  assert.equal(phaseItems(file, "immediateTests").length, 34);
});

test("extras reach the model's fact catalogue, so a student can ask about them", async () => {
  const { fills, ids } = await kidneyFills();
  const file = applyFillsToTemplate(template, fills, { approved: true });
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => { const body = JSON.parse(init.body); calls.push(body); return new Response(JSON.stringify({ output_text: body.text ? JSON.stringify({ matched_ids: [ids.an], ambiguous: false }) : "כן, יש לי כאב בצד." }), { status: 200 }); };
  try {
    const entry = { id: "CASE-004", maxAnamnesisFacts: undefined };
    const result = await lib.simulation.runSimulationStep({ config: { providerId: "openai", apiKey: "fake-key-1234567890", retryDelayMs: 0 }, entry, caseFile: file }, { phase: "anamnesis", question: "יש לך כאב בצד?" });
    assert.deepEqual(result.matchedIds, [ids.an]);
    assert.ok(calls[0].input[0].content[0].text.includes("כאב בצד או במותן"), "the extra question is in the catalogue the model chooses from");
    assert.ok(calls[1].input[0].content[0].text.includes("כן, כאב עמום בצד ימין."), "and its approved answer is the only fact given for the reply");
  } finally { globalThis.fetch = realFetch; }
});

// ---- the Excel path gives the same case ----------------------------------------------------------------------------

test("the Excel path appends the same extra rows as the JSON path", { skip: !python && "Python with openpyxl is not available" }, async () => {
  const { fills } = await kidneyFills();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "extras-equiv-"));
  fs.writeFileSync(path.join(dir, "fills.json"), JSON.stringify({ ...fills, extraRows: buildExtraRows(template, fills) }), "utf8");
  runXlsxTool(["fill", path.join(repo, "data/template/clinical-simulation-case-template-v2-he.xlsx"), path.join(dir, "fills.json"), path.join(dir, "draft.xlsx")]);
  runXlsxTool(["approve", path.join(dir, "draft.xlsx"), path.join(dir, "approved.xlsx")]);
  runXlsxTool(["convert", path.join(dir, "approved.xlsx"), path.join(dir, "approved.json")]);
  const viaExcel = JSON.parse(fs.readFileSync(path.join(dir, "approved.json"), "utf8"));
  const direct = applyFillsToTemplate(template, fills, { approved: true });
  for (const sheet of ["מטא_מקרה", "אנמנזה", "בדיקה_גופנית", "בדיקות_מיידיות", "בדיקות_המשך", "החלטות_וטיפול", "כללי_משוב", "תוצאות_מספריות"]) assert.deepEqual(direct.sheets[sheet], viaExcel.sheets[sheet], sheet);
  assert.deepEqual(validateCase(viaExcel, template).errors, []);
});

// ---- admin interface ---------------------------------------------------------------------------------------------------

function scratchRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extras-root-"));
  for (const dir of ["data/template", "data/cases", "data/source"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const name of ["case-template.json", "clinical-simulation-case-template-v2-he.xlsx"]) fs.copyFileSync(path.join(repo, "data/template", name), path.join(root, "data/template", name));
  const realIndex = JSON.parse(fs.readFileSync(path.join(repo, "data/cases/index.json"), "utf8"));
  fs.writeFileSync(path.join(root, "data/cases/index.json"), JSON.stringify({ ...realIndex, cases: realIndex.cases.filter((entry) => ["CASE-001", "CASE-002", "CASE-003"].includes(entry.id)) }), "utf8");
  return root;
}
async function startAdmin(options = {}) {
  const root = scratchRoot();
  const admin = createAdminServer({ root, providers: () => [{ id: "gemini", label: "Gemini" }], python: false, env: {}, complete: fakeComplete, ...options });
  const port = await admin.listen(0);
  const call = async (method, url, body) => { const response = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { "content-type": "application/json", "x-admin-token": admin.token }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, json: await response.json().catch(() => ({})) }; };
  return { admin, root, call, close: () => admin.close() };
}
async function draftWithModel(ctx) {
  const { json: created } = await ctx.call("POST", "/api/drafts", {});
  await ctx.call("PUT", `/api/drafts/${created.id}/brief`, { fields: { topic: "אבחנה פיקטיבית של כליה, תלמידי י״ב, מטרות: זיהוי", patient: "אישה בת 47" }, chiefComplaint: "נפיחות ברגליים" });
  const { json: start } = await ctx.call("POST", `/api/drafts/${created.id}/generate`, { mode: "ai" });
  for (let i = 0; i < 200; i += 1) { const { json: job } = await ctx.call("GET", `/api/jobs/${start.jobId}`); if (job.status !== "running") break; await new Promise((r) => setTimeout(r, 25)); }
  return created.id;
}

test("through the admin API: add extras, fill them, delete one, and see them in the view", async () => {
  const ctx = await startAdmin();
  try {
    const id = await draftWithModel(ctx);
    const add = (body) => ctx.call("POST", `/api/drafts/${id}/extra`, body);
    const first = await add({ sheet: "בדיקות_מיידיות", label: "תרבית שתן" });
    assert.equal(first.status, 200);
    assert.equal(first.json.id, "X-IT-001");
    assert.equal((await add({ sheet: "בדיקות_מיידיות", label: "תרבית שתן" })).status, 400, "duplicate name");
    assert.equal((await add({ sheet: "כללי_משוב", label: "x" })).status, 400);
    assert.equal((await add({ sheet: "תוצאות_מספריות", label: "מדד", testId: "IT-031" })).status, 400, "numeric results only for an extra test");
    const numeric = await add({ sheet: "תוצאות_מספריות", label: "ספירת מושבות", testId: "X-IT-001", unit: "CFU/mL" });
    assert.equal(numeric.json.id, "X-IT-001-N1");
    const edit = (sheet, itemId, column, value) => ctx.call("PATCH", `/api/drafts/${id}/entry`, { sheet, id: itemId, column, value });
    assert.equal((await edit("תוצאות_מספריות", "X-IT-001-N1", "ערך", "120000")).status, 200);
    assert.equal((await edit("אנמנזה", "ZZ-999", "תשובת המטופל", "x")).status, 400, "unknown ids cannot be created by editing");
    const view = (await ctx.call("GET", `/api/drafts/${id}/view`)).json.view;
    const item = view.find((sheet) => sheet.sheet === "בדיקות_מיידיות").items.at(-1);
    assert.deepEqual([item.id, item.label, item.extra], ["X-IT-001", "תרבית שתן", true]);
    assert.equal((await ctx.call("DELETE", `/api/drafts/${id}/extra`, { sheet: "אנמנזה", id: "AN-001" })).status, 400, "template items cannot be deleted");
    assert.equal((await ctx.call("DELETE", `/api/drafts/${id}/extra`, { sheet: "בדיקות_מיידיות", id: "X-IT-001" })).status, 200);
    const after = (await ctx.call("GET", `/api/drafts/${id}/view`)).json.view;
    assert.equal(after.find((sheet) => sheet.sheet === "תוצאות_מספריות").items.some((entry) => entry.extra), false, "its numeric result went with it");
  } finally { await ctx.close(); }
});

test("through the admin interface: a case with extras is checked, published, and lands complete in the project files", async () => {
  const ctx = await startAdmin();
  try {
    const id = await draftWithModel(ctx);
    const add = async (body) => (await ctx.call("POST", `/api/drafts/${id}/extra`, body)).json.id;
    const set = async (sheet, itemId, values) => { for (const [column, value] of Object.entries(values)) assert.equal((await ctx.call("PATCH", `/api/drafts/${id}/entry`, { sheet, id: itemId, column, value })).status, 200); };
    const an = await add({ sheet: "אנמנזה", label: "כאב בצד או במותן" });
    await set("אנמנזה", an, { "תשובת המטופל": "כן, כאב עמום בצד ימין.", "חשיבות במקרה": "חשוב", "היגיון למשוב": "מכוון לאבן." });
    const it = await add({ sheet: "בדיקות_מיידיות", label: "אולטרסאונד כליות" });
    await set("בדיקות_מיידיות", it, { "תוצאה להצגה": "תקין.", "פרשנות במקרה": "תקין.", "חשיבות במקרה": "משלים", "היגיון למשוב": "שולל חסימה." });
    let check = (await ctx.call("POST", `/api/drafts/${id}/check`, {})).json;
    assert.equal(check.errorCount, 0, check.errors.join("; "));
    const incomplete = await add({ sheet: "בדיקה_גופנית", label: "פריט שלא מולא" });
    check = (await ctx.call("POST", `/api/drafts/${id}/check`, {})).json;
    assert.ok(check.errors.some((line) => /X-PE-001/.test(line)), "an unfilled extra blocks publishing");
    await ctx.call("DELETE", `/api/drafts/${id}/extra`, { sheet: "בדיקה_גופנית", id: incomplete });
    check = (await ctx.call("POST", `/api/drafts/${id}/check`, {})).json;
    for (const item of check.unreviewed) await ctx.call("PATCH", `/api/drafts/${id}/entry`, { sheet: item.sheet, id: item.id, reviewed: true });
    const published = await ctx.call("POST", `/api/drafts/${id}/publish`, { confirm: true });
    assert.equal(published.status, 200, JSON.stringify(published.json));
    const file = JSON.parse(fs.readFileSync(path.join(ctx.root, "data/cases/case-004.json"), "utf8"));
    assert.equal(lib.caseData.phaseItems(file, "anamnesis").find((item) => item.id === an).label, "כאב בצד או במותן");
    assert.ok(lib.caseData.phaseItems(file, "immediateTests").some((item) => item.id === it));
  } finally { await ctx.close(); }
});

test("through the admin interface with Excel: the Excel source copy carries the extra rows too", { skip: !python && "Python with openpyxl is not available" }, async () => {
  const ctx = await startAdmin({ python: true });
  try {
    const id = await draftWithModel(ctx);
    const itemId = (await ctx.call("POST", `/api/drafts/${id}/extra`, { sheet: "אנמנזה", label: "כאב בצד או במותן" })).json.id;
    for (const [column, value] of Object.entries({ "תשובת המטופל": "כן.", "חשיבות במקרה": "חשוב", "היגיון למשוב": "מכוון." })) await ctx.call("PATCH", `/api/drafts/${id}/entry`, { sheet: "אנמנזה", id: itemId, column, value });
    for (const item of (await ctx.call("POST", `/api/drafts/${id}/check`, {})).json.unreviewed) await ctx.call("PATCH", `/api/drafts/${id}/entry`, { sheet: item.sheet, id: item.id, reviewed: true });
    const published = await ctx.call("POST", `/api/drafts/${id}/publish`, { confirm: true });
    assert.equal(published.status, 200, JSON.stringify(published.json));
    const out = path.join(os.tmpdir(), `extras-source-${Date.now()}.json`);
    runXlsxTool(["convert", path.join(ctx.root, "data/source/case-004-patient-database-he.xlsx"), out]);
    const fromExcel = JSON.parse(fs.readFileSync(out, "utf8"));
    const fromJson = JSON.parse(fs.readFileSync(path.join(ctx.root, "data/cases/case-004.json"), "utf8"));
    assert.deepEqual(fromExcel.sheets["אנמנזה"], fromJson.sheets["אנמנזה"]);
  } finally { await ctx.close(); }
});

// ---- chat document ----------------------------------------------------------------------------------------------------------

test("the chat document ends with a group that asks for additional items, with the format and an example", () => {
  const document = buildChatPackage({ template, brief: "", caseId: "CASE-004" });
  const headings = document.match(/^### קבוצה (\d+) מתוך (\d+):/gm);
  assert.equal(headings.length, 16);
  assert.match(headings.at(-1), /קבוצה 16 מתוך 16/);
  const last = document.slice(document.lastIndexOf("### קבוצה 16"));
  for (const phrase of ["פריטים נוספים שהמקרה הזה דורש", "תרבית שתן", "\"extras\"", "תוצאות_מספריות", "`test`", "עד 12 פריטים"]) assert.ok(last.includes(phrase), phrase);
  assert.match(document, /16 קבוצות/);
});

const extrasReply = (extras) => "הנה הפריטים הנוספים:\n\n```json\n" + JSON.stringify({ extras }) + "\n```";
const urineTest = { sheet: "בדיקות_מיידיות", label: "תרבית שתן", fields: { "פרשנות במקרה": "גדילה.", "חשיבות במקרה": "חשוב", "היגיון למשוב": "מאשרת זיהום." }, needsReview: true, note: "הומצא" };
const colonies = { sheet: "תוצאות_מספריות", test: "תרבית שתן", label: "ספירת מושבות", unit: "CFU/mL", fields: { "ערך": "120000", "טווח ייחוס": "פחות מ-10000", "פרשנות במקרה": "גבוה." }, needsReview: false, note: "" };

test("pasted extra items are created, a test is linked to its numeric results by name, and everything is flagged as from the chat", () => {
  const result = importReplies({ template, fills: null, raw: extrasReply([colonies, urineTest, { sheet: "אנמנזה", label: "כאב מותן", fields: { "תשובת המטופל": "כן.", "חשיבות במקרה": "חשוב", "היגיון למשוב": "אבן." }, needsReview: false, note: "" }]), caseId: "CASE-004" });
  assert.equal(result.rejected.length, 0, JSON.stringify(result.rejected));
  assert.deepEqual([...result.accepted].sort(), ["X-AN-001", "X-IT-001", "X-IT-001-N1"], "the numeric result was handled after its test even though it came first");
  const entries = result.fills.sheets;
  assert.equal(entries["תוצאות_מספריות"]["X-IT-001-N1"].testId, "X-IT-001");
  assert.equal(entries["תוצאות_מספריות"]["X-IT-001-N1"].unit, "CFU/mL");
  assert.equal(entries["בדיקות_מיידיות"]["X-IT-001"].needsReview, true);
  assert.equal(entries["בדיקות_מיידיות"]["X-IT-001"].source, "chat");
  assert.equal(entries["אנמנזה"]["X-AN-001"].extra, true);
});

test("pasting the same extras again updates them instead of duplicating, and hand edits are kept", () => {
  const first = importReplies({ template, fills: null, raw: extrasReply([urineTest, colonies]), caseId: "CASE-004" });
  const second = importReplies({ template, fills: first.fills, raw: extrasReply([urineTest, colonies]), caseId: "CASE-004" });
  assert.equal(Object.keys(second.fills.sheets["בדיקות_מיידיות"]).filter((id) => id.startsWith("X-")).length, 1);
  assert.equal(Object.keys(second.fills.sheets["תוצאות_מספריות"]).filter((id) => id.startsWith("X-")).length, 1);
  second.fills.sheets["בדיקות_מיידיות"]["X-IT-001"].fields["פרשנות במקרה"] = "העריכה שלי";
  second.fills.sheets["בדיקות_מיידיות"]["X-IT-001"].edited = true;
  const third = importReplies({ template, fills: second.fills, raw: extrasReply([urineTest]), caseId: "CASE-004" });
  assert.deepEqual(third.keptEdited.map((item) => item.id), ["X-IT-001"]);
  assert.equal(third.fills.sheets["בדיקות_מיידיות"]["X-IT-001"].fields["פרשנות במקרה"], "העריכה שלי");
});

test("bad extras are rejected with a reason: unknown sheet, missing name, empty field, bad importance, template text, unknown test", () => {
  const bad = [
    { ...urineTest, sheet: "כללי_משוב" }, { ...urineTest, label: "" },
    { ...urineTest, label: "א", fields: { ...urineTest.fields, "פרשנות במקרה": "" } },
    { ...urineTest, label: "ב", fields: { ...urineTest.fields, "חשיבות במקרה": "מומצאת" } },
    { ...urineTest, label: "ג", fields: { ...urineTest.fields, "היגיון למשוב": "[למילוי: מדוע]" } },
    { ...colonies, test: "בדיקה שלא קיימת" },
  ];
  const result = importReplies({ template, fills: null, raw: extrasReply([...bad, urineTest]), caseId: "CASE-004" });
  assert.equal(result.accepted.length, 1, "the good one in the same paste is still accepted");
  assert.equal(result.rejected.length, 6);
  assert.ok(result.rejected.every((item) => item.reason));
  assert.match(result.rejected.map((item) => item.reason).join("|"), /בדיקה נוספת/);
  assert.match(result.rejected.map((item) => item.reason).join("|"), /חשיבות לא תקינה/);
});

test("a reply with only extras is accepted, an empty extras list is a clear no-op, and plain text is still an error", () => {
  assert.equal(importReplies({ template, fills: null, raw: extrasReply([urineTest]), caseId: "CASE-004" }).accepted.length, 1);
  assert.throws(() => importReplies({ template, fills: null, raw: extrasReply([]), caseId: "CASE-004" }), /לא נמצא בטקסט שהודבק JSON/);
  assert.throws(() => importReplies({ template, fills: null, raw: "שלום", caseId: "CASE-004" }), /לא נמצא בטקסט שהודבק JSON/);
});

// ---- the page ------------------------------------------------------------------------------------------------------------------

test("the review page lets the author add and delete extra items", () => {
  const app = fs.readFileSync(path.join(repo, "tools/case-admin/public/app.js"), "utf8");
  for (const phrase of ["+ הוסף פריט שאין ברשימה", "+ הוסף תוצאה מספרית לבדיקה נוספת", "מחק פריט", "פריט נוסף של המקרה", "extrasAllowed"]) assert.ok(app.includes(phrase), phrase);
});
