import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { loadServerConfig } from "./config.js";

const PROVISION = fileURLToPath(new URL("../../../deploy/provision.sh", import.meta.url));
const DOMAINS = {
  PRODUCTION_DASHBOARD_DOMAIN: "dashboard.example.test",
  PRODUCTION_COUNTER_DOMAIN: "counter.example.test",
  PRODUCTION_PUBLIC_DOMAIN: "card.example.test",
  STAGING_DASHBOARD_DOMAIN: "dashboard.staging.example.test",
  STAGING_COUNTER_DOMAIN: "counter.staging.example.test",
  STAGING_PUBLIC_DOMAIN: "card.staging.example.test",
};
const dir = mkdtempSync(join(tmpdir(), "provision-env-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the server settings provisioning generates (deploy/provision.sh)", () => {
  it("are what the server accepts once the operator adds email and the release its build time", () => {
    execFileSync("bash", [PROVISION, "env-files", dir], { env: { PATH: process.env.PATH, ...DOMAINS }, stdio: "pipe" });
    const database = parseEnv(readFileSync(join(dir, "database.env"), "utf8"));
    const app = parseEnv(readFileSync(join(dir, "app.env"), "utf8"));
    const config = loadServerConfig({
      ...app,
      SMTP_HOST: "smtp.example.test",
      SMTP_USER: "mailer",
      SMTP_PASSWORD: "mail-password",
      EMAIL_FROM: "Qahwa Loyalty <hello@example.test>",
      BUILT_AT: "2026-10-01T00:00:00.000Z",
    });
    expect(config.NODE_ENV).toBe("production");
    expect(config.DASHBOARD_URL).toBe("https://dashboard.example.test");
    expect(config.DATABASE_URL).toContain(`:${database.APP_PASSWORD ?? "missing"}@`);
  });
});
