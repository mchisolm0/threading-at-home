import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/.next/**",
      "**/dist/**",
      "**/node_modules/**",
      "convex/_generated/**"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        clearTimeout: "readonly",
        console: "readonly",
        process: "readonly",
        React: "readonly",
        setTimeout: "readonly"
      }
    }
  },
  {
    files: ["apps/web/next-env.d.ts"],
    rules: {
      "@typescript-eslint/triple-slash-reference": "off"
    }
  }
);
