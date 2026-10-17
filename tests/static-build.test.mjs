// Checks the built static site (run `npm run build` first; `npm test` does both).
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

const dist = new URL("../dist/", import.meta.url);
const html = fs.readFileSync(new URL("index.html", dist), "utf8");
const assets = fs.readdirSync(new URL("assets/", dist));
const read = (name) => fs.readFileSync(new URL(`assets/${name}`, dist), "utf8");

test("the built page has the application title, RTL Hebrew and relative asset paths", () => {
  assert.match(html, /<title>המרפאה הקרדיולוגית הווירטואלית<\/title>/);
  assert.match(html, /lang="he" dir="rtl"/);
  assert.doesNotMatch(html, /(src|href)="\//, "absolute paths would break on a GitHub Pages project site");
});

test("each case is its own lazily loaded chunk, not part of the main script", () => {
  const main = assets.find((name) => /^index-.*\.js$/.test(name));
  assert.ok(main);
  const catalogue = JSON.parse(fs.readFileSync(new URL("../data/cases/index.json", import.meta.url), "utf8"));
  assert.equal(assets.filter((name) => /^case-\d+-.*\.js$/.test(name)).length, catalogue.cases.length, "one chunk per catalogued case");
  assert.doesNotMatch(read(main), /אבחנה ידועה למערכת/, "case facts must not be inlined in the main bundle");
});

test("no server runtime is shipped: no Cloudflare, no API routes, no custom key header", () => {
  assert.ok(!fs.existsSync(new URL("server", dist)));
  const all = assets.filter((name) => name.endsWith(".js")).map(read).join("\n");
  assert.doesNotMatch(all, /\/api\/simulation|\/api\/session|cloudflare:workers|x-pilot-openai-key/i);
});
