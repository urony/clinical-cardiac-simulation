// Tests for working with the author's own AI chat: the work document, and reading the pasted answers.
// No network and no AI: the "chat answers" are produced by the tests.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAdminServer } from "../tools/case-admin/server.mjs";
import { IMPORTANCE, validateCase } from "../tools/case-tool/case-validation.mjs";
import { buildChatPackage, chatGroups, extractJsonBlocks, importReplies } from "../tools/case-tool/chat-package.mjs";
import { planDraft } from "../tools/case-tool/draft.mjs";
import { emptyFills } from "../tools/case-tool/draft.mjs";
import { applyFillsToTemplate } from "../tools/case-tool/workbook-json.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const template = JSON.parse(fs.readFileSync(path.join(repo, "data/template/case-template.json"), "utf8"));
const realIndexBefore = fs.readFileSync(path.join(repo, "data/cases/index.json"), "utf8");
test.after(() => { assert.equal(fs.readFileSync(path.join(repo, "data/cases/index.json"), "utf8"), realIndexBefore); });

const META = { "ראשי תיבות מטופל": "א׳ ש׳", "גיל": "58", "מין": "גבר", "אבחנה ידועה למערכת": "מחלת בדיקה פיקטיבית", "נוסח פתיחה לתלמיד": "א׳ ש׳, גבר בן 58, פונה בשל אי-נוחות." };

/** What a chat assistant would answer for one group: a fenced JSON block, with chatter around it. */
function answerFor(group, { flag = (id) => id.endsWith("7") } = {}) {
  const items = group.items.map((item) => ({
    id: item.id,
    fields: Object.fromEntries(group.columns.map((column) => [column, column === "חשיבות במקרה" ? IMPORTANCE[1] : column === "ערך" && META[item.id] ? META[item.id] : `${column} של ${item.id}`])),
    needsReview: flag(item.id), note: flag(item.id) ? "הומצא" : "",
  }));
  return `בטח, הנה הקבוצה:\n\n\`\`\`json\n${JSON.stringify({ items }, null, 2)}\n\`\`\`\n\nקבוצה ${group.items.length}. כתבו ׳המשך׳.`;
}
const allAnswers = () => chatGroups(template).map((group) => answerFor(group)).join("\n\n");

// ---- the document ------------------------------------------------------------------------------

test("the work document has the instructions, the rules, the format, the brief and every group of items", () => {
  const brief = "גבר בן 58 עם כאב בחזה במאמץ. תיאור ייחודי 12345.";
  const document = buildChatPackage({ template, brief, caseId: "CASE-004" });
  for (const phrase of ["קרא את כל המסמך", "אל תפיק שום קבוצה לפני שאגיד ״התחל״", "קבוצה אחת בכל הודעה", "אל תמציא אבחנות", "needsReview", "חשיבות במקרה", "```json"]) assert.ok(document.includes(phrase), phrase);
  assert.ok(document.includes("תיאור ייחודי 12345"), "the author's brief is included");
  const groups = chatGroups(template);
  assert.equal(groups.length, planDraft(template).calls, "the same number of groups as automatic calls");
  assert.equal((document.match(/^### קבוצה \d+ מתוך \d+:/gm) ?? []).length, groups.length);
  const ids = groups.flatMap((group) => group.items.map((item) => item.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.length > 240);
  for (const id of ["AN-001", "PE-001", "IT-031-CRE", "FT-009", "DEC-001", "FB-001"].filter((value) => ids.includes(value) || value === "AN-001")) assert.ok(document.includes(id), id);
});

test("without a brief the document still explains what to do and carries no empty brief section", () => {
  const document = buildChatPackage({ template, brief: "", caseId: "CASE-004" });
  assert.doesNotMatch(document, /מה המחבר כבר כתב/);
  assert.match(document, /שאל מעט שאלות בכל פעם/);
});

test("numeric items carry their unit and qualitative tests ask for the displayed result", () => {
  const groups = chatGroups(template);
  const numeric = groups.find((group) => group.spec.sheet === "תוצאות_מספריות");
  assert.ok(numeric.items.some((item) => item.unit === "cm"));
  const qualitative = groups.find((group) => group.columns.includes("תוצאה להצגה"));
  assert.ok(qualitative, "a group for tests whose displayed result is written by hand");
});

// ---- reading pasted answers -----------------------------------------------------------------------

test("JSON is found in fenced blocks, in plain text around braces, and in a bare array; broken pieces are ignored", () => {
  const block = JSON.stringify({ items: [{ id: "AN-001" }] });
  assert.equal(extractJsonBlocks("טקסט\n```json\n" + block + "\n```\nעוד טקסט").length, 1);
  assert.equal(extractJsonBlocks("```\n" + block + "\n```\n```json\n" + block + "\n```").length, 2);
  assert.equal(extractJsonBlocks("הנה התשובה: " + block + " תודה").length, 1);
  assert.deepEqual(extractJsonBlocks("```json\n[{\"id\":\"x\"}]\n```"), [[{ id: "x" }]]);
  assert.equal(extractJsonBlocks("```json\n{ שבור\n```\n```json\n" + block + "\n```").length, 1, "a broken block does not hide a good one");
  assert.equal(extractJsonBlocks("אין כאן שום JSON").length, 0);
  assert.equal(extractJsonBlocks('```json\n{"items": [{"id": "AN-001",},],}\n```').length, 1, "a trailing comma left by the assistant is tolerated");
  assert.equal(extractJsonBlocks('{"a":"סוגריים } בתוך מחרוזת"}').length, 1);
});

test("a whole pasted conversation fills every item and the result passes the same validation as a model-made draft", () => {
  const imported = importReplies({ template, fills: null, raw: allAnswers(), caseId: "CASE-004" });
  assert.equal(imported.rejected.length, 0, JSON.stringify(imported.rejected.slice(0, 3)));
  assert.equal(imported.accepted.length, chatGroups(template).reduce((sum, group) => sum + group.items.length, 0));
  assert.equal(imported.blocks, 15);
  const file = applyFillsToTemplate(template, imported.fills, { approved: true });
  assert.deepEqual(validateCase(file, template, { chiefComplaint: "אי-נוחות" }).errors, []);
  const flagged = Object.values(imported.fills.sheets).flatMap((entries) => Object.values(entries)).filter((entry) => entry.needsReview);
  assert.ok(flagged.length > 10, "items the assistant was unsure about are marked for review");
  assert.ok(flagged.every((entry) => entry.reviewed === false));
});

test("answers can be pasted a group at a time, in any order, and repeated pastes do not duplicate", () => {
  const groups = chatGroups(template);
  let fills = null;
  for (const group of [groups[3], groups[0], groups[1]]) fills = importReplies({ template, fills, raw: answerFor(group), caseId: "CASE-004" }).fills;
  const again = importReplies({ template, fills, raw: answerFor(groups[0]), caseId: "CASE-004" });
  assert.equal(again.accepted.length, groups[0].items.length);
  assert.equal(Object.keys(again.fills.sheets["מטא_מקרה"]).length >= 1, true);
  assert.ok(again.fills.sheets["אנמנזה"]["AN-001"], "the anamnesis group was kept");
});

test("every kind of bad item is rejected with a reason and the good ones in the same paste are still accepted", () => {
  const group = chatGroups(template).find((item) => item.spec.sheet === "אנמנזה");
  const good = answerFor(group, { flag: () => false });
  const base = JSON.parse(good.split("```json")[1].split("```")[0]);
  const items = base.items.slice(0, 6);
  items[0] = { ...items[0], id: "ZZ-999" };
  items[1] = { ...items[1], fields: { ...items[1].fields, "תשובת המטופל": "" } };
  items[2] = { ...items[2], fields: { ...items[2].fields, "היגיון למשוב": "[למילוי: מדוע]" } };
  items[3] = { ...items[3], fields: { ...items[3].fields, "חשיבות במקרה": "חשיבות מומצאת" } };
  items[4] = { id: items[4].id, fields: { "תשובת המטופל": "x" } };
  const result = importReplies({ template, fills: null, raw: "```json\n" + JSON.stringify({ items }) + "\n```", caseId: "CASE-004" });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 5);
  assert.match(result.rejected.map((r) => r.reason).join("|"), /אינו בתבנית/);
  assert.match(result.rejected.map((r) => r.reason).join("|"), /הוראת תבנית/);
  assert.match(result.rejected.map((r) => r.reason).join("|"), /חשיבות לא תקינה/);
  assert.ok(result.rejected.every((r) => r.reason), "every rejection explains itself");
  assert.equal(result.rejected.find((r) => r.id === items[1].id).label.length > 0, true, "rejections show the readable name");
});

test("a duplicate id in one paste takes the first; text with no JSON is a clear error", () => {
  const group = chatGroups(template).find((item) => item.spec.sheet === "אנמנזה");
  const one = JSON.parse(answerFor(group).split("```json")[1].split("```")[0]).items[0];
  const second = { ...one, fields: { ...one.fields, "תשובת המטופל": "שנייה" } };
  const result = importReplies({ template, fills: null, raw: "```json\n" + JSON.stringify({ items: [one, second] }) + "\n```", caseId: "CASE-004" });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.fills.sheets["אנמנזה"][one.id].fields["תשובת המטופל"], one.fields["תשובת המטופל"]);
  assert.equal(result.rejected.length, 1);
  assert.throws(() => importReplies({ template, fills: null, raw: "שלום, זו לא תשובה", caseId: "CASE-004" }), /לא נמצא בטקסט שהודבק JSON/);
});

test("items the author edited by hand are kept when answers are pasted again, unless replacing is requested", () => {
  const group = chatGroups(template).find((item) => item.spec.sheet === "אנמנזה");
  let { fills } = importReplies({ template, fills: null, raw: answerFor(group), caseId: "CASE-004" });
  const id = group.items[0].id;
  fills.sheets["אנמנזה"][id].fields["תשובת המטופל"] = "העריכה שלי";
  fills.sheets["אנמנזה"][id].edited = true;
  const kept = importReplies({ template, fills, raw: answerFor(group), caseId: "CASE-004" });
  assert.deepEqual(kept.keptEdited.map((item) => item.id), [id]);
  assert.equal(kept.fills.sheets["אנמנזה"][id].fields["תשובת המטופל"], "העריכה שלי");
  const replaced = importReplies({ template, fills: kept.fills, raw: answerFor(group), caseId: "CASE-004", replace: true });
  assert.notEqual(replaced.fills.sheets["אנמנזה"][id].fields["תשובת המטופל"], "העריכה שלי");
});

test("importing keeps the fixed values that are never written by an AI (generated display text, disease database link)", () => {
  const { fills } = importReplies({ template, fills: null, raw: answerFor(chatGroups(template)[1]), caseId: "CASE-004" });
  assert.equal(fills.sheets["מטא_מקרה"]["שיוך למסד המחלות"].fields["ערך"], "אין שיוך במסד הכללי (מקרה חדש)");
  assert.equal(fills.sheets["בדיקות_מיידיות"]["IT-001"].fields["תוצאה להצגה"], "נוצר אוטומטית מתוצאות_מספריות.");
  assert.equal(JSON.stringify(emptyFills(template, "CASE-004").sheets["בדיקות_מיידיות"]["IT-001"]), JSON.stringify(fills.sheets["בדיקות_מיידיות"]["IT-001"]), "an untouched row equals the empty draft");
});

// ---- through the admin server -------------------------------------------------------------------------

function scratchRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-root-"));
  for (const dir of ["data/template", "data/cases", "data/source"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const name of ["case-template.json", "clinical-simulation-case-template-v2-he.xlsx"]) fs.copyFileSync(path.join(repo, "data/template", name), path.join(root, "data/template", name));
  const realIndex = JSON.parse(fs.readFileSync(path.join(repo, "data/cases/index.json"), "utf8"));
  fs.writeFileSync(path.join(root, "data/cases/index.json"), JSON.stringify({ ...realIndex, cases: realIndex.cases.filter((entry) => ["CASE-001", "CASE-002", "CASE-003"].includes(entry.id)) }), "utf8");
  return root;
}

test("through the admin interface: download the document, paste the conversation, review, and publish a fourth case", async () => {
  const root = scratchRoot();
  const admin = createAdminServer({ root, providers: () => [{ id: "gemini", label: "Gemini" }], python: false, env: {}, complete: undefined });
  const port = await admin.listen(0);
  const call = async (method, url, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { "content-type": "application/json", "x-admin-token": admin.token }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, json: await response.json().catch(() => ({})) };
  };
  try {
    const { json: created } = await call("POST", "/api/drafts", {});
    await call("PUT", `/api/drafts/${created.id}/brief`, { fields: { topic: "אבחנה פיקטיבית לבדיקה" }, chiefComplaint: "אי-נוחות בחזה" });
    const pack = await call("GET", `/api/drafts/${created.id}/ai-package`);
    assert.equal(pack.status, 200);
    assert.equal(pack.json.filename, `${created.id}-ai-work-document.md`);
    assert.ok(pack.json.text.includes("אבחנה פיקטיבית לבדיקה"), "the brief typed in step 1 travels with the document");

    assert.equal((await call("POST", `/api/drafts/${created.id}/import`, { text: "אין כאן JSON" })).status, 400);
    const imported = await call("POST", `/api/drafts/${created.id}/import`, { text: allAnswers() });
    assert.equal(imported.status, 200);
    assert.equal(imported.json.remaining, 0);
    assert.equal(imported.json.rejectedCount, 0);

    let check = (await call("POST", `/api/drafts/${created.id}/check`, {})).json;
    assert.equal(check.errorCount, 0);
    assert.ok(check.unreviewed.length > 0 && check.unreviewed.every((item) => item.label));
    for (const item of check.unreviewed) await call("PATCH", `/api/drafts/${created.id}/entry`, { sheet: item.sheet, id: item.id, reviewed: true });
    check = (await call("POST", `/api/drafts/${created.id}/check`, {})).json;
    assert.equal(check.canPublish, true, check.blockers.join("; "));
    const published = await call("POST", `/api/drafts/${created.id}/publish`, { confirm: true });
    assert.equal(published.status, 200, JSON.stringify(published.json));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "data/cases/index.json"), "utf8")).cases.map((c) => c.id), ["CASE-001", "CASE-002", "CASE-003", "CASE-004"]);
  } finally { await admin.close(); }
});

test("the admin page offers the chat route first and explains it in three steps", () => {
  const app = fs.readFileSync(path.join(repo, "tools/case-admin/public/app.js"), "utf8");
  for (const phrase of ["אפשרות א׳ (מומלצת): עם ה-AI שלך בצ'אט, בלי עלות API", "הורד מסמך עבודה ל-AI", "ייבא", "אפשרות ב׳: הפקה אוטומטית עם מפתח API"]) assert.ok(app.includes(phrase), phrase);
  assert.ok(app.indexOf("chatPanel(), h(\"div\"") > 0, "the chat panel comes before the API panel");
});

test("sex and age come out in the exact form the system needs, whatever words the assistant used", async () => {
  const { normalizeMetaValue } = await import("../tools/case-tool/draft.mjs");
  for (const [input, expected] of [["זכר", "גבר"], ["גבר", "גבר"], ["Male", "גבר"], ["נקבה", "אישה"], ["אשה", "אישה"], ["אישה.", "אישה"], ["female", "אישה"], ["לא ידוע", "לא ידוע"]]) assert.equal(normalizeMetaValue("מין", input), expected, input);
  for (const [input, expected] of [["58", "58"], ["בן 58", "58"], ["בת 64", "64"], ["58 שנים", "58"], ["גיל 44", "44"], ["כ-58", "כ-58"], ["58 ומשהו", "58 ומשהו"]]) assert.equal(normalizeMetaValue("גיל", input), expected, input);
  assert.equal(normalizeMetaValue("אבחנה ידועה למערכת", " טקסט "), "טקסט", "other fields are only trimmed");
});

test("a pasted answer that says זכר is accepted as גבר and the case then validates", () => {
  const group = chatGroups(template).find((item) => item.spec.sheet === "מטא_מקרה");
  const answer = JSON.parse(answerFor(group).split("```json")[1].split("```")[0]);
  for (const item of answer.items) { if (item.id === "מין") item.fields["ערך"] = "זכר"; if (item.id === "גיל") item.fields["ערך"] = "בן 58"; }
  const imported = importReplies({ template, fills: null, raw: "```json\n" + JSON.stringify(answer) + "\n```", caseId: "CASE-004" });
  assert.equal(imported.fills.sheets["מטא_מקרה"]["מין"].fields["ערך"], "גבר");
  assert.equal(imported.fills.sheets["מטא_מקרה"]["גיל"].fields["ערך"], "58");
});
