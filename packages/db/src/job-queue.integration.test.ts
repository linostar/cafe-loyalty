import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJobQueue, isJobQueueVersionMismatch, startJobQueue } from "./job-queue.js";
import { createTestDatabase, type TestDatabase } from "./testing/test-database.js";

let db: TestDatabase;
let admin: pg.Client;

beforeAll(async () => {
  db = await createTestDatabase();
  admin = new pg.Client({ connectionString: db.adminUrl });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
  await db.cleanup();
});

const quiet = { error: () => undefined, warn: () => undefined };

/** Why a send-only job queue fails to start against `connectionString`. */
async function startFailure(connectionString: string): Promise<unknown> {
  const boss = createJobQueue(connectionString, quiet, { applicationName: "db-test", maxConnections: 1, sendOnly: true });
  try {
    await startJobQueue(boss);
    return undefined;
  } catch (error) {
    return error;
  } finally {
    await boss.stop({ graceful: false }).catch(() => undefined);
  }
}

describe("startJobQueue", () => {
  it("tells a pg-boss schema of another version, which the server runs without, from any other failure", async () => {
    // As after a later release's pg-boss upgrade, with this release rolled back.
    await admin.query("UPDATE pgboss.version SET version = '46'");
    try {
      expect(isJobQueueVersionMismatch(await startFailure(db.appUrl))).toBe(true);
    } finally {
      await admin.query("UPDATE pgboss.version SET version = '45'");
    }
    const unreachable = new URL(db.appUrl);
    unreachable.password = "wrong-password";
    const other = await startFailure(unreachable.toString());
    expect(other).toBeInstanceOf(Error);
    expect(isJobQueueVersionMismatch(other)).toBe(false);
    expect(await startFailure(db.appUrl)).toBeUndefined();
  });
});
