import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  resolve: {
    alias: {
      "@oss-capacity/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url))
    }
  },
  server: {
    strictPort: true
  }
});
