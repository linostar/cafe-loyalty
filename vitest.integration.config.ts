import { defineConfig } from "vitest/config";

/** Tests against a real PostgreSQL (`pnpm test:db`); each project's config loads TEST_DATABASE_ADMIN_URL from .env. */
export default defineConfig({
  test: {
    projects: ["packages/db/vitest.integration.config.ts", "apps/server/vitest.integration.config.ts"],
  },
});
