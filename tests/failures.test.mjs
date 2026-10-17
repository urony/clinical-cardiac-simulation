// Failure handling: what a student sees when the provider is unreachable, slow, rejects the key,
// has no quota, or answers badly. Fake `fetch` only; no network and no real key.
import assert from "node:assert/strict";
import test from "node:test";
import { loadLib, readCaseFile } from "./helpers/load-lib.mjs";

const lib = await loadLib();
const { complete, testConnection, failureMessages, SimulationError } = lib.client;
const { generateFeedback } = lib.feedback;
const { runSimulationStep } = lib.simulation;
const { availableCases } = lib.catalog;

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

const config = { providerId: "openai", apiKey: "fake-key-1234567890", retryDelayMs: 0 };
const request = { role: "response", system: "s", user: "u", maxOutputTokens: 100 };
const hebrew = /[֐-׿]/;

/** Fake provider answering `steps` in order (a step is a status+payload, or an Error to throw). */
function script(...steps) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), signal: init.signal });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step instanceof Error) throw step;
    return new Response(JSON.stringify(step.payload ?? {}), { status: step.status ?? 200 });
  };
  return calls;
}
const ok = { status: 200, payload: { output_text: "תשובה" } };

test("every failure kind has a Hebrew message that does not claim the simulation is still running", () => {
  for (const [kind, message] of Object.entries(failureMessages)) {
    assert.match(message, hebrew, kind);
    assert.doesNotMatch(message, /[A-Za-z]{4,}/, `${kind} should not expose English wording`);
  }
  for (const kind of ["auth", "quota", "model"]) assert.match(failureMessages[kind], /לא יכולה להמשיך/, kind);
});

test("each HTTP failure maps to its own Hebrew message, with the provider's wording kept as detail", async () => {
  const cases = [
    [401, { error: { message: "Incorrect API key provided" } }, "auth"],
    [403, { error: { message: "forbidden" } }, "auth"],
    [429, { error: { message: "You have no credits remaining" } }, "quota"],
    [429, { error: { message: "Quota exceeded for metric" } }, "quota"],
    [429, { error: { message: "Rate limit reached, try again" } }, "rate_limit"],
    [404, { error: { message: "The model gpt-x does not exist" } }, "model"],
    [400, { error: { message: "Invalid model name" } }, "model"],
    [400, { error: { message: "bad request" } }, "provider"],
  ];
  for (const [status, payload, kind] of cases) {
    script({ status, payload });
    await assert.rejects(complete(config, request), (error) => {
      assert.ok(error instanceof SimulationError);
      assert.equal(error.kind, kind, `${status} ${payload.error.message}`);
      assert.equal(error.message, failureMessages[kind]);
      assert.ok(error.detail.includes(payload.error.message));
      return true;
    });
  }
});

test("a dropped connection or a 5xx is retried once, then succeeds", async () => {
  let calls = script(new TypeError("Failed to fetch"), ok);
  assert.equal(await complete(config, request), "תשובה");
  assert.equal(calls.length, 2);
  calls = script({ status: 503, payload: { error: { message: "overloaded" } } }, ok);
  assert.equal(await complete(config, request), "תשובה");
  assert.equal(calls.length, 2);
});

test("a persistent network or 5xx failure stops after two attempts with a clear message", async () => {
  let calls = script(new TypeError("Failed to fetch"));
  await assert.rejects(complete(config, request), (error) => error.kind === "network" && error.message === failureMessages.network);
  assert.equal(calls.length, 2);
  calls = script({ status: 500, payload: { error: { message: "boom" } } });
  await assert.rejects(complete(config, request), (error) => error.kind === "provider" && error.message === failureMessages.provider);
  assert.equal(calls.length, 2);
});

test("auth, quota, rate-limit and model errors are never retried", async () => {
  for (const status of [401, 429, 404]) {
    const calls = script({ status, payload: { error: { message: "x" } } });
    await assert.rejects(complete(config, request));
    assert.equal(calls.length, 1, `status ${status}`);
  }
});

test("a response that never arrives times out with a Hebrew message instead of hanging", async () => {
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => { init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))); });
  const started = Date.now();
  await assert.rejects(complete({ ...config, timeoutMs: 30 }, request), (error) => error.kind === "timeout" && error.message === failureMessages.timeout);
  assert.ok(Date.now() - started < 2000);
});

test("an empty 200 reply is reported as a bad response, not shown as an answer", async () => {
  script({ status: 200, payload: { output_text: "" } });
  await assert.rejects(complete(config, request), (error) => error.kind === "bad_response" && error.message === failureMessages.bad_response);
});

test("the simulation step surfaces the Hebrew failure and never returns a made-up answer", async () => {
  script({ status: 429, payload: { error: { message: "You have no credits remaining" } } });
  const entry = availableCases[0];
  await assert.rejects(runSimulationStep({ config, entry, caseFile: readCaseFile(entry.file) }, { phase: "anamnesis", question: "מה מפריע לך?" }), (error) => error.message === failureMessages.quota);
});

test("feedback does not waste a second request when the key or quota is the problem", async () => {
  const caseFile = readCaseFile(availableCases[0].file);
  for (const status of [401, 429]) {
    const calls = script({ status, payload: { error: { message: "denied" } } });
    await assert.rejects(generateFeedback(config, caseFile, { caseId: "CASE-001" }), (error) => error instanceof SimulationError);
    assert.equal(calls.length, 1, `status ${status}`);
  }
});

test("feedback still falls back to plain text when the structured reply is unusable", async () => {
  const caseFile = readCaseFile(availableCases[0].file);
  const calls = script({ status: 200, payload: { output_text: "not json at all" } }, { status: 200, payload: { output_text: "חוזקות:\n- טוב\nלשיפור:\n- לשפר" } });
  const feedback = await generateFeedback(config, caseFile, { caseId: "CASE-001" });
  assert.equal(calls.length, 2);
  assert.ok(feedback["משוב פרופ׳ שחף"]);
});

test("the teacher's connection check shows both the Hebrew explanation and the provider's own wording", async () => {
  script({ status: 401, payload: { error: { message: "Incorrect API key provided" } } });
  await assert.rejects(testConnection(config), (error) => error.message.includes(failureMessages.auth) && error.message.includes("Incorrect API key provided"));
});

test("error text never contains the API key", async () => {
  script({ status: 401, payload: { error: { message: "Incorrect API key provided" } } });
  await assert.rejects(complete(config, request), (error) => !JSON.stringify([error.message, error.detail]).includes(config.apiKey));
});
