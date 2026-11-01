import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  OPERATOR_NAME: "Najjar & Co (SAL)",
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
      EMAIL_FROM: "Loyalty Everywhere <hello@example.test>",
      BUILT_AT: "2026-10-01T00:00:00.000Z",
    });
    expect(config.NODE_ENV).toBe("production");
    expect(config.DASHBOARD_URL).toBe("https://dashboard.example.test");
    expect(config.OPERATOR_NAME).toBe("Najjar & Co (SAL)");
    expect(config.DATABASE_URL).toContain(`:${database.APP_PASSWORD ?? "missing"}@`);
  });

  /** Runs env-files in `target` with `name` as OPERATOR_NAME. */
  const envFiles = (target: string, name: string) =>
    execFileSync("bash", [PROVISION, "env-files", target], { env: { PATH: process.env.PATH, ...DOMAINS, OPERATOR_NAME: name }, stdio: "pipe" });
  const operatorLines = (target: string) => readFileSync(join(target, "app.env"), "utf8").split("\n").filter((line) => line.startsWith("OPERATOR_NAME="));

  it("refuse an operator name Compose or the server would not read as one line of text, writing nothing", () => {
    const wrongs = ["", "   ", 'Say "hi"', "Rana's", "No #1", "Cost $5", "back\\slash", "tick`", "two\nlines", "two lines", "two paragraphs", "x".repeat(101)];
    for (const wrong of wrongs) {
      const target = mkdtempSync(join(dir, "refused-"));
      expect(() => envFiles(target, wrong), JSON.stringify(wrong)).toThrow(/OPERATOR_NAME must be who runs the service/);
      expect(readdirSync(target)).toEqual([]);
    }
  });

  it("keep one operator name line after PUBLIC_URL on every run, and add it to an app.env from before it existed", () => {
    const target = mkdtempSync(join(dir, "rerun-"));
    envFiles(target, "First Operator");
    envFiles(target, "Second Operator");
    expect(operatorLines(target)).toEqual(["OPERATOR_NAME=Second Operator"]);
    // An app.env written before OPERATOR_NAME existed: the next run adds it, right after PUBLIC_URL.
    const appEnv = join(target, "app.env");
    writeFileSync(appEnv, readFileSync(appEnv, "utf8").replace("OPERATOR_NAME=Second Operator\n", ""));
    expect(operatorLines(target)).toEqual([]);
    envFiles(target, "Najjar & Co (SAL)");
    const lines = readFileSync(appEnv, "utf8").split("\n");
    expect(operatorLines(target)).toEqual(["OPERATOR_NAME=Najjar & Co (SAL)"]);
    expect(lines[lines.indexOf("OPERATOR_NAME=Najjar & Co (SAL)") - 1]).toBe("PUBLIC_URL=https://card.example.test");
  });
});
