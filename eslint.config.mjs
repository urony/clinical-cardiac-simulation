import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  { files: ["src/**", "lib/**"], languageOptions: { globals: globals.browser } },
  { files: ["tests/**", "scripts/**", "tools/**", "*.config.*"], languageOptions: { globals: globals.node } },
  { files: ["tools/case-admin/public/**"], languageOptions: { globals: globals.browser } },
);
