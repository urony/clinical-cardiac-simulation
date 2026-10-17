// Tests for the changes made after the first hands-on testing: follow-up results release, per-patient
// sessions, key warnings, provider ordering, error text parsing, multi-model connection check, feedback retry.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { loadLib, readCaseFile } from "./helpers/load-lib.mjs";

const lib = await loadLib();
const { releasedResults, FOLLOWUP_WAIT_MESSAGE, FOLLOWUP_AREA } = lib.release;
const { keyFormatWarning, providersForTeachers, providerLabel, getProvider, providers } = lib.providers;
const { complete, errorText, testConnection, failureMessages, buildResponsesBody } = lib.client;
const { generateFeedback } = lib.feedback;
const { availableCases } = lib.catalog;
const session = lib.session;

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; delete globalThis.localStorage; });

const KEY = "fake-key-1234567890";
function script(...steps) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    return new Response(JSON.stringify(step.payload ?? {}), { status: step.status ?? 200 });
  };
  return calls;
}
const ok = (text = "בסדר") => ({ status: 200, payload: { output_text: text } });

// ---- follow-up results -------------------------------------------------------------------------

test("follow-up results stay hidden until the results stage; basic results are always visible", () => {
  const results = [{ id: "IT-001", area: "בדיקות בסיסיות", label: "אק״ג" }, { id: "FT-001", area: FOLLOWUP_AREA, label: "הולטר" }, { id: "FT-002", area: FOLLOWUP_AREA, label: "אקו" }];
  assert.deepEqual(releasedResults(results, false).map((r) => r.id), ["IT-001"]);
  assert.deepEqual(releasedResults(results, true).map((r) => r.id), ["IT-001", "FT-001", "FT-002"]);
  assert.deepEqual(releasedResults([], false), []);
});

test("the waiting message tells the student the tests take time and to keep deciding meanwhile", () => {
  assert.match(FOLLOWUP_WAIT_MESSAGE, /לוקחות זמן/);
  assert.match(FOLLOWUP_WAIT_MESSAGE, /יגיעו בהמשך/);
  assert.match(FOLLOWUP_WAIT_MESSAGE, /עד שיגיעו הבדיקות המתקדמות/);
});

test("the screen uses the released results everywhere a student or a report could see them", () => {
  const app = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /releasedResults\(results, followupReleased\)/);
  assert.match(app, /<TestFile results=\{shownResults\}\/>/);
  assert.match(app, /PrintableReport[^\n]*results=\{shownResults\}/);
  assert.match(app, /results: shownResults/, "interim feedback is built from the released results");
  assert.match(app, /const testSummary = shownResults/);
  assert.doesNotMatch(app, /<TestFile results=\{results\}/);
  assert.match(app, /FOLLOWUP_WAIT_MESSAGE/);
});

// ---- per-patient sessions ------------------------------------------------------------------------

function memoryStorage() {
  const map = new Map();
  return { get length() { return map.size; }, key: (i) => [...map.keys()][i] ?? null, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), map };
}

test("each patient has a separate saved session under the same code: leaving one never overwrites another", () => {
  globalThis.localStorage = memoryStorage();
  const code = "SIM-ABCDEF12";
  session.saveSession(code, { caseId: "CASE-001", stage: "rationale1", messages: ["a"] });
  session.saveSession(code, { caseId: "CASE-002", stage: "anamnesis", messages: ["b"] });
  session.saveSession(code, { caseId: "CASE-001", stage: "interim", messages: ["a", "c"] });
  assert.equal(session.loadSession(code, "CASE-001").stage, "interim");
  assert.deepEqual(session.loadSession(code, "CASE-002").messages, ["b"], "the second patient is untouched");
  const list = session.listSessions(code);
  assert.deepEqual(list.map((s) => s.caseId).sort(), ["CASE-001", "CASE-002"]);
  assert.equal(list.find((s) => s.caseId === "CASE-001").stage, "interim");
  assert.equal(list.find((s) => s.caseId === "CASE-001").completed, false);
});

test("without a patient id the most recently saved session is restored, and a completed one is marked", () => {
  globalThis.localStorage = memoryStorage();
  const code = "SIM-ABCDEF12";
  session.saveSession(code, { caseId: "CASE-001", stage: "feedback", completed: true });
  const later = Date.now() + 5;
  const realNow = Date.now;
  Date.now = () => later;
  try { session.saveSession(code, { caseId: "CASE-003", stage: "examination" }); } finally { Date.now = realNow; }
  assert.equal(session.loadSession(code).caseId, "CASE-003");
  assert.equal(session.listSessions(code).find((s) => s.caseId === "CASE-001").completed, true);
});

test("restarting a patient deletes only that patient's session", () => {
  globalThis.localStorage = memoryStorage();
  const code = "SIM-ABCDEF12";
  session.saveSession(code, { caseId: "CASE-001", stage: "anamnesis" });
  session.saveSession(code, { caseId: "CASE-002", stage: "anamnesis" });
  session.deleteSession(code, "CASE-001");
  assert.deepEqual(session.listSessions(code).map((s) => s.caseId), ["CASE-002"]);
  assert.throws(() => session.loadSession(code, "CASE-001"), /לא נמצאה/);
});

test("a session saved by the previous version (one per code) is still found, and sessions of other codes stay separate", () => {
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  storage.setItem("clinical-sim-session:SIM-OLD00001", JSON.stringify({ expiresAt: Date.now() + 1e6, updatedAt: 1, payload: { caseId: "CASE-002", stage: "decision" } }));
  assert.equal(session.loadSession("SIM-OLD00001").stage, "decision");
  assert.deepEqual(session.listSessions("SIM-OLD00001").map((s) => s.caseId), ["CASE-002"]);
  session.deleteSession("SIM-OLD00001", "CASE-002");
  assert.deepEqual(session.listSessions("SIM-OLD00001"), []);
  assert.deepEqual(session.listSessions("bad-code"), []);
  session.saveSession("SIM-ONE00001", { caseId: "CASE-001", stage: "a" });
  assert.deepEqual(session.listSessions("SIM-TWO00001"), []);
});

test("the screen offers a way home from every stage and from the end of the process, and the opening screen shows each patient's status", () => {
  const app = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /stage !== "welcome" && <button type="button" className="home-button" onClick=\{goHome\}>← חזרה למסך הפתיחה/);
  assert.match(app, /חזרה למסך הפתיחה \(לטיפול במטופל אחר\)/);
  assert.match(app, /המשך מהמקום שעצרת/);
  assert.match(app, /התחל מחדש/);
  assert.match(app, /saveSession\(code, \{ caseId, stage/, "progress is saved before leaving");
});

// ---- stage 15 labels ---------------------------------------------------------------------------------

test("the feedback screen says what the button does and explains a short report", () => {
  const app = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /הפקת משוב מלא על כל השלבים/);
  assert.match(app, /קיבלת משוב מקוצר/);
  assert.doesNotMatch(app, /הפק\/עדכן משוב/);
});

// ---- teacher setup page -----------------------------------------------------------------------------

test("the setup page protects the key field from browser autofill and styles links as links", () => {
  const setup = fs.readFileSync(new URL("../src/TeacherSetup.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(setup, /type=\{showKey \? "text" : "password"\}/, "no password-type field: browsers offer saved passwords there");
  assert.match(setup, /name="class-secret-value"/);
  assert.match(setup, /autoComplete="off"/);
  assert.match(setup, /className="text-link"/);
  const css = fs.readFileSync(new URL("../src/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.text-link[^}]*text-decoration:underline/);
  assert.match(css, /\.secret-input\{-webkit-text-security:disc/);
});

test("the model fields: one field by default, per-part models under an advanced section with explanations", () => {
  const setup = fs.readFileSync(new URL("../src/TeacherSetup.tsx", import.meta.url), "utf8");
  assert.match(setup, /מודל \(לא חובה\)/);
  assert.match(setup, /<details className="models">/);
  for (const text of ["זיהוי השאלה", "תשובת המטופל", "משוב", "נקרא בכל שאלה"]) assert.ok(setup.includes(text), text);
});

test("a key that does not look like the provider's key gets a warning; a matching one does not", () => {
  const openai = getProvider("openai");
  assert.match(keyFormatWarning(openai, "MyPassword123!"), /לא נראה כמו מפתח של OpenAI/);
  assert.equal(keyFormatWarning(openai, "sk-proj-abcdefghijklmnop"), null);
  assert.equal(keyFormatWarning(getProvider("gemini"), "AIzaSyExampleExampleExample1234567890"), null);
  assert.ok(keyFormatWarning(getProvider("gemini"), "hunter2"));
  assert.ok(keyFormatWarning(getProvider("mistral"), "short"), "short value for a provider without prefix");
  assert.equal(keyFormatWarning(getProvider("mistral"), "a".repeat(32)), null);
  assert.equal(keyFormatWarning(openai, ""), null);
  assert.equal(keyFormatWarning(openai, "   "), null);
});

test("teachers see the recommended, really tested provider first; untested ones last and labelled", () => {
  const list = providersForTeachers();
  assert.equal(list[0].id, "gemini");
  assert.match(providerLabel(list[0]), /\(מומלץ\)/);
  const untestedStart = list.findIndex((p) => p.status === "untested");
  assert.ok(list.slice(untestedStart).every((p) => p.status === "untested"), "all untested providers come last");
  assert.match(providerLabel(getProvider("xai")), /\(לא נבדק\)/);
  assert.match(providerLabel(getProvider("groq")), /מכסה חינמית נמוכה/);
  for (const provider of providers.filter((p) => p.recommended)) assert.notEqual(provider.status, "untested", "only tested providers may be recommended");
});

// ---- provider errors ------------------------------------------------------------------------------------

test("the provider's error text is found in every common format", () => {
  assert.equal(errorText({ error: { message: "bad key" } }), "bad key");
  assert.equal(errorText({ error: "Incorrect API key provided", code: "Client specified an invalid argument" }), "Incorrect API key provided", "xAI style: error is a string");
  assert.equal(errorText({ code: "Some error code only" }), "Some error code only");
  assert.equal(errorText({ message: "plain message" }), "plain message");
  assert.equal(errorText({ detail: "validation failed" }), "validation failed");
  assert.equal(errorText({}), null);
  assert.equal(errorText(null), null);
  assert.equal(errorText({ error: "x".repeat(1000) }).length, 300, "long texts are cut");
});

test("an xAI-style 400 now shows its real reason instead of an unreadable reply", async () => {
  script({ status: 400, payload: { code: "Client specified an invalid argument", error: "Invalid role: developer" } });
  await assert.rejects(complete({ providerId: "xai", apiKey: KEY, retryDelayMs: 0 }, { role: "response", system: "s", user: "u", maxOutputTokens: 10 }), (error) => /Invalid role: developer/.test(error.detail));
});

test("xAI uses the documented system role; OpenAI keeps developer", () => {
  const request = { role: "response", system: "SYS", user: "USR", maxOutputTokens: 10 };
  assert.equal(buildResponsesBody(getProvider("xai"), "m", request).input[0].role, "system");
  assert.equal(buildResponsesBody(getProvider("openai"), "m", request).input[0].role, "developer");
});

test("a daily limit is reported differently from a per-minute limit", async () => {
  const kind = async (message) => { script({ status: 429, payload: { error: { message } } }); try { await complete({ providerId: "groq", apiKey: KEY, retryDelayMs: 0 }, { role: "response", system: "s", user: "u", maxOutputTokens: 10 }); } catch (error) { return error; } };
  const daily = await kind("Rate limit reached for model x on tokens per day (TPD): Limit 200000, Used 199900");
  assert.equal(daily.kind, "daily_quota");
  assert.equal(daily.message, failureMessages.daily_quota);
  assert.match(daily.message, /מחר/);
  assert.equal((await kind("Quota exceeded for metric: GenerateRequestsPerDayPerProjectPerModel-FreeTier")).kind, "daily_quota");
  assert.equal((await kind("Rate limit reached on tokens per minute (TPM): Limit 8000")).kind, "rate_limit");
  assert.equal((await kind("You have no credits remaining")).kind, "quota");
});

// ---- connection check -------------------------------------------------------------------------------------

test("the connection check tests every distinct model, once each, and reports which one failed", async () => {
  let calls = script(ok());
  await testConnection({ providerId: "openai", apiKey: KEY });
  assert.deepEqual(calls.map((c) => c.body.model).sort(), ["gpt-5-mini", "gpt-5.6"], "OpenAI's defaults use two different models");
  calls = script(ok());
  await testConnection({ providerId: "openai", apiKey: KEY, models: { classifier: "m", response: "m", feedback: "m" } });
  assert.equal(calls.length, 1, "identical models are tested once");
  calls = script(ok());
  await testConnection({ providerId: "openai", apiKey: KEY, models: { classifier: "a", response: "b", feedback: "c" } });
  assert.deepEqual(calls.map((c) => c.body.model), ["a", "b", "c"]);

  globalThis.fetch = async (_url, init) => {
    const model = JSON.parse(init.body).model;
    return model === "bad-classifier" ? new Response(JSON.stringify({ error: { message: "The model does not exist" } }), { status: 404 }) : new Response(JSON.stringify({ output_text: "בסדר" }), { status: 200 });
  };
  await assert.rejects(testConnection({ providerId: "openai", apiKey: KEY, models: { classifier: "bad-classifier", response: "fine", feedback: "fine" } }), (error) => error.kind === "model" && error.message.includes("המודל שנבדק: bad-classifier") && error.message.includes("does not exist"));
});

test("the connection check does not echo the key", async () => {
  script({ status: 401, payload: { error: { message: "Incorrect API key provided" } } });
  await assert.rejects(testConnection({ providerId: "openai", apiKey: KEY }), (error) => !error.message.includes(KEY));
});

// ---- feedback retry ------------------------------------------------------------------------------------------

const domains = ["אנמנזה", "בדיקה גופנית", "בדיקות בסיסיות", "בדיקות המשך והנמקות", "חשיבה אבחנתית והחלטות", "רשומה רפואית", "הסבר למטופל"];
const fullReport = Object.fromEntries(domains.map((name) => [name, { good: ["טוב"], reconsider: ["לשקול"] }]));
const caseFile = readCaseFile(availableCases[0].file);
const feedbackConfig = { providerId: "openai", apiKey: KEY, retryDelayMs: 0 };

test("a malformed first report is retried once and the student gets the full report, not the short one", async () => {
  const calls = script({ status: 200, payload: { output_text: "{not json" } }, { status: 200, payload: { output_text: JSON.stringify(fullReport) } });
  const feedback = await generateFeedback(feedbackConfig, caseFile, { caseId: "CASE-001" });
  assert.equal(calls.length, 2);
  assert.deepEqual(Object.keys(feedback), domains);
});

test("only when both full attempts fail does the short report appear", async () => {
  const calls = script({ status: 200, payload: { output_text: "{not json" } }, { status: 200, payload: { output_text: "{still not" } }, { status: 200, payload: { output_text: "חוזקות:\n- א\nלשיפור:\n- ב" } });
  const feedback = await generateFeedback(feedbackConfig, caseFile, { caseId: "CASE-001" });
  assert.equal(calls.length, 3);
  assert.deepEqual(Object.keys(feedback), ["משוב פרופ׳ שחף"]);
});

test("a rejected key or exhausted quota is not retried for feedback", async () => {
  for (const status of [401, 429]) {
    const calls = script({ status, payload: { error: { message: "denied" } } });
    await assert.rejects(generateFeedback(feedbackConfig, caseFile, { caseId: "CASE-001" }));
    assert.equal(calls.length, 1, String(status));
  }
});

test("the opening hint for the short report is only shown for a single-heading report", () => {
  const app = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /Object\.keys\(feedback!\)\.length === 1/);
});
