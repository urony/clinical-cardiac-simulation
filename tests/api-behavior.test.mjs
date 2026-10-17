// Behavior tests for the simulation API routes. The AI provider is replaced by a fake `fetch`,
// so no network request is made and no real API key is used. Run after `npm run build`.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
const { default: worker } = await import(workerUrl.href);

const realFetch = globalThis.fetch;
const FAKE_KEY = "test-key-not-real";

function caseIds(caseFile, sheet, idColumn) {
  const data = JSON.parse(fs.readFileSync(new URL(`../data/cases/${caseFile}.json`, import.meta.url), "utf8"));
  const rows = data.sheets[sheet];
  const headerIndex = rows.findIndex((row) => row.some((cell) => String(cell ?? "").includes("מזהה")));
  const column = rows[headerIndex].findIndex((cell) => String(cell ?? "") === idColumn);
  return rows.slice(headerIndex + 1).map((row) => row[column]).filter(Boolean);
}

/** Replace the provider with a fake that returns `replies` in order and records every call. */
function fakeProvider(replies) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body, chars: init.body.length, auth: init.headers.Authorization });
    const text = replies[Math.min(calls.length - 1, replies.length - 1)];
    return new Response(JSON.stringify({ output_text: typeof text === "string" ? text : JSON.stringify(text) }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return calls;
}

async function post(path, payload, headers = { "x-pilot-openai-key": FAKE_KEY }) {
  const request = new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload) });
  const response = await worker.fetch(request, { ASSETS: { fetch: async () => new Response("", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
  return { status: response.status, json: await response.json() };
}

test.afterEach(() => { globalThis.fetch = realFetch; });

const anamnesisIds = caseIds("case-001", "אנמנזה", "מזהה רכיב בסיס");
const testIds = caseIds("case-001", "בדיקות_מיידיות", "מזהה רכיב בסיס");

test("missing key returns 503 and never calls the provider", async () => {
  const calls = fakeProvider(["unused"]);
  const { status } = await post("/api/simulation/respond", { caseId: "CASE-001", phase: "anamnesis", question: "מה מפריע לך?" }, {});
  assert.equal(status, 503);
  assert.equal(calls.length, 0);
});

test("invalid case, phase or oversize question is rejected before any provider call", async () => {
  const calls = fakeProvider(["unused"]);
  for (const payload of [
    { caseId: "CASE-999", phase: "anamnesis", question: "שלום" },
    { caseId: "CASE-001", phase: "diagnosis", question: "שלום" },
    { caseId: "CASE-001", phase: "anamnesis", question: "א".repeat(1201) },
    { caseId: "CASE-001", phase: "anamnesis", question: "   " },
  ]) {
    const { status } = await post("/api/simulation/respond", payload);
    assert.equal(status, 400);
  }
  assert.equal(calls.length, 0);
});

test("anamnesis question costs two provider calls and only approved facts reach the answer prompt", async () => {
  assert.ok(anamnesisIds.length > 5, "expected anamnesis ids in case data");
  const calls = fakeProvider([{ matched_ids: [anamnesisIds[1]], ambiguous: false }, "כואב לי בחזה."]);
  const { status, json } = await post("/api/simulation/respond", { caseId: "CASE-001", phase: "anamnesis", question: "איפה כואב?" });
  assert.equal(status, 200);
  assert.equal(calls.length, 2);
  assert.equal(json.answer, "כואב לי בחזה.");
  assert.deepEqual(json.matchedIds, [anamnesisIds[1]]);
  assert.ok(calls.every((call) => call.auth === `Bearer ${FAKE_KEY}`));
  // The answer prompt lists exactly one approved fact, not the whole catalogue.
  const answerPrompt = calls[1].body.input[0].content[0].text;
  assert.equal((answerPrompt.match(/approved_fact/g) ?? []).length, 1);
  console.log(`# measure anamnesis question: ${calls.length} calls, request chars = ${calls.map((c) => c.chars).join(" + ")}`);
});

test("ids invented by the model are discarded", async () => {
  fakeProvider([{ matched_ids: ["NOT-A-REAL-ID", anamnesisIds[0]], ambiguous: false }, "תשובה."]);
  const { json } = await post("/api/simulation/respond", { caseId: "CASE-001", phase: "anamnesis", question: "שאלה" });
  assert.deepEqual(json.matchedIds, [anamnesisIds[0]]);
});

test("ambiguous question stops after the classifier call and asks for clarification", async () => {
  const calls = fakeProvider([{ matched_ids: [], ambiguous: true }]);
  const { status, json } = await post("/api/simulation/respond", { caseId: "CASE-001", phase: "anamnesis", question: "מה?" });
  assert.equal(status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(json.matchedIds, []);
  assert.ok(json.answer);
});

test("test-request recognition uses one call; execute uses none and returns only approved results", async () => {
  assert.ok(testIds.length > 2, "expected immediate-test ids in case data");
  const calls = fakeProvider([{ matched_ids: [testIds[0]], ambiguous: false }]);
  const recognized = await post("/api/simulation/respond", { caseId: "CASE-001", phase: "immediateTests", question: "אבקש בדיקת דם", mode: "recognize" });
  assert.equal(recognized.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(recognized.json.recognized.length, 1);
  console.log(`# measure recognize: 1 call, request chars = ${calls[0].chars}`);

  const executed = await post("/api/simulation/respond", { caseId: "CASE-001", phase: "immediateTests", question: "בצע", mode: "execute", selectedIds: [testIds[0], "FAKE-ID"] });
  assert.equal(executed.status, 200);
  assert.equal(calls.length, 1, "execute must not call the provider");
  assert.deepEqual(executed.json.matchedIds, [testIds[0]]);
});

test("execute is refused outside the test phases", async () => {
  const calls = fakeProvider(["unused"]);
  const { status } = await post("/api/simulation/respond", { caseId: "CASE-001", phase: "anamnesis", question: "בצע", mode: "execute", selectedIds: [anamnesisIds[0]] });
  assert.equal(status, 400);
  assert.equal(calls.length, 0);
});

test("provider failure surfaces as a 502 error, not a made-up answer", async (t) => {
  t.mock.method(console, "error", () => {}); // the route logs provider errors; keep test output clean
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "You have no credits remaining" } }), { status: 429, headers: { "content-type": "application/json" } });
  const { status, json } = await post("/api/simulation/respond", { caseId: "CASE-001", phase: "anamnesis", question: "שאלה" });
  assert.equal(status, 502);
  assert.match(json.error, /no credits remaining/);
  assert.equal(json.answer, undefined);
});

test("feedback returns structured feedback with one provider call, and rejects an unknown case", async () => {
  const empty = { good: ["נעשה היטב"], reconsider: ["לשקול"] };
  const feedback = Object.fromEntries(["אנמנזה", "בדיקה גופנית", "בדיקות בסיסיות", "בדיקות המשך והנמקות", "חשיבה אבחנתית והחלטות", "רשומה רפואית", "הסבר למטופל"].map((name) => [name, empty]));
  const calls = fakeProvider([feedback]);
  const ok = await post("/api/simulation/feedback", { caseId: "CASE-001", stage: "feedback", actions: [], results: [], rationale1: [], rationale2: [], form: {}, transcript: "" });
  assert.equal(ok.status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(ok.json.feedback).length, 7);
  console.log(`# measure feedback: 1 call (2 if the structured reply is malformed), request chars = ${calls[0].chars}`);

  const bad = await post("/api/simulation/feedback", { caseId: "CASE-777" });
  assert.equal(bad.status, 400);
});

test("malformed structured feedback falls back to a second, plain-text call", async () => {
  const calls = fakeProvider([{ wrong: "shape" }, "חוזקות:\n- יפה\nלשיפור:\n- לחזור"]);
  const { status, json } = await post("/api/simulation/feedback", { caseId: "CASE-001", stage: "feedback" });
  assert.equal(status, 200);
  assert.equal(calls.length, 2);
  assert.ok(json.feedback["משוב פרופ׳ שחף"]);
});

test("the per-case fact limit comes from the catalogue: CASE-002 answers with at most 2 facts, CASE-001 with more", async () => {
  const many = (file) => caseIds(file, "אנמנזה", "מזהה רכיב בסיס").slice(0, 6);
  for (const [caseId, file, expected] of [["CASE-002", "case-002", 2], ["CASE-001", "case-001", 6]]) {
    const calls = fakeProvider([{ matched_ids: many(file), ambiguous: false }, "תשובה."]);
    const { json } = await post("/api/simulation/respond", { caseId, phase: "anamnesis", question: "ספר לי הכל" });
    assert.equal(json.matchedIds.length, expected, caseId);
    assert.equal(calls.length, 2);
  }
});
