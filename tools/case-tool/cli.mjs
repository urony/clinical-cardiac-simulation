#!/usr/bin/env node
// Local case-creation tool. Runs only on the author's computer; it is not part of the published site.
//   node tools/case-tool/cli.mjs help
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { draftCase, planDraft } from "./draft.mjs";
import { applyPublish, nextCaseId, planPublish } from "./publish.mjs";
import { validateCase } from "./case-validation.mjs";
import { runXlsxTool } from "./python.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const templatePath = path.join(root, "data", "template", "case-template.json");
const templateXlsx = path.join(root, "data", "template", "clinical-simulation-case-template-v2-he.xlsx");
const indexPath = path.join(root, "data", "cases", "index.json");

const HELP = `כלי יצירת מקרים מקומי (רץ אצלך בלבד)

  brief <שם>                        יוצר drafts/<שם>/brief.md מתבנית לתיאור המקרה
  draft <brief.md> [--case CASE-004] [--yes]
                                    ה-AI ממלא את תבנית ה-Excel ל*טיוטה* (בלי --yes רק מציג מה ייעשה ומה העלות)
  approve <קובץ.xlsx>               אחרי סקירה אנושית: הופך סטטוס "טיוטה" ל"מאושר" (קובץ חדש)
  validate <קובץ.xlsx> [--chief-complaint "..."]
                                    בודק שהמקרה שלם ותקין
  publish <קובץ.xlsx> --chief-complaint "..." [--yes] [--replace]
                                    מוסיף את המקרה לאתר (בלי --yes רק מציג תוכנית). לא מבצע commit.

משתני סביבה ל-draft: CASE_TOOL_API_KEY (חובה), CASE_TOOL_PROVIDER (ברירת מחדל openai), CASE_TOOL_MODEL (לא חובה).
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) { positional.push(argv[i]); continue; }
    const name = argv[i].slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { flags[name] = next; i += 1; } else flags[name] = true;
  }
  return { positional, flags };
}

const fail = (message) => { console.error(`שגיאה: ${message}`); process.exit(1); };

function convertToJson(xlsx) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "case-tool-")), "case.json");
  runXlsxTool(["convert", xlsx, out]);
  return read(out);
}

function printIssues({ errors, warnings }) {
  for (const line of errors) console.log(`  ✖ ${line}`);
  for (const line of warnings) console.log(`  ! ${line}`);
  console.log(`${errors.length} שגיאות, ${warnings.length} אזהרות`);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, target] = positional;

  if (!command || command === "help") { console.log(HELP); return; }

  if (command === "brief") {
    if (!target) fail("נדרש שם: brief <שם>");
    const dir = path.join(root, "drafts", target);
    const file = path.join(dir, "brief.md");
    if (fs.existsSync(file)) fail(`${file} כבר קיים`);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(root, "docs", "case-brief-template.md"), file);
    console.log(`נוצר ${path.relative(root, file)}. מלאו אותו ואז הריצו: draft ${path.relative(root, file)}`);
    return;
  }

  if (command === "draft") {
    if (!target) fail("נדרש קובץ תיאור: draft <brief.md>");
    const brief = fs.readFileSync(target, "utf8");
    const template = read(templatePath);
    const caseId = typeof flags.case === "string" ? flags.case : nextCaseId(read(indexPath));
    if (!/^CASE-\d{3,}$/.test(caseId)) fail(`מזהה מקרה לא תקין: ${caseId}`);
    const plan = planDraft(template);
    console.log(`מקרה: ${caseId}\nקריאות מתוכננות למודל: ${plan.calls} (ללא ניסיונות חוזרים)`);
    for (const step of plan.steps) console.log(`  ${step.sheet}: ${step.items} פריטים, ${step.calls} קריאות`);
    const provider = process.env.CASE_TOOL_PROVIDER || "openai";
    if (!flags.yes) {
      console.log(`\nזוהי תוכנית בלבד. הרצה ממשית שולחת את תיאור המקרה והטיוטה לספק "${provider}" במפתח CASE_TOOL_API_KEY שלך, ועולה כסף לפי התעריף שלו.\nכדי להמשיך הוסיפו --yes`);
      return;
    }
    const { completeFromEnv } = await import("./load-ai.mjs");
    let ai;
    try { ai = await completeFromEnv(); } catch (error) { fail(error.message); }
    console.log(`\nשולח ל-${ai.providerName}...`);
    const fills = await draftCase({
      brief, template, caseId, complete: ai.complete,
      onProgress: ({ sheet, items, attempt }) => console.log(`  ${sheet}: ${items} פריטים${attempt > 1 ? " (ניסיון חוזר)" : ""}`),
    });
    const outDir = path.join(root, "drafts", caseId);
    fs.mkdirSync(outDir, { recursive: true });
    const fillsPath = path.join(outDir, "fills.json");
    fs.writeFileSync(fillsPath, JSON.stringify(fills, null, 2), "utf8");
    const draftXlsx = path.join(outDir, `${caseId}-draft.xlsx`);
    console.log(runXlsxTool(["fill", templateXlsx, fillsPath, draftXlsx]));
    if (fills.problems.length) { console.log("בעיות (פריטים שלא מולאו):"); fills.problems.forEach((line) => console.log(`  - ${line}`)); }
    console.log(`\nהטיוטה נשמרה: ${path.relative(root, draftXlsx)}\nפתחו ב-Excel, עברו על כל הפרטים הקליניים (תאים צהובים = ה-AI ביקש בדיקה), ואז: approve, validate, publish.`);
    return;
  }

  if (command === "approve") {
    if (!target) fail("נדרש קובץ: approve <קובץ.xlsx>");
    const out = target.replace(/\.xlsx$/i, "") + ".approved.xlsx";
    console.log(runXlsxTool(["approve", target, out]));
    return;
  }

  if (command === "validate" || command === "publish") {
    if (!target) fail(`נדרש קובץ: ${command} <קובץ.xlsx>`);
    const template = read(templatePath);
    const file = convertToJson(target);
    const chiefComplaint = typeof flags["chief-complaint"] === "string" ? flags["chief-complaint"] : undefined;
    if (command === "validate") {
      const result = validateCase(file, template, { chiefComplaint });
      printIssues(result);
      process.exit(result.errors.length ? 1 : 0);
    }
    const plan = planPublish({ file, template, catalogue: read(indexPath), chiefComplaint, replace: Boolean(flags.replace) });
    printIssues(plan);
    if (!plan.ok) process.exit(1);
    console.log(`\nיתווסף לאתר:\n  data/cases/${plan.jsonName}\n  data/source/${path.basename(target)}\n  רשומה בקטלוג: ${JSON.stringify(plan.entry)}`);
    if (!flags.yes) { console.log("\nזוהי תוכנית בלבד. להוספה ממשית הוסיפו --yes. הכלי לא מבצע commit."); return; }
    applyPublish({ root, plan, file, workbookPath: path.resolve(target), replace: Boolean(flags.replace) });
    console.log(`\nבוצע. בדקו עם: npm test, ואז בצעו commit בעצמכם:\n  git add data && git commit -m "Add ${plan.entry.id}"`);
    return;
  }

  console.log(HELP);
  process.exit(1);
}

main().catch((error) => fail(error.message));
