import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { loadBootstrapEnv, loadMigrateEnv } from "./config.js";

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

describe("the database settings provisioning generates (deploy/provision.sh)", () => {
  it("are what the bootstrap and migration commands accept", () => {
    execFileSync("bash", [PROVISION, "env-files", dir], { env: { PATH: process.env.PATH, ...DOMAINS }, stdio: "pipe" });
    const database = parseEnv(readFileSync(join(dir, "database.env"), "utf8"));
    const bootstrap = loadBootstrapEnv(database);
    const migrate = loadMigrateEnv(database);
    expect(migrate.MIGRATOR_DATABASE_URL).toContain(`${bootstrap.MIGRATOR_ROLE}:${bootstrap.MIGRATOR_PASSWORD}@`);
  });
});
