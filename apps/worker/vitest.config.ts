import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "worker",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
