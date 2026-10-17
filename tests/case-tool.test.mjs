// Tests for the local case-creation tool: validation, AI drafting (fake model), Excel round trip,
// and publishing. No network and no real key are used.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { IMPORTANCE, validateCase } from "../tools/case-tool/case-validation.mjs";
import { SHEETS, draftCase, pendingItems, planDraft } from "../tools/case-tool/draft.mjs";
import { applyPublish, demographicsOf, nextCaseId, planPublish } from "../tools/case-tool/publish.mjs";
import { findPython, runXlsxTool } from "../tools/case-tool/python.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
const template = read("data/template/case-template.json");
const catalogue = read("data/cases/index.json");
const approvedCase = (n) => read(`data/cases/case-${n}.json`);
const clone = (value) => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------------------------------------
// validation

test("the three approved cases pass validation with no errors", () => {
  for (const n of ["001", "002", "003"]) {
    const { errors } = validateCase(approvedCase(n), template);
    assert.deepEqual(errors, [], `CASE-${n}`);
  }
});

test("the blank template is rejected (placeholders, draft statuses, empty fields)", () => {
  const { errors } = validateCase(template, template);
  assert.ok(errors.length > 500);
  assert.ok(errors.some((line) => /הוראת תבנית/.test(line)));
  assert.ok(errors.some((line) => /טיוטה/.test(line)));
});

function mutated(change) {
  const file = clone(approvedCase("001"));
  change(file);
  return validateCase(file, template).errors;
}
const cellOf = (file, sheet, matchColumn, matchValue, column) => {
  const rows = file.sheets[sheet];
  const headerIndex = rows.findIndex((row) => row.some((cell) => String(cell ?? "").includes(sheet === "מטא_מקרה" ? "ערך" : "מזהה")));
  const header = rows[headerIndex];
  const row = rows.slice(headerIndex + 1).find((r) => r[header.indexOf(matchColumn)] === matchValue);
  return { row, index: header.indexOf(column) };
};

test("validation catches the typical mistakes an author can make", () => {
  assert.ok(mutated((f) => { const c = cellOf(f, "אנמנזה", "מזהה רכיב בסיס", "AN-001", "תשובת המטופל"); c.row[c.index] = ""; }).some((e) => /AN-001.*תשובת המטופל.*ריק/.test(e)), "empty answer");
  assert.ok(mutated((f) => { const c = cellOf(f, "אנמנזה", "מזהה רכיב בסיס", "AN-002", "סטטוס"); c.row[c.index] = "טיוטה"; }).some((e) => /AN-002.*סטטוס/.test(e)), "draft status");
  assert.ok(mutated((f) => { const c = cellOf(f, "בדיקה_גופנית", "מזהה רכיב בסיס", "PE-001", "חשיבות במקרה"); c.row[c.index] = "חשיבות מומצאת"; }).some((e) => /PE-001.*חשיבות/.test(e)), "invalid importance");
  assert.ok(mutated((f) => { const c = cellOf(f, "אנמנזה", "מזהה רכיב בסיס", "AN-003", "היגיון למשוב"); c.row[c.index] = "[למילוי: מדוע]"; }).some((e) => /הוראת תבנית/.test(e)), "leftover placeholder");
  assert.ok(mutated((f) => { f.sheets["אנמנזה"].splice(f.sheets["אנמנזה"].findIndex((r) => r.includes("AN-004")), 1); }).some((e) => /חסר מזהה AN-004/.test(e)), "missing id");
  assert.ok(mutated((f) => { const rows = f.sheets["אנמנזה"]; rows.push(clone(rows[rows.findIndex((r) => r.includes("AN-005"))])); }).some((e) => /AN-005.*פעמים/.test(e)), "duplicate id");
  assert.ok(mutated((f) => { const c = cellOf(f, "אנמנזה", "מזהה רכיב בסיס", "AN-006", "מזהה ערך בתיק"); c.row[c.index] = "CASE-999-AN-006"; }).some((e) => /AN-006.*מזהה הערך/.test(e)), "wrong case prefix");
  assert.ok(mutated((f) => { const c = cellOf(f, "מטא_מקרה", "שדה", "מין", "ערך"); c.row[c.index] = "לא ידוע"; }).some((e) => /מין/.test(e)), "invalid sex");
  assert.ok(mutated((f) => { const c = cellOf(f, "מטא_מקרה", "שדה", "נוסח פתיחה לתלמיד", "ערך"); c.row[c.index] = "פונה עם תעוקת חזה יציבה"; }).some((e) => /חושף את האבחנה/.test(e)), "opening reveals diagnosis");
  assert.ok(mutated((f) => { const c = cellOf(f, "תוצאות_מספריות", "מזהה מדד", "IT-004-SPO2", "ערך"); c.row[c.index] = null; }).some((e) => /IT-004-SPO2.*ערך ריק/.test(e)), "missing numeric value");
});

test("a chief complaint that names the diagnosis is rejected", () => {
  const { errors } = validateCase(approvedCase("001"), template, { chiefComplaint: "תעוקת חזה יציבה" });
  assert.ok(errors.some((e) => /התלונה המרכזית חושפת/.test(e)));
});

// ---------------------------------------------------------------------------------------------
// drafting with a fake model

const META_VALUES = { "ראשי תיבות מטופל": "א׳ ש׳", "גיל": "58", "מין": "גבר", "אבחנה ידועה למערכת": "מחלת בדיקה פיקטיבית", "נוסח פתיחה לתלמיד": "א׳ ש׳, גבר בן 58, פונה בשל אי-נוחות בחזה." };

/** A fake model that answers every requested item with valid, deterministic content. */
function fakeModel({ onCall, misbehave } = {}) {
  const calls = [];
  const complete = async (request) => {
    calls.push(request);
    onCall?.(request);
    const columns = request.json.schema.properties.items.items.properties.fields.required;
    const listed = JSON.parse(request.user.split("הפריטים (החזר פריט אחד לכל מזהה):\n")[1].split("\n\n")[0]);
    const items = listed.map((item) => ({
      id: item.id,
      fields: Object.fromEntries(columns.map((column) => [column, column === "חשיבות במקרה" ? IMPORTANCE[1] : (META_VALUES[item.id] && column === "ערך") ? META_VALUES[item.id] : `${column} של ${item.id}`])),
      needsReview: item.id.endsWith("-007"), note: item.id.endsWith("-007") ? "הומצא על ידי המודל" : "",
    }));
    return JSON.stringify({ items: misbehave ? misbehave(items, calls.length) : items });
  };
  return { complete, calls };
}

const BRIEF = "גבר בן 58 עם כאב בחזה במאמץ.";

test("the plan lists the sheets and counts model calls before any call is made", () => {
  const plan = planDraft(template);
  assert.equal(plan.steps.length, SHEETS.length);
  assert.ok(plan.calls >= 8 && plan.calls <= 20, `calls=${plan.calls}`);
  assert.equal(plan.steps.find((s) => s.sheet === "אנמנזה").items, 89);
});

test("a draft covers every template row that needs content, in as many calls as planned", async () => {
  const { complete, calls } = fakeModel();
  const fills = await draftCase({ brief: BRIEF, template, caseId: "CASE-004", complete, now: () => new Date("2026-10-17T00:00:00Z") });
  assert.equal(calls.length, planDraft(template).calls);
  assert.deepEqual(fills.problems, []);
  for (const spec of SHEETS) {
    const wanted = pendingItems(template, spec).map((item) => item.id);
    for (const id of wanted) assert.ok(fills.sheets[spec.sheet][id], `${spec.sheet} ${id}`);
  }
  assert.equal(fills.sheets["מטא_מקרה"]["שיוך למסד המחלות"].fields["ערך"], "אין שיוך במסד הכללי (מקרה חדש)");
  assert.equal(fills.sheets["אנמנזה"]["AN-007"].needsReview, true);
  assert.equal(fills.generatedAt, "2026-10-17T00:00:00.000Z");
});

test("the prompt carries the brief and the do-not-invent rules, and later calls see earlier facts", async () => {
  const { complete, calls } = fakeModel();
  await draftCase({ brief: BRIEF, template, caseId: "CASE-004", complete });
  assert.ok(calls.every((call) => call.user.includes(BRIEF)));
  assert.match(calls[0].system, /אל תמציא אבחנות/);
  assert.match(calls[0].system, /needsReview=true/);
  assert.match(calls[0].system, /אל תחשוף את האבחנה|לעולם אל תחשוף/);
  assert.doesNotMatch(calls[0].user, /עובדות שכבר נקבעו/, "the first call has nothing to stay consistent with yet");
  assert.match(calls[calls.length - 1].user, /עובדות שכבר נקבעו/);
  assert.match(calls[calls.length - 1].user, /אנמנזה AN-001/);
});

test("an invalid or incomplete reply is retried once; items that never arrive are reported, not invented", async () => {
  const { complete, calls } = fakeModel({
    misbehave: (items, callNumber) => (callNumber === 2 ? items.slice(1).map((item, index) => (index === 0 ? { ...item, fields: { ...item.fields, "תשובת המטופל": "[למילוי: תשובה]" } } : item)) : items),
  });
  const fills = await draftCase({ brief: BRIEF, template, caseId: "CASE-004", complete });
  assert.equal(calls.length, planDraft(template).calls + 1, "one extra call for the retry");
  assert.deepEqual(fills.problems, [], "the retry recovered both the missing and the invalid items");
  const always = fakeModel({ misbehave: (items) => items.filter((item) => item.id !== "AN-010") });
  const partial = await draftCase({ brief: BRIEF, template, caseId: "CASE-004", complete: always.complete });
  assert.ok(partial.problems.some((line) => /AN-010/.test(line)));
  assert.equal(partial.sheets["אנמנזה"]["AN-010"], undefined);
});

test("ids invented by the model are ignored", async () => {
  const { complete } = fakeModel({ misbehave: (items) => [...items, { id: "ZZ-999", fields: Object.fromEntries(Object.keys(items[0].fields).map((c) => [c, "x"])), needsReview: false, note: "" }] });
  const fills = await draftCase({ brief: BRIEF, template, caseId: "CASE-004", complete });
  assert.ok(Object.values(fills.sheets).every((entries) => !("ZZ-999" in entries)));
});

test("an empty brief is refused before any call", async () => {
  const { complete, calls } = fakeModel();
  await assert.rejects(draftCase({ brief: "  ", template, caseId: "CASE-004", complete }));
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------------------------
// Excel round trip: draft -> workbook -> review -> approve -> JSON -> validation -> publish

const python = findPython();

test("round trip: a drafted workbook fails validation until approved, then passes and can be published", { skip: !python && "Python with openpyxl is not available" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "case-tool-test-"));
  const { complete } = fakeModel();
  const fills = await draftCase({ brief: BRIEF, template, caseId: "CASE-004", complete });
  const fillsPath = path.join(dir, "fills.json");
  fs.writeFileSync(fillsPath, JSON.stringify(fills), "utf8");
  const xlsx = path.join(dir, "CASE-004-draft.xlsx");
  runXlsxTool(["fill", path.join(root, "data/template/clinical-simulation-case-template-v2-he.xlsx"), fillsPath, xlsx]);

  const toJson = (file) => { const out = path.join(dir, `${path.basename(file)}.json`); runXlsxTool(["convert", file, out]); return JSON.parse(fs.readFileSync(out, "utf8")); };
  const draft = toJson(xlsx);
  assert.ok(draft.sheets["טיוטת_AI"], "the draft carries a review sheet");
  assert.ok(validateCase(draft, template).errors.some((e) => /סטטוס "טיוטה"/.test(e)), "drafts cannot be published");
  assert.ok(draft.sheets["טיוטת_AI"].some((row) => row.includes("AN-007")), "flagged items are listed");

  const approvedXlsx = path.join(dir, "CASE-004.approved.xlsx");
  runXlsxTool(["approve", xlsx, approvedXlsx]);
  const approved = toJson(approvedXlsx);
  const { errors } = validateCase(approved, template, { chiefComplaint: "אי-נוחות בחזה" });
  assert.deepEqual(errors, []);
  assert.equal(approved.sheets["טיוטת_AI"], undefined, "the review sheet is removed on approval");

  // publish into a scratch copy of the data folder
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "case-tool-root-"));
  fs.mkdirSync(path.join(scratch, "data", "cases"), { recursive: true });
  fs.mkdirSync(path.join(scratch, "data", "source"), { recursive: true });
  fs.writeFileSync(path.join(scratch, "data", "cases", "index.json"), JSON.stringify(catalogue), "utf8");
  const plan = planPublish({ file: approved, template, catalogue, chiefComplaint: "אי-נוחות בחזה" });
  assert.equal(plan.ok, true, plan.errors.join("; "));
  assert.equal(plan.entry.id, "CASE-004");
  assert.equal(plan.entry.demographics, "א׳ ש׳ · גבר · בן 58");
  applyPublish({ root: scratch, plan, file: approved, workbookPath: approvedXlsx });
  const written = JSON.parse(fs.readFileSync(path.join(scratch, "data", "cases", "index.json"), "utf8"));
  assert.deepEqual(written.cases.map((c) => c.id), ["CASE-001", "CASE-002", "CASE-003", "CASE-004"]);
  assert.ok(fs.existsSync(path.join(scratch, "data", "cases", "case-004.json")));
  assert.ok(fs.existsSync(path.join(scratch, "data", "source", "CASE-004.approved.xlsx")));
  // the real data folder is untouched
  assert.equal(read("data/cases/index.json").cases.length, 3);
});

// ---------------------------------------------------------------------------------------------
// publishing rules

test("publishing is refused without a chief complaint, for a duplicate id, or when validation fails", () => {
  const file = clone(approvedCase("001"));
  assert.equal(planPublish({ file, template, catalogue, chiefComplaint: "" }).ok, false);
  const duplicate = planPublish({ file, template, catalogue, chiefComplaint: "אי-נוחות" });
  assert.equal(duplicate.ok, false);
  assert.ok(duplicate.errors.some((e) => /כבר קיים/.test(e)));
  assert.equal(planPublish({ file: clone(template), template, catalogue, chiefComplaint: "x" }).ok, false);
  assert.equal(planPublish({ file, template, catalogue, chiefComplaint: "אי-נוחות", replace: true }).ok, true, "replace is explicit");
});

test("next case id continues after the highest id; demographics use the right gender form", () => {
  assert.equal(nextCaseId(catalogue), "CASE-004");
  assert.equal(nextCaseId({ cases: [] }), "CASE-001");
  assert.equal(demographicsOf("מ׳ ר׳", "אישה", 64), "מ׳ ר׳ · אישה · בת 64");
  assert.equal(demographicsOf("א׳ ש׳", "גבר", 58), "א׳ ש׳ · גבר · בן 58");
  for (const entry of catalogue.cases) assert.equal(demographicsOf(entry.initials, entry.sex, entry.age), entry.demographics, "matches the approved catalogue");
});

// ---------------------------------------------------------------------------------------------
// command line safety

function cli(args, env = {}) {
  return spawnSync(process.execPath, [path.join(root, "tools/case-tool/cli.mjs"), ...args], { encoding: "utf8", env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LOCALAPPDATA: process.env.LOCALAPPDATA, TEMP: process.env.TEMP, TMP: process.env.TMP, ...env } });
}

test("draft without --yes only prints a plan: no key is read and no request is made", () => {
  const brief = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "case-tool-brief-")), "brief.md");
  fs.writeFileSync(brief, BRIEF);
  const result = cli(["draft", brief], { CASE_TOOL_API_KEY: "must-not-be-used" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /תוכנית בלבד/);
  assert.match(result.stdout, /קריאות מתוכננות/);
  assert.ok(!result.stdout.includes("must-not-be-used") && !result.stderr.includes("must-not-be-used"));
});

test("draft --yes without a key stops with a clear message", () => {
  const brief = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "case-tool-brief-")), "brief.md");
  fs.writeFileSync(brief, BRIEF);
  const result = cli(["draft", brief, "--yes"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CASE_TOOL_API_KEY/);
});

test("publish without --yes is a dry run for a valid case and never writes", { skip: !python && "Python with openpyxl is not available" }, () => {
  const before = fs.readFileSync(path.join(root, "data/cases/index.json"), "utf8");
  const source = path.join(root, "data/source/case-001-stable-angina-patient-database-v2-he.xlsx");
  const result = cli(["publish", source, "--chief-complaint", "אי-נוחות"]);
  // CASE-001 already exists, so the plan must be refused rather than applied.
  assert.equal(result.status, 1);
  assert.match(result.stdout, /כבר קיים בקטלוג/);
  assert.equal(fs.readFileSync(path.join(root, "data/cases/index.json"), "utf8"), before);
});
