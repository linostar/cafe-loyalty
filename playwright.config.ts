import { defineConfig } from "@playwright/test";

const host = process.env.E2E_HOST ?? "127.0.0.1";
const counterPort = Number(process.env.E2E_COUNTER_PORT ?? "4173");
const dashboardPort = Number(process.env.E2E_DASHBOARD_PORT ?? "4174");
const isCi = process.env.CI !== undefined;

const phone = { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true } as const;

interface PreviewServer {
  command: string;
  url: string;
  reuseExistingServer: boolean;
  timeout: number;
}

function previewServer(app: string, port: number): PreviewServer {
  return {
    command: `pnpm --filter @cafe-loyalty/${app} preview --host ${host} --port ${String(port)} --strictPort`,
    url: `http://${host}:${String(port)}`,
    reuseExistingServer: !isCi,
    timeout: 60_000,
  };
}

export default defineConfig({
  testDir: "e2e",
  forbidOnly: isCi,
  retries: 0,
  reporter: isCi ? [["github"], ["html", { open: "never" }]] : "list",
  use: { trace: "retain-on-failure", browserName: "chromium", ...phone },
  projects: [
    { name: "counter", testMatch: "counter/**/*.spec.ts", use: { baseURL: `http://${host}:${String(counterPort)}` } },
    { name: "dashboard", testMatch: "dashboard/**/*.spec.ts", use: { baseURL: `http://${host}:${String(dashboardPort)}` } },
  ],
  webServer: [previewServer("counter", counterPort), previewServer("dashboard", dashboardPort)],
});
