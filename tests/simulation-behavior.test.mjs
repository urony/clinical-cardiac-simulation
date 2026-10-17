// Behavior tests for the simulation logic that runs in the browser. The model provider is replaced
// by a fake `fetch`, so no network request is made and no real API key is used.
import assert from "node:assert/strict";
import test from "node:test";
import { loadLib, readCaseFile } from "./helpers/load-lib.mjs";

const lib = await loadLib();
const { runSimulationStep } = lib.simulation;
const { generateFeedback } = lib.feedback;
const { availableCases, validCaseId } = lib.catalog;
const { phaseItems } = lib.caseData;

const realFetch = globalThis.fetch;
const FAKE_KEY = "test-key-not-real";
const config = { providerId: "openai", apiKey: FAKE_KEY, retryDelayMs: 0 };

function context(caseId = "CASE-001", overrides = {}) {
  const entry = availableCases.find((item) => item.id === caseId);
  return { config, entry, caseFile: readCaseFile(entry.file), ...overrides };
}
const ids = (caseId, phase) => phaseItems(context(caseId).caseFile, phase).map((item) => item.id);

/** Replace the provider with a fake that returns `replies` in order and records every call. */
function fakeProvider(replies) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), chars: init.body.length, auth: init.headers.Authorization });
    const text = replies[Math.min(calls.length - 1, replies.length - 1)];
    return new Response(JSON.stringify({ output_text: typeof text === "string" ? text : JSON.stringify(text) }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return calls;
}
test.afterEach(() => { globalThis.fetch = realFetch; });

const anamnesisIds = ids("CASE-001", "anamnesis");
const testIds = ids("CASE-001", "immediateTests");

test("an unknown case id is not valid, so it can never reach the logic", () => {
  assert.equal(validCaseId("CASE-001"), true);
  assert.equal(validCaseId("CASE-999"), false);
  assert.equal(validCaseId(undefined), false);
});

test("missing key fails with 503 and never calls the provider", async () => {
  const calls = fakeProvider(["unused"]);
  await assert.rejects(runSimulationStep(context("CASE-001", { config: { providerId: "openai", apiKey: "" } }), { phase: "anamnesis", question: "מה מפריע לך?" }), (error) => error.status === 503);
  assert.equal(calls.length, 0);
});

test("invalid phase, oversize or blank question is rejected before any provider call", async () => {
  const calls = fakeProvider(["unused"]);
  for (const request of [{ phase: "diagnosis", question: "שלום" }, { phase: "anamnesis", question: "א".repeat(1201) }, { phase: "anamnesis", question: "   " }, { question: "שלום" }]) {
    await assert.rejects(runSimulationStep(context(), request), (error) => error.status === 400);
  }
  assert.equal(calls.length, 0);
});

test("anamnesis question costs two provider calls and only approved facts reach the answer prompt", async () => {
  assert.ok(anamnesisIds.length > 5);
  const calls = fakeProvider([{ matched_ids: [anamnesisIds[1]], ambiguous: false }, "כואב לי בחזה."]);
  const result = await runSimulationStep(context(), { phase: "anamnesis", question: "איפה כואב?" });
  assert.equal(calls.length, 2);
  assert.equal(result.answer, "כואב לי בחזה.");
  assert.deepEqual(result.matchedIds, [anamnesisIds[1]]);
  assert.ok(calls.every((call) => call.auth === `Bearer ${FAKE_KEY}` && call.url === "https://api.openai.com/v1/responses"));
  assert.equal((calls[1].body.input[0].content[0].text.match(/approved_fact/g) ?? []).length, 1);
  console.log(`# measure anamnesis question: ${calls.length} calls, request chars = ${calls.map((c) => c.chars).join(" + ")}`);
});

test("ids invented by the model are discarded", async () => {
  fakeProvider([{ matched_ids: ["NOT-A-REAL-ID", anamnesisIds[0]], ambiguous: false }, "תשובה."]);
  const result = await runSimulationStep(context(), { phase: "anamnesis", question: "שאלה" });
  assert.deepEqual(result.matchedIds, [anamnesisIds[0]]);
});

test("ambiguous question stops after the classifier call and asks for clarification", async () => {
  const calls = fakeProvider([{ matched_ids: [], ambiguous: true }]);
  const result = await runSimulationStep(context(), { phase: "anamnesis", question: "מה?" });
  assert.equal(calls.length, 1);
  assert.deepEqual(result.matchedIds, []);
  assert.ok(result.answer);
});

test("test-request recognition uses one call; execute uses none and returns only approved results", async () => {
  assert.ok(testIds.length > 2);
  const calls = fakeProvider([{ matched_ids: [testIds[0]], ambiguous: false }]);
  const recognized = await runSimulationStep(context(), { phase: "immediateTests", question: "אבקש בדיקת דם", mode: "recognize" });
  assert.equal(calls.length, 1);
  assert.equal(recognized.recognized.length, 1);
  console.log(`# measure recognize: 1 call, request chars = ${calls[0].chars}`);

  const executed = await runSimulationStep(context(), { phase: "immediateTests", question: "בצע", mode: "execute", selectedIds: [testIds[0], "FAKE-ID"] });
  assert.equal(calls.length, 1, "execute must not call the provider");
  assert.deepEqual(executed.matchedIds, [testIds[0]]);
});

test("execute is refused outside the test phases", async () => {
  const calls = fakeProvider(["unused"]);
  await assert.rejects(runSimulationStep(context(), { phase: "anamnesis", question: "בצע", mode: "execute", selectedIds: [anamnesisIds[0]] }), (error) => error.status === 400);
  assert.equal(calls.length, 0);
});

test("provider failure surfaces as an error with the provider's message, not a made-up answer", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "You have no credits remaining" } }), { status: 429, headers: { "content-type": "application/json" } });
  await assert.rejects(runSimulationStep(context(), { phase: "anamnesis", question: "שאלה" }), (error) => error.kind === "quota" && /no credits remaining/.test(error.detail) && /נגמרו/.test(error.message));
});

test("a network failure gives a clear Hebrew message", async () => {
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(runSimulationStep(context(), { phase: "anamnesis", question: "שאלה" }), /לא ניתן להגיע לספק/);
});

test("the per-case fact limit comes from the catalogue: CASE-002 answers with at most 2 facts, CASE-001 with more", async () => {
  for (const [caseId, expected] of [["CASE-002", 2], ["CASE-001", 6]]) {
    const calls = fakeProvider([{ matched_ids: ids(caseId, "anamnesis").slice(0, 6), ambiguous: false }, "תשובה."]);
    const result = await runSimulationStep(context(caseId), { phase: "anamnesis", question: "ספר לי הכל" });
    assert.equal(result.matchedIds.length, expected, caseId);
    assert.equal(calls.length, 2);
  }
});

const domains = ["אנמנזה", "בדיקה גופנית", "בדיקות בסיסיות", "בדיקות המשך והנמקות", "חשיבה אבחנתית והחלטות", "רשומה רפואית", "הסבר למטופל"];

test("feedback returns the seven structured domains with one provider call", async () => {
  const section = { good: ["נעשה היטב"], reconsider: ["לשקול"] };
  const calls = fakeProvider([Object.fromEntries(domains.map((name) => [name, section]))]);
  const feedback = await generateFeedback(config, context().caseFile, { caseId: "CASE-001", stage: "feedback" });
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(feedback), domains);
  console.log(`# measure feedback: 1 call (2 if the structured reply is malformed), request chars = ${calls[0].chars}`);
});

test("malformed structured feedback falls back to a second, plain-text call", async () => {
  const calls = fakeProvider([{ wrong: "shape" }, "חוזקות:\n- יפה\nלשיפור:\n- לחזור"]);
  const feedback = await generateFeedback(config, context().caseFile, { caseId: "CASE-001" });
  assert.equal(calls.length, 2);
  assert.deepEqual(feedback["משוב פרופ׳ שחף"], { good: ["יפה"], reconsider: ["לחזור"] });
});

test("feedback without a key fails with 503 and makes no call", async () => {
  const calls = fakeProvider(["unused"]);
  await assert.rejects(generateFeedback({ providerId: "openai", apiKey: "" }, context().caseFile, {}), (error) => error.status === 503);
  assert.equal(calls.length, 0);
});

test("sessions are stored per code, expire, and reject malformed codes", () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  try {
    lib.session.saveSession("SIM-ABCDEF12", { stage: "anamnesis" });
    assert.deepEqual(lib.session.loadSession("SIM-ABCDEF12"), { stage: "anamnesis" });
    assert.throws(() => lib.session.loadSession("SIM-NOPE0000"), /לא נמצאה/);
    assert.throws(() => lib.session.loadSession("bad"), /קוד שחזור לא תקין/);
    const key = [...store.keys()][0];
    store.set(key, JSON.stringify({ expiresAt: Date.now() - 1, updatedAt: 0, payload: {} }));
    assert.throws(() => lib.session.loadSession("SIM-ABCDEF12"), /לא נמצאה/);
  } finally { delete globalThis.localStorage; }
});
