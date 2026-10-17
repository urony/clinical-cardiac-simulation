"""Convert the approved CASE workbook into a runtime JSON artifact.

This script is deliberately the only bridge from the approved Excel workbook
to the application.  It preserves sheet headings and rows, so a data change
does not require changing application code.
"""
from pathlib import Path
import json
from openpyxl import load_workbook

ROOT = Path(__file__).resolve().parents[1]
SOURCES = {
    "case-001": ROOT / "data" / "source" / "case-001-stable-angina-patient-database-v2-he.xlsx",
    "case-002": ROOT / "data" / "source" / "case-002-acute-mi-patient-database-v2-1-he.xlsx",
    "case-003": ROOT / "data" / "source" / "case-003-musculoskeletal-chest-pain-patient-database-v2-1-he.xlsx",
}

def value(v):
    if hasattr(v, "isoformat"):
        return v.isoformat()
    return v

for case_key, source in SOURCES.items():
    wb = load_workbook(source, data_only=True)
    payload = {"source": source.name, "sheets": {}}
    for ws in wb.worksheets:
        rows = [[value(cell.value) for cell in row] for row in ws.iter_rows(values_only=False)]
        payload["sheets"][ws.title] = rows
    target = ROOT / "data" / "cases" / f"{case_key}.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {target}")
