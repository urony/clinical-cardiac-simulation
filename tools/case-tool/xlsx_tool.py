"""Excel helper for the local case-creation tool (runs on the author's computer only).

Subcommands
  convert  <xlsx> <json>              workbook -> JSON {source, sheets: {name: rows}} (same format as data/cases)
  fill     <template> <fills> <out>   write an AI draft (fills.json) into a copy of the case template
  approve  <xlsx> <out>               set every "draft" status to "approved" (run only after a human review)

Needs Python 3 and openpyxl. Nothing here talks to the network.
"""
import json
import sys
from pathlib import Path

from openpyxl import load_workbook
from openpyxl.comments import Comment
from openpyxl.styles import PatternFill

DRAFT = "טיוטה"
APPROVED = "מאושר"
META_APPROVED = "מאושר לבניית אב-טיפוס"
REVIEW_FILL = PatternFill("solid", fgColor="FFF2CC")
AI_FILL = PatternFill("solid", fgColor="E8F1FA")
# sheet -> (column that identifies the row, kind)
KEYS = {
    "אנמנזה": "מזהה רכיב בסיס",
    "בדיקה_גופנית": "מזהה רכיב בסיס",
    "בדיקות_מיידיות": "מזהה רכיב בסיס",
    "בדיקות_המשך": "מזהה רכיב בסיס",
    "תוצאות_מספריות": "מזהה מדד",
    "החלטות_וטיפול": "מזהה",
    "כללי_משוב": "מזהה",
}


def cell_value(value):
    return value.isoformat() if hasattr(value, "isoformat") else value


def convert(xlsx, out):
    wb = load_workbook(xlsx, data_only=True)
    payload = {"source": Path(xlsx).name, "sheets": {}}
    for ws in wb.worksheets:
        payload["sheets"][ws.title] = [[cell_value(c.value) for c in row] for row in ws.iter_rows(values_only=False)]
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    Path(out).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {out}")


def header_row(ws, marker="מזהה"):
    """First row that contains the marker text in some cell (the table header)."""
    for row in ws.iter_rows():
        if any(isinstance(c.value, str) and marker in c.value for c in row):
            return row[0].row, {str(c.value).strip(): c.column for c in row if c.value is not None}
    return None, {}


def replace_placeholder_case_id(wb, case_id):
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for c in row:
                if isinstance(c.value, str) and "CASE-XXX" in c.value:
                    c.value = c.value.replace("CASE-XXX", case_id)


def fill(template, fills_path, out):
    fills = json.loads(Path(fills_path).read_text(encoding="utf-8"))
    case_id = fills["caseId"]
    wb = load_workbook(template)  # keep formulas and validation lists
    replace_placeholder_case_id(wb, case_id)
    review = []
    for sheet, entries in fills["sheets"].items():
        ws = wb[sheet]
        if sheet == "מטא_מקרה":
            start, cols = header_row(ws, "שדה")
            key_col, value_col = cols["שדה"], cols["ערך"]
            rows = {str(ws.cell(r, key_col).value).strip(): r for r in range(start + 1, ws.max_row + 1) if ws.cell(r, key_col).value}
            for field, entry in entries.items():
                if field not in rows:
                    raise SystemExit(f"meta field not in template: {field}")
                cell = ws.cell(rows[field], value_col)
                cell.value = entry["fields"]["ערך"]
                cell.fill = REVIEW_FILL if entry.get("needsReview") else AI_FILL
                if entry.get("needsReview"):
                    review.append((sheet, field, entry.get("note", "")))
            continue
        start, cols = header_row(ws)
        key_col = cols[KEYS[sheet]]
        rows = {str(ws.cell(r, key_col).value).strip(): r for r in range(start + 1, ws.max_row + 1) if ws.cell(r, key_col).value}
        for item_id, entry in entries.items():
            if item_id not in rows:
                raise SystemExit(f"{sheet}: id not in template: {item_id}")
            for column, value in entry["fields"].items():
                if column not in cols:
                    raise SystemExit(f"{sheet}: column not in template: {column}")
                cell = ws.cell(rows[item_id], cols[column])
                cell.value = value
                cell.fill = REVIEW_FILL if entry.get("needsReview") else AI_FILL
            if entry.get("needsReview"):
                review.append((sheet, item_id, entry.get("note", "")))
    # Explain the colours and list what the author must look at first.
    if "טיוטת_AI" in wb.sheetnames:
        del wb["טיוטת_AI"]
    guide = wb.create_sheet("טיוטת_AI", 0)
    guide.sheet_view.rightToLeft = True
    guide.append(["טיוטה שנוצרה בעזרת בינה מלאכותית — חובה לעבור על כל התוכן הקליני"])
    guide.append(["תא כחול בהיר = מולא על ידי ה-AI. תא צהוב = ה-AI סימן שנדרשת בדיקה שלך. אף עובדה קלינית לא אושרה עד שבדקת אותה."])
    guide.append(["אחרי הסקירה: הריצו approve כדי להפוך סטטוס \"טיוטה\" ל\"מאושר\", ואז validate ו-publish."])
    guide.append([])
    guide.append(["גיליון", "מזהה", "הערת ה-AI"])
    for item in review:
        guide.append(list(item))
    guide.column_dimensions["A"].width = 22
    guide.column_dimensions["B"].width = 18
    guide.column_dimensions["C"].width = 90
    wb.save(out)
    print(f"Wrote {out} ({len(review)} items flagged for review)")


def approve(xlsx, out):
    wb = load_workbook(xlsx)
    changed = 0
    for ws in wb.worksheets:
        if ws.title == "טיוטת_AI":
            continue
        start, cols = header_row(ws, "שדה" if ws.title == "מטא_מקרה" else "מזהה")
        if ws.title == "מטא_מקרה":
            key_col, value_col = cols["שדה"], cols["ערך"]
            for r in range(start + 1, ws.max_row + 1):
                if ws.cell(r, key_col).value == "סטטוס" and ws.cell(r, value_col).value in (DRAFT, None):
                    ws.cell(r, value_col).value = META_APPROVED
                    changed += 1
            continue
        status_col = cols.get("סטטוס")
        if not status_col:
            continue
        for r in range(start + 1, ws.max_row + 1):
            if ws.cell(r, status_col).value == DRAFT:
                ws.cell(r, status_col).value = APPROVED
                changed += 1
    if "טיוטת_AI" in wb.sheetnames:
        del wb["טיוטת_AI"]
    wb.save(out)
    print(f"Wrote {out} ({changed} statuses set to approved)")


def main(argv):
    if len(argv) >= 4 and argv[1] == "convert":
        convert(argv[2], argv[3])
    elif len(argv) >= 5 and argv[1] == "fill":
        fill(argv[2], argv[3], argv[4])
    elif len(argv) >= 4 and argv[1] == "approve":
        approve(argv[2], argv[3])
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main(sys.argv)
