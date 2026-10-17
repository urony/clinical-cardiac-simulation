// Finds a Python 3 with openpyxl and runs the Excel helper (xlsx_tool.py) with it.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const XLSX_TOOL = path.join(here, "xlsx_tool.py");

function candidates() {
  const local = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Python", "bin", "python.exe") : null;
  // Deliberately no "py": the Windows Python install manager may download and install a whole Python
  // into the current folder when it finds none. Only interpreters that already exist are probed.
  return [process.env.CASE_TOOL_PYTHON, local, "python", "python3"].filter(Boolean);
}

// Best effort: ask the Windows Python install manager (if that is what "python" resolves to) never to
// download a runtime on its own.
const pythonEnv = () => ({ ...process.env, PYTHONIOENCODING: "utf-8", PYTHON_MANAGER_AUTOMATIC_INSTALL: "0" });

let cached;

/** Returns the command of a Python that can import openpyxl, or null. */
export function findPython() {
  if (cached !== undefined) return cached;
  for (const command of candidates()) {
    const probe = spawnSync(command, ["-c", "import openpyxl, sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)"], { encoding: "utf8", env: pythonEnv() });
    if (probe.status === 0) return (cached = command);
  }
  return (cached = null);
}

export function runXlsxTool(args) {
  const python = findPython();
  if (!python) throw new Error("לא נמצא Python 3 עם openpyxl. התקינו (pip install openpyxl) או הגדירו CASE_TOOL_PYTHON לנתיב של python.");
  const result = spawnSync(python, [XLSX_TOOL, ...args], { encoding: "utf8", env: pythonEnv() });
  if (result.status !== 0) throw new Error(`xlsx_tool נכשל: ${(result.stderr || result.stdout || "").trim()}`);
  return result.stdout.trim();
}
