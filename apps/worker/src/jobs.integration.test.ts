import { randomBytes } from "node:crypto";
import { createTestDatabase, type TestDatabase } from "@cafe-loyalty/db/testing";
import { sql } from "kysely";
import pg from "pg";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PURGE_QUEUE, createJobQueue, jobQueueTask } from "./jobs.js";

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

/** A worker's job queue writing its log lines to `lines`. */
function jobQueue() {
  const lines: Record<string, unknown>[] = [];
  const logger = pino({ level: "info" }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
  const boss = createJobQueue(db.appUrl, logger, "worker-test");
  return { boss, task: jobQueueTask(boss, logger, 10_000), lines };
}

const codeOf = (query: Promise<unknown>) =>
  query.then(
    () => undefined,
    (caught: unknown) => (caught as { code?: string }).code,
  );

// In order: the first starts the queue (creating it), which the last one tampers with.
describe("job queue", () => {
  it("runs the hourly purge as a job of the migrated pg-boss schema, as the app role", async () => {
    await admin.query("INSERT INTO app.customer_recovery_tokens (email_lookup, token_hash, expires_at) VALUES ($1, $2, now() - interval '1 minute')", [
      randomBytes(32),
      randomBytes(32),
    ]);
    const { boss, task } = jobQueue();
    // Fails if the pg-boss library expects another schema version than migration 0007 installed.
    await task.start();
    try {
      expect((await boss.getSchedules()).map((schedule) => ({ name: schedule.name, cron: schedule.cron }))).toEqual([{ name: PURGE_QUEUE, cron: "17 * * * *" }]);
      // What the schedule sends every hour, picked up by the worker's own handler.
      const id = (await boss.send(PURGE_QUEUE)) ?? "";
      await vi.waitFor(
        async () => {
          // Counts in the output; the token itself may have gone in a scheduled run at minute 17.
          expect(await boss.findJobs(PURGE_QUEUE, { id })).toMatchObject([{ state: "completed", output: { customer_recovery_tokens: expect.any(Number) as unknown } }]);
        },
        { timeout: 20_000, interval: 250 },
      );
      expect((await admin.query("SELECT 1 FROM app.customer_recovery_tokens")).rowCount).toBe(0);
    } finally {
      await task.stop();
    }
  });

  it("logs a purge that fails, which pg-boss alone would only mark failed", async () => {
    await admin.query("REVOKE EXECUTE ON FUNCTION app.purge_expired_credentials() FROM cl_app");
    const { boss, task, lines } = jobQueue();
    await task.start();
    try {
      const id = (await boss.send(PURGE_QUEUE, null, { retryLimit: 0 })) ?? "";
      await vi.waitFor(
        async () => {
          expect(await boss.findJobs(PURGE_QUEUE, { id })).toMatchObject([{ state: "failed" }]);
        },
        { timeout: 20_000, interval: 250 },
      );
      expect(lines).toContainEqual(expect.objectContaining({ level: 50, msg: "expired credential purge failed", job: PURGE_QUEUE, jobId: id }));
    } finally {
      await task.stop();
      await admin.query("GRANT EXECUTE ON FUNCTION app.purge_expired_credentials() TO cl_app");
    }
  });

  it("leaves the app role nothing in pgboss that the owner role later runs", async () => {
    expect(await codeOf(sql`CREATE TABLE pgboss.intruder (id int)`.execute(db.app.db))).toBe("42501");
    // pg-boss's upgrade plans put queue table names unquoted into DDL: only pg-boss's own names are accepted.
    for (const planted of ["x; DROP SCHEMA app; --", `j${"a".repeat(56)}; DROP SCHEMA app; --`]) {
      expect(await codeOf(sql`UPDATE pgboss.queue SET table_name = ${planted} WHERE name = ${PURGE_QUEUE}`.execute(db.app.db))).toBe("23514");
    }
    expect(
      await codeOf(sql`INSERT INTO pgboss.bam (name, version, status, table_name, command) VALUES ('planted', 1, 'pending', 'job_common', 'SELECT 1')`.execute(db.app.db)),
    ).toBe("42501");
  });
});
