// Checks the link to the API-key wizard and that the tool entry prepared for the wizard follows the
// wizard's own data rules (copied from its tools.schema.json) and does not overstate compatibility.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { loadLib } from "./helpers/load-lib.mjs";

const lib = await loadLib();
const { wizardLink } = lib.links;
const { providers } = lib.providers;
const read = (path) => JSON.parse(fs.readFileSync(new URL(path, import.meta.url), "utf8"));
const links = read("../data/links.json");
const entry = read("../docs/wizard-tool-entry.json");

// Provider ids the wizard knows (its data/providers.json, checked 2026-10-17).
const wizardProviderIds = ["gemini", "groq", "openrouter", "mistral", "openai", "xai"];
const protocolForWizard = { "openai-responses": "openai-responses", "openai-chat": "openai-chat-completions" };

test("the wizard link is https and carries the tool id", () => {
  const href = wizardLink();
  assert.ok(href, "a wizard URL is configured");
  const url = new URL(href);
  assert.equal(url.protocol, "https:");
  assert.equal(url.searchParams.get("tool"), links.toolId);
  assert.equal(links.toolId, entry.id);
});

test("the tool entry has every field the wizard requires, in the wizard's formats", () => {
  for (const key of ["id", "name", "owner", "description", "officialUrl", "supportedProviders", "protocols", "restrictedModels", "pasteInstructions", "compatibilityVerified"]) assert.ok(key in entry, key);
  assert.match(entry.id, /^[a-z0-9][a-z0-9-]{0,39}$/);
  assert.ok(entry.officialUrl === null || /^https:\/\//.test(entry.officialUrl));
  assert.ok(entry.compatibilityVerified === null || /^\d{4}-\d{2}-\d{2}$/.test(entry.compatibilityVerified));
  for (const protocol of entry.protocols) assert.ok(["native", "openai-chat-completions", "openai-responses"].includes(protocol), protocol);
});

test("listed providers exist in both the wizard and this app, and match the protocols declared", () => {
  for (const id of entry.supportedProviders) {
    assert.ok(wizardProviderIds.includes(id), `${id} unknown to the wizard`);
    const provider = providers.find((item) => item.id === id);
    assert.ok(provider, `${id} unknown to the simulator`);
    assert.ok(entry.protocols.includes(protocolForWizard[provider.protocol]), `${id} protocol not declared`);
  }
});

test("compatibility is not overstated: untested providers are only listed once a verification date exists", () => {
  for (const id of entry.supportedProviders) {
    const provider = providers.find((item) => item.id === id);
    if (provider.status !== "in-use") assert.ok(entry.compatibilityVerified, `${id} is untested but listed without a verification date`);
  }
});

test("the paste instructions tell the teacher the key is inside the class link", () => {
  assert.match(entry.pasteInstructions, /המפתח כלול בקישור/);
  assert.match(entry.pasteInstructions, /מפתח נפרד|מפתח חינמי/);
});
