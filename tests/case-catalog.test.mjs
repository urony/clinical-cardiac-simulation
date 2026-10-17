// Validates data/cases/index.json against the case files, so a bad catalogue entry fails here
// instead of reaching students. Adding a case must not require editing application code.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

const casesDir = new URL("../data/cases/", import.meta.url);
const catalogue = JSON.parse(fs.readFileSync(new URL("index.json", casesDir), "utf8"));
const readCase = (file) => JSON.parse(fs.readFileSync(new URL(file, casesDir), "utf8"));
const metaOf = (caseFile) => Object.fromEntries(caseFile.sheets["מטא_מקרה"].filter((row) => row[0]).map((row) => [row[0], row[1]]));

test("catalogue has a supported schema version and at least one case", () => {
  assert.equal(catalogue.schemaVersion, 1);
  assert.ok(catalogue.cases.length >= 1);
});

test("every catalogue entry has the required fields and a unique id", () => {
  const ids = new Set();
  for (const entry of catalogue.cases) {
    for (const key of ["id", "file", "initials", "sex", "demographics", "chiefComplaint"]) assert.ok(typeof entry[key] === "string" && entry[key].trim(), `${entry.id}: missing ${key}`);
    assert.ok(Number.isInteger(entry.age) && entry.age > 0, `${entry.id}: age`);
    assert.match(entry.id, /^CASE-\d{3,}$/);
    assert.ok(!ids.has(entry.id), `duplicate case id ${entry.id}`);
    ids.add(entry.id);
    if (entry.maxAnamnesisFacts !== undefined) assert.ok(Number.isInteger(entry.maxAnamnesisFacts) && entry.maxAnamnesisFacts >= 1);
  }
});

test("each entry points to an existing case file whose own metadata agrees", () => {
  for (const entry of catalogue.cases) {
    const meta = metaOf(readCase(entry.file));
    assert.equal(meta["מזהה מקרה"], entry.id, `${entry.file}: case id differs from catalogue`);
    assert.equal(meta["ראשי תיבות מטופל"], entry.initials);
    assert.equal(meta["מין"], entry.sex);
    assert.equal(Number(meta["גיל"]), entry.age);
  }
});

test("no case file is left out of the catalogue, and no file is listed twice", () => {
  const onDisk = fs.readdirSync(casesDir).filter((name) => /^case-.*\.json$/.test(name)).sort();
  assert.deepEqual(catalogue.cases.map((entry) => entry.file).sort(), onDisk);
});

test("catalogue exposes no clinical facts (diagnosis, persona) to the browser", () => {
  const text = JSON.stringify(catalogue);
  for (const entry of catalogue.cases) {
    const meta = metaOf(readCase(entry.file));
    for (const secret of [meta["אבחנה ידועה למערכת"], meta["פרסונה קצרה"], meta["אמת קלינית"]]) assert.ok(!text.includes(secret), "catalogue leaks case data");
  }
});

test("each case file has the sheets the simulation reads", () => {
  for (const entry of catalogue.cases) {
    const sheets = readCase(entry.file).sheets;
    for (const name of ["מטא_מקרה", "אנמנזה", "בדיקה_גופנית", "בדיקות_מיידיות", "בדיקות_המשך", "כללי_משוב"]) assert.ok(sheets[name]?.length, `${entry.id}: missing sheet ${name}`);
  }
});
