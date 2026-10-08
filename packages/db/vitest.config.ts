import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "db",
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.integration.test.ts"],
  },
});
