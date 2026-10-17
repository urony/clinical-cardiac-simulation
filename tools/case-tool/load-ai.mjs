// Loads the app's own provider layer (lib/ai-client.ts, lib/providers.ts) into Node by compiling it with
// Vite into a temporary folder, so the case tool uses exactly the same provider code as the app.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../../", import.meta.url));

export async function loadProviderLayer() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "case-tool-"));
  await build({
    root, configFile: false, logLevel: "silent", ssr: { noExternal: true },
    build: { ssr: true, outDir, emptyOutDir: true, minify: false, rollupOptions: { input: { client: path.join(root, "lib/ai-client.ts"), providers: path.join(root, "lib/providers.ts") }, output: { format: "es", entryFileNames: "[name].mjs" } } },
  });
  const load = (name) => import(pathToFileURL(path.join(outDir, `${name}.mjs`)).href);
  return { ...(await load("client")), ...(await load("providers")) };
}

/**
 * Builds a `complete()` for the draft tool from environment variables (the author's own key; it is
 * never written to disk or printed).
 *   CASE_TOOL_PROVIDER  provider id from data/providers.json (default: openai)
 *   CASE_TOOL_API_KEY   the author's API key
 *   CASE_TOOL_MODEL     optional model name used for every role
 */
export async function completeFromEnv(env = process.env) {
  const layer = await loadProviderLayer();
  const providerId = env.CASE_TOOL_PROVIDER || "openai";
  if (!layer.getProvider(providerId)) throw new Error(`ספק לא מוכר: ${providerId}`);
  if (!env.CASE_TOOL_API_KEY) throw new Error("לא הוגדר CASE_TOOL_API_KEY (מפתח ה-API שלך). הגדירו אותו כמשתנה סביבה בחלון הפקודות בלבד.");
  const model = env.CASE_TOOL_MODEL;
  const config = { providerId, apiKey: env.CASE_TOOL_API_KEY, timeoutMs: 180000, ...(model ? { models: { classifier: model, response: model, feedback: model } } : {}) };
  return { providerId, providerName: layer.getProvider(providerId).name, complete: (request) => layer.complete(config, request) };
}
