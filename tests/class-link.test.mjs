// Tests for class links (teacher settings carried in the URL fragment) and the soft usage limits.
// No network and no real key: the provider is a fake `fetch`.
import assert from "node:assert/strict";
import test from "node:test";
import { loadLib } from "./helpers/load-lib.mjs";

const lib = await loadLib();
const { buildClassLink, encodeConfig, parseHash, validateConfig, createCallBudget, callsUsed, newClassId } = lib.classLink;
const { complete, testConnection } = lib.client;

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

const FAKE_KEY = "fake-key-1234567890";
const base = () => ({ version: 1, classId: "abcd1234", providerId: "openai", apiKey: FAKE_KEY });
const hashOf = (config) => `#c=${encodeConfig(config)}`;
const wireHash = (wire) => `#c=${Buffer.from(JSON.stringify(wire), "utf8").toString("base64url")}`;

test("a config round-trips through the link, including Hebrew names, models and limits", () => {
  const config = { ...base(), className: "י׳ 2 ביולוגיה", models: { classifier: "m-a", response: "m-b" }, expiresAt: Date.now() + 86400000, maxCalls: 150, maxPerMinute: 12, maxOutputTokens: 500 };
  const link = buildClassLink("https://example.github.io/sim/#old", config);
  assert.match(link, /^https:\/\/example\.github\.io\/sim\/#c=[A-Za-z0-9_-]+$/);
  const parsed = parseHash(link.slice(link.indexOf("#")));
  assert.equal(parsed.status, "ok");
  assert.deepEqual(parsed.config, { ...config, models: { classifier: "m-a", response: "m-b" } });
});

test("the key lives only in the fragment, never in the path or query", () => {
  const link = buildClassLink("https://example.github.io/sim/", base());
  const [beforeHash] = link.split("#");
  assert.ok(!beforeHash.includes(FAKE_KEY) && !beforeHash.includes("c="));
});

test("plain hashes and other routes are not class links", () => {
  for (const hash of ["", "#", "#/setup", "#c=", "#x=abc", "#c=abc#d"]) assert.equal(parseHash(hash).status, "none", hash);
});

test("corrupt, oversize or unsupported links are rejected, not partially used", () => {
  assert.equal(parseHash("#c=!!!").status, "none");
  assert.equal(parseHash("#c=AAAA").status, "invalid");
  assert.equal(parseHash(wireHash({ v: 2, i: "abcd1234", p: "openai", k: FAKE_KEY })).status, "invalid");
  assert.equal(parseHash(`#c=${"A".repeat(5000)}`).status, "invalid");
  assert.equal(parseHash(wireHash({ v: 1, i: "abcd1234", p: "no-such-provider", k: FAKE_KEY })).status, "invalid");
});

test("fields are validated: key characters, ids, models, limits", () => {
  assert.equal(validateConfig(base()), null);
  for (const bad of [
    { ...base(), apiKey: "short" }, { ...base(), apiKey: "has a space inside" }, { ...base(), apiKey: "line\nbreak-key-12345" },
    { ...base(), classId: "BAD ID" }, { ...base(), models: { classifier: "bad model name" } }, { ...base(), className: "x".repeat(61) },
    { ...base(), maxCalls: 0 }, { ...base(), maxCalls: 1.5 }, { ...base(), maxPerMinute: 0 }, { ...base(), maxOutputTokens: 50 }, { ...base(), expiresAt: NaN },
  ]) assert.notEqual(validateConfig(bad), null, JSON.stringify(bad));
  assert.throws(() => encodeConfig({ ...base(), apiKey: "x" }));
});

test("a link cannot redirect requests: any base URL in the link is ignored", () => {
  const parsed = parseHash(wireHash({ v: 1, i: "abcd1234", p: "openai", k: FAKE_KEY, b: "https://evil.example", baseUrl: "https://evil.example" }));
  assert.equal(parsed.status, "ok");
  assert.equal(JSON.stringify(parsed.config).includes("evil"), false);
});

test("an expired link is reported as expired and still carries no usable status", () => {
  const config = { ...base(), expiresAt: 1000 };
  assert.equal(parseHash(hashOf(config), 2000).status, "expired");
  assert.equal(parseHash(hashOf(config), 500).status, "ok");
});

test("class ids are random, short and valid", () => {
  const ids = new Set(Array.from({ length: 50 }, newClassId));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, /^[a-z0-9]{8}$/);
});

function memoryStorage() { const map = new Map(); return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) }; }

test("the call budget allows exactly maxCalls requests, then refuses with a teacher-limit error", () => {
  const storage = memoryStorage();
  const before = createCallBudget("abcd1234", { maxCalls: 3 }, storage);
  before(); before(); before();
  assert.equal(callsUsed("abcd1234", storage), 3);
  assert.throws(before, (error) => error.kind === "teacher_limit" && error.status === 429 && /מכסת הפניות/.test(error.message));
  assert.equal(callsUsed("abcd1234", storage), 3, "refused requests are not counted");
});

test("budgets are separate per class and unlimited when no limit is set", () => {
  const storage = memoryStorage();
  createCallBudget("class-a1", { maxCalls: 1 }, storage)();
  assert.doesNotThrow(() => createCallBudget("class-b1", { maxCalls: 1 }, storage)());
  const unlimited = createCallBudget("class-c1", {}, storage);
  for (let i = 0; i < 500; i++) unlimited();
});

test("without usable storage the soft limit does not block students", () => {
  assert.doesNotThrow(() => createCallBudget("abcd1234", { maxCalls: 1 }, undefined)());
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.doesNotThrow(() => createCallBudget("abcd1234", { maxCalls: 1 }, broken)());
});

test("complete() consults the budget before sending and applies the answer-length cap", async () => {
  const bodies = [];
  globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ output_text: "ok" }), { status: 200 }); };
  const storage = memoryStorage();
  const config = { providerId: "openai", apiKey: FAKE_KEY, maxOutputTokens: 200, beforeCall: createCallBudget("abcd1234", { maxCalls: 1 }, storage) };
  const request = { role: "response", system: "s", user: "u", maxOutputTokens: 650 };
  await complete(config, request);
  assert.equal(bodies[0].max_output_tokens, 200, "cap lowers the limit");
  await complete({ ...config, maxOutputTokens: 5000 }, { ...request, maxOutputTokens: 650, role: "response" }).then(
    () => assert.fail("second call should be refused"),
    (error) => assert.equal(error.kind, "teacher_limit"));
  assert.equal(bodies.length, 1, "a refused call never reaches the provider");
});

test("a cap larger than the request never raises it", async () => {
  const bodies = [];
  globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ output_text: "ok" }), { status: 200 }); };
  await complete({ providerId: "openai", apiKey: FAKE_KEY, maxOutputTokens: 5000 }, { role: "response", system: "s", user: "u", maxOutputTokens: 650 });
  assert.equal(bodies[0].max_output_tokens, 650);
});

test("testConnection sends one short request per distinct model and ignores the class limits", async () => {
  const bodies = [];
  globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ output_text: "בסדר" }), { status: 200 }); };
  const storage = memoryStorage();
  await testConnection({ providerId: "openai", apiKey: FAKE_KEY, maxOutputTokens: 100, models: { classifier: "same", response: "same", feedback: "same" }, beforeCall: createCallBudget("abcd1234", { maxCalls: 1 }, storage) });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].max_output_tokens, 256);
  assert.equal(callsUsed("abcd1234", storage), 0, "the teacher's check does not use the students' budget");
});

test("testConnection reports a rejected key with the provider's message", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "Incorrect API key provided" } }), { status: 401 });
  await assert.rejects(testConnection({ providerId: "openai", apiKey: FAKE_KEY }), /Incorrect API key provided/);
});

test("the per-minute limit refuses a burst and frees up as time passes", () => {
  let clock = 1_000_000;
  const before = createCallBudget("rate0001", { maxPerMinute: 3, now: () => clock }, undefined);
  before(); before(); before();
  assert.throws(before, (error) => error.kind === "rate_limit" && error.status === 429);
  clock += 30_000;
  assert.throws(before, (error) => error.kind === "rate_limit", "still inside the same minute");
  clock += 31_000;
  assert.doesNotThrow(before);
});

test("an expired link refuses requests even if the page was opened before it expired", () => {
  let clock = 5000;
  const before = createCallBudget("expire01", { expiresAt: 6000, now: () => clock }, undefined);
  assert.doesNotThrow(before);
  clock = 6000;
  assert.throws(before, (error) => error.kind === "teacher_limit" && /פג תוקף/.test(error.message));
});
