// Tests for the provider-neutral layer. The provider is a fake `fetch`; no network, no real key.
// These check the request each provider type RECEIVES, not that the real services accept it —
// only OpenAI is a previously used path; every other provider is still untested against the live service.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { loadLib } from "./helpers/load-lib.mjs";

const { client, providers: registry } = await loadLib();
const { providers, getProvider } = registry;
const { complete, buildResponsesBody, buildChatBody, SimulationError } = client;

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

const schema = { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } }, required: ["ok"] };
const request = { role: "classifier", system: "SYSTEM TEXT", user: "USER TEXT", maxOutputTokens: 321, json: { name: "demo", schema } };

function fake(status, payload) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  };
  return calls;
}

test("every provider has the required fields, an https URL and a model for each role", () => {
  const ids = new Set();
  for (const provider of providers) {
    assert.ok(!ids.has(provider.id), `duplicate provider ${provider.id}`);
    ids.add(provider.id);
    assert.ok(["openai-responses", "openai-chat"].includes(provider.protocol), provider.id);
    assert.match(provider.baseUrl, /^https:\/\/[^/]+/);
    assert.ok(!provider.baseUrl.endsWith("/"), "base URL must not end with a slash");
    assert.ok(["json_schema", "json_object"].includes(provider.structuredOutput));
    assert.ok(["in-use", "untested"].includes(provider.status));
    for (const role of ["classifier", "response", "feedback"]) assert.ok(provider.defaultModels[role], `${provider.id}.${role}`);
  }
  assert.ok(getProvider("openai") && getProvider("groq") && !getProvider("nope"));
});

test("simulation logic and client code contain no provider URLs or model names", () => {
  for (const file of ["simulation.ts", "feedback.ts", "ai-client.ts"]) {
    const source = fs.readFileSync(new URL(`../lib/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /gpt-|grok-|gemini-|mistral-|https:\/\/api\./i, `${file} hard-codes provider details`);
  }
});

test("the OpenAI request has exactly the shape the app sent before the provider layer existed", () => {
  const body = buildResponsesBody(getProvider("openai"), "M", request);
  assert.deepEqual(body, {
    model: "M", reasoning: { effort: "low" }, max_output_tokens: 321,
    input: [{ role: "developer", content: [{ type: "input_text", text: "SYSTEM TEXT" }] }, { role: "user", content: [{ type: "input_text", text: "USER TEXT" }] }],
    text: { format: { type: "json_schema", name: "demo", strict: true, schema } },
  });
  assert.equal("text" in buildResponsesBody(getProvider("openai"), "M", { ...request, json: undefined }), false);
});

test("a Responses provider without reasoning-effort support does not send that field", () => {
  assert.equal("reasoning" in buildResponsesBody(getProvider("xai"), "M", request), false);
});

test("chat-completions providers get system/user messages, a token limit and JSON mode with the schema in the prompt", () => {
  const body = buildChatBody(getProvider("groq"), "M", request);
  assert.equal(body.max_tokens, 321);
  assert.deepEqual(body.messages[1], { role: "user", content: "USER TEXT" });
  assert.match(body.messages[0].content, /^SYSTEM TEXT/);
  assert.ok(body.messages[0].content.includes(JSON.stringify(schema)));
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal("response_format" in buildChatBody(getProvider("groq"), "M", { ...request, json: undefined }), false);
});

test("complete() calls the right URL with the right body per protocol and returns the text", async () => {
  let calls = fake(200, { output_text: "hello" });
  assert.equal(await complete({ providerId: "openai", apiKey: "k1" }, request), "hello");
  assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
  assert.equal(calls[0].headers.Authorization, "Bearer k1");
  assert.equal(calls[0].body.model, getProvider("openai").defaultModels.classifier);

  calls = fake(200, { choices: [{ message: { content: " hi " } }] });
  assert.equal(await complete({ providerId: "groq", apiKey: "k2" }, request), "hi");
  assert.equal(calls[0].url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(calls[0].body.model, getProvider("groq").defaultModels.classifier);
});

test("a teacher-chosen model overrides the recommended one, per role", async () => {
  const calls = fake(200, { output_text: "x" });
  await complete({ providerId: "openai", apiKey: "k", models: { classifier: "my-model" } }, request);
  await complete({ providerId: "openai", apiKey: "k", models: { classifier: "my-model" } }, { ...request, role: "response" });
  assert.equal(calls[0].body.model, "my-model");
  assert.equal(calls[1].body.model, getProvider("openai").defaultModels.response);
});

test("errors are classified: bad key, quota, rate limit, bad reply, network, unknown provider, missing key", async () => {
  const kindOf = async (config, status, payload) => {
    if (status) fake(status, payload);
    try { await complete(config, request); return "no error"; } catch (error) { assert.ok(error instanceof SimulationError); return error.kind; }
  };
  const openai = { providerId: "openai", apiKey: "k" };
  assert.equal(await kindOf(openai, 401, { error: { message: "Incorrect API key" } }), "auth");
  assert.equal(await kindOf(openai, 429, { error: { message: "You have no credits remaining" } }), "quota");
  assert.equal(await kindOf(openai, 429, { error: { message: "Too many requests" } }), "rate_limit");
  assert.equal(await kindOf({ providerId: "groq", apiKey: "k" }, 500, { error: { message: "boom" } }), "provider");
  assert.equal(await kindOf(openai, 200, { output_text: "" }), "bad_response");
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  assert.equal(await kindOf(openai), "network");
  assert.equal(await kindOf({ providerId: "unknown", apiKey: "k" }), "config");
  assert.equal(await kindOf({ providerId: "openai", apiKey: "" }), "config");
});

test("the provider's own message is kept in the error so the cause is visible", async () => {
  fake(429, { error: { message: "You have no credits remaining" } });
  await assert.rejects(complete({ providerId: "openai", apiKey: "k" }, request), /OpenAI API \(429\): You have no credits remaining/);
  fake(401, { error: { message: "bad key" } });
  await assert.rejects(complete({ providerId: "groq", apiKey: "k" }, request), /Groq API \(401\): bad key/);
});

test("text shown to teachers is Hebrew: every provider has a notes line and a data notice", () => {
  for (const provider of providers) {
    assert.match(provider.notes, /[\u0590-\u05FF]/, `${provider.id}.notes`);
    assert.match(provider.dataNotice, /[\u0590-\u05FF]/, `${provider.id}.dataNotice`);
  }
});
