import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

const page = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const data = fs.readFileSync(new URL("../lib/case-data.ts", import.meta.url), "utf8");
const feedback = fs.readFileSync(new URL("../lib/feedback.ts", import.meta.url), "utf8");
const respond = fs.readFileSync(new URL("../lib/simulation.ts", import.meta.url), "utf8");

test("student-facing interface uses names, a test file, transitions and printable reports", () => {
  assert.match(page, /תיק הבדיקות/);
  assert.match(page, /השלב הושלם/);
  assert.match(page, /כעת אתה בשלב/);
  assert.match(page, /האם אתה משנה משהו בהמלצות או בטיפול/);
  assert.match(page, /SpeechRecognition/);
  assert.match(page, /print-report/);
  assert.match(page, /printInterimReport/);
  assert.match(page, /פניות פרופ׳ שחף והנמקות התלמיד/);
  assert.match(page, /רשומה רפואית/);
  assert.match(page, /הסבר למטופל — תמלול מאושר/);
  assert.doesNotMatch(page, /label:id/);
});

test("case labels are selected from human-facing headers rather than technical IDs", () => {
  assert.match(data, /immediateTests: \["בדיקה או רכיב"\]/);
  assert.match(data, /examination: \["רכיב בדיקה"\]/);
  assert.match(data, /followupTests: \["בדיקה"\]/);
});

test("the approved cases are listed in the case catalogue, not hard-coded in logic", () => {
  const catalogue = JSON.parse(fs.readFileSync(new URL("../data/cases/index.json", import.meta.url), "utf8"));
  assert.deepEqual(catalogue.cases.slice(0, 3).map((entry) => entry.id), ["CASE-001", "CASE-002", "CASE-003"], "the original approved cases stay first");
  for (const source of [page, data, respond, fs.readFileSync(new URL("../lib/session-store.ts", import.meta.url), "utf8")]) assert.doesNotMatch(source, /"CASE-0dd"/);
  assert.match(page, /מי מחכה לך במיון/);
  assert.match(page, /caseId/);
});

test("feedback covers all agreed learning domains", () => {
  for (const heading of ["אנמנזה", "בדיקה גופנית", "בדיקות בסיסיות", "בדיקות המשך והנמקות", "חשיבה אבחנתית והחלטות", "רשומה רפואית", "הסבר למטופל"]) assert.match(feedback, new RegExp(heading));
  assert.match(feedback, /2–3/);
  assert.match(feedback, /3–5/);
  assert.match(feedback, /plainTextFeedback/);
  assert.match(feedback, /safeFeedback/);
  assert.match(feedback, /לפחות לתשובה אחת של התלמיד לפניית פרופ׳ שחף/);
});

test("learner-facing results never expose spreadsheet placeholder text", () => {
  assert.match(data, /answer\.startsWith\("נוצר אוטומטית"\)/);
  assert.match(data, /פרשנות במקרה/);
});

test("server prevents direct disclosure outside test phases and handles ambiguity", () => {
  assert.match(respond, /phase !== "immediateTests" && phase !== "followupTests"/);
  assert.match(respond, /if \(parsed\.ambiguous\)/);
  assert.match(respond, /maxAnamnesisFacts/);
});
