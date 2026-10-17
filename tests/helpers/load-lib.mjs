// Bundles the app's TypeScript modules with Vite so Node tests can import them as plain ESM.
// No server is involved; this only compiles lib/*.ts into a temporary folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../../", import.meta.url));
const input = { simulation: "lib/simulation.ts", feedback: "lib/feedback.ts", catalog: "lib/case-catalog.ts", caseData: "lib/case-data.ts", session: "lib/session-store.ts", client: "lib/ai-client.ts", providers: "lib/providers.ts", classLink: "lib/class-link.ts", links: "lib/links.ts", release: "lib/release.ts" };

export async function loadLib() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "clinical-sim-test-"));
  await build({
    root, configFile: false, logLevel: "silent",
    ssr: { noExternal: true },
    build: {
      ssr: true, outDir, emptyOutDir: true, minify: false,
      rollupOptions: { input: Object.fromEntries(Object.entries(input).map(([name, file]) => [name, path.join(root, file)])), output: { format: "es", entryFileNames: "[name].mjs" } },
    },
  });
  const load = (name) => import(pathToFileURL(path.join(outDir, `${name}.mjs`)).href);
  const lib = {};
  for (const name of Object.keys(input)) lib[name] = await load(name);
  return lib;
}

export function readCaseFile(file) {
  return JSON.parse(fs.readFileSync(path.join(root, "data", "cases", file), "utf8"));
}
