import { createTestDatabase, type TestDatabase } from "@cafe-loyalty/db/testing";
import { sql } from "kysely";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PURGE_QUEUE, createJobQueue, jobQueueTask, purgeExpiredCredentials } from "./jobs.js";

const logger = pino({ level: "silent" });
let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.cleanup();
});

describe("job queue", () => {
  it("runs on the migrated pg-boss schema as the app role, which cannot change that schema", async () => {
    const boss = createJobQueue(db.appUrl, logger, "worker-test");
    const task = jobQueueTask(boss, logger);
    // Fails if the pg-boss library expects another schema version than migration 0007 installed.
    await task.start();
    try {
      expect((await boss.getSchedules()).map((schedule) => schedule.name)).toEqual([PURGE_QUEUE]);
      expect(await purgeExpiredCredentials(boss, logger)).toMatchObject({ owner_sessions: 0, customer_recovery_tokens: 0 });
    } finally {
      await task.stop();
    }
    const codeOf = (query: Promise<unknown>) =>
      query.then(
        () => undefined,
        (caught: unknown) => (caught as { code?: string }).code,
      );
    expect(await codeOf(sql`CREATE TABLE pgboss.intruder (id int)`.execute(db.app.db))).toBe("42501");
    // Nothing the owner role later runs (upgrade plans) can be planted: no odd table names, no queued commands.
    expect(
      await codeOf(sql`UPDATE pgboss.queue SET table_name = 'x; DROP SCHEMA app; --' WHERE name = ${PURGE_QUEUE}`.execute(db.app.db)),
    ).toBe("23514");
    expect(
      await codeOf(sql`INSERT INTO pgboss.bam (name, version, status, table_name, command) VALUES ('planted', 1, 'pending', 'job_common', 'SELECT 1')`.execute(db.app.db)),
    ).toBe("42501");
  });
});
