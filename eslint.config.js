import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const webApps = ["apps/counter/**/*.{ts,tsx}", "apps/dashboard/**/*.{ts,tsx}"];

export default defineConfig(
  {
    ignores: ["**/dist/**", "**/coverage/**", "playwright-report/**", "test-results/**"],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["apps/counter/sw.js"],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    files: ["apps/server/**/*.ts", "apps/worker/**/*.ts", "packages/**/*.ts", "e2e/**/*.ts", "*.config.ts"],
    languageOptions: { globals: globals.node },
  },
  {
    files: webApps,
    extends: [reactHooks.configs.flat.recommended, jsxA11y.flatConfigs.strict],
    languageOptions: { globals: globals.browser },
  },
);
