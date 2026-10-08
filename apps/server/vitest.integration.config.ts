import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Locally, TEST_DATABASE_ADMIN_URL comes from the repo's .env; in CI the workflow sets it and .env is absent.
const envFile = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

export default defineConfig({
  // Resolve `include` from this package, whichever directory vitest is started from.
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    name: "server-integration",
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
