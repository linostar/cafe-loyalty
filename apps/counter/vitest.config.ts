import react from "@vitejs/plugin-react";
import { defineProject } from "vitest/config";

export default defineProject({
  plugins: [react()],
  define: {
    __BUILD_ID__: JSON.stringify("test-build"),
    __BUILT_AT__: JSON.stringify("2026-10-01T00:00:00.000Z"),
  },
  test: {
    name: "counter",
    environment: "jsdom",
    include: ["src/**/*.test.tsx", "src/**/*.test.ts"],
    setupFiles: ["./src/test-setup.ts"],
  },
});
