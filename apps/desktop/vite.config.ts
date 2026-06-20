import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  resolve: {
    alias: {
      "@oss-capacity/core": new URL("../../packages/core/src/index.ts", import.meta.url).pathname
    }
  },
  server: {
    strictPort: true
  }
});
