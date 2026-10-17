import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Static site: no server runtime. A relative base lets it run from a GitHub Pages project path.
export default defineConfig({
  base: "./",
  plugins: [react()],
});
