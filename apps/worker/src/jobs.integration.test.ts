import { randomBytes, randomUUID } from "node:crypto";
import { APPLE_PASS_UPDATE_QUEUE, createJobQueue } from "@cafe-loyalty/db";
import { createTestDatabase, type TestDatabase } from "@cafe-loyalty/db/testing";
import { sql } from "kysely";
import pg from "pg";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PassPusher, PushResult } from "./apns.js";
import { PURGE_QUEUE, jobQueueTask } from "./jobs.js";

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

/** APNs as a test sees it: every push token it was sent, answering from `answers` (default "sent"). */
class FakePusher implements PassPusher {
  readonly pushed: string[] = [];
  readonly answers = new Map<string, PushResult | Error>();

  push(pushToken: string): Promise<PushResult> {
    this.pushed.push(pushToken);
    const answer = this.answers.get(pushToken) ?? "sent";
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  }

  close(): void {
    // Nothing to release.
  }
}

/** A worker's job queue writing its log lines to `lines`; `apns: false` is a worker without Apple Wallet. */
function jobQueue({ apns = true } = {}) {
  const lines: Record<string, unknown>[] = [];
  const logger = pino({ level: "info" }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
  const boss = createJobQueue(db.appUrl, logger, { applicationName: "worker-test", maxConnections: 4 });
  const pusher = new FakePusher();
  return { boss, task: jobQueueTask(boss, logger, 15_000, { db: db.app.db, pusher: apns ? pusher : undefined }), lines, pusher };
}

const codeOf = (query: Promise<unknown>) =>
  query.then(
    () => undefined,
    (caught: unknown) => (caught as { code?: string }).code,
  );

const finished = async (boss: ReturnType<typeof jobQueue>["boss"], queue: string, id: string, state: "completed" | "failed") => {
  await vi.waitFor(
    async () => {
      expect(await boss.findJobs(queue, { id })).toMatchObject([{ state }]);
    },
    { timeout: 20_000, interval: 250 },
  );
  return (await boss.findJobs(queue, { id }))[0];
};

/** A café's card with an Apple pass registered on `devices` devices; returns their push tokens. */
async function passWithDevices(devices: number): Promise<{ cafeId: string; passId: string; tokens: string[] }> {
  const cafeId = randomUUID();
  const cardId = randomUUID();
  const passId = randomUUID();
  await admin.query("INSERT INTO app.cafes (id, name) VALUES ($1, 'Café')", [cafeId]);
  await admin.query("INSERT INTO app.cards (id, cafe_id, web_secret_hash, privacy_accepted_at) VALUES ($1, $2, $3, now())", [cardId, cafeId, randomBytes(32)]);
  await admin.query("INSERT INTO app.apple_passes (id, cafe_id, card_id, epoch, auth_token_hash, layout_version) VALUES ($1, $2, $3, 1, $4, 1)", [
    passId,
    cafeId,
    cardId,
    randomBytes(32),
  ]);
  const tokens: string[] = [];
  for (let device = 0; device < devices; device += 1) {
    const token = randomBytes(32).toString("hex");
    await admin.query("INSERT INTO app.apple_pass_registrations (cafe_id, pass_id, device_library_hash, push_token) VALUES ($1, $2, $3, $4)", [
      cafeId,
      passId,
      randomBytes(32),
      token,
    ]);
    tokens.push(token);
  }
  return { cafeId, passId, tokens: tokens.sort() };
}

const registrationTokens = async (cafeId: string): Promise<string[]> =>
  (await admin.query<{ push_token: string }>("SELECT push_token FROM app.apple_pass_registrations WHERE cafe_id = $1 ORDER BY push_token", [cafeId])).rows.map(
    (row) => row.push_token,
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
      // Counts in the output; the token itself may have gone in a scheduled run at minute 17.
      expect(await finished(boss, PURGE_QUEUE, id, "completed")).toMatchObject({ output: { customer_recovery_tokens: expect.any(Number) as unknown } });
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
      await finished(boss, PURGE_QUEUE, id, "failed");
      expect(lines).toContainEqual(expect.objectContaining({ level: 50, msg: "job failed", job: PURGE_QUEUE, jobId: id }));
    } finally {
      await task.stop();
      await admin.query("GRANT EXECUTE ON FUNCTION app.purge_expired_credentials() TO cl_app");
    }
  });

  it("pushes an update to every device registered for a pass and drops those APNs reports gone", async () => {
    const pass = await passWithDevices(3);
    const other = await passWithDevices(1);
    const { boss, task, pusher } = jobQueue();
    const [kept, gone, alsoKept] = pass.tokens;
    pusher.answers.set(gone ?? "", "unregistered");
    await task.start();
    try {
      const id = (await boss.send(APPLE_PASS_UPDATE_QUEUE, { cafeId: pass.cafeId, passId: pass.passId })) ?? "";
      expect(await finished(boss, APPLE_PASS_UPDATE_QUEUE, id, "completed")).toMatchObject({ output: { sent: 2, removed: 1 } });
      expect([...pusher.pushed].sort()).toEqual(pass.tokens);
      expect(await registrationTokens(pass.cafeId)).toEqual([kept, alsoKept]);
      expect(await registrationTokens(other.cafeId)).toEqual(other.tokens);
    } finally {
      await task.stop();
    }
  });

  it("fails and logs a pass update APNs did not take, with its job and café, keeping the registration", async () => {
    const pass = await passWithDevices(1);
    const { boss, task, pusher, lines } = jobQueue();
    pusher.answers.set(pass.tokens[0] ?? "", new Error("APNs answered 503."));
    await task.start();
    try {
      const id = (await boss.send(APPLE_PASS_UPDATE_QUEUE, { cafeId: pass.cafeId, passId: pass.passId }, { retryLimit: 0 })) ?? "";
      await finished(boss, APPLE_PASS_UPDATE_QUEUE, id, "failed");
      expect(lines).toContainEqual(expect.objectContaining({ level: 50, msg: "job failed", job: APPLE_PASS_UPDATE_QUEUE, jobId: id, cafeId: pass.cafeId }));
      expect(await registrationTokens(pass.cafeId)).toEqual(pass.tokens);
      // The push token never reaches the logs.
      expect(JSON.stringify(lines)).not.toContain(pass.tokens[0]);
    } finally {
      await task.stop();
    }
  });

  it("retries a failed pass update with backoff, as its queue is set up (AC 13)", async () => {
    const pass = await passWithDevices(1);
    const { boss, task, pusher } = jobQueue();
    pusher.answers.set(pass.tokens[0] ?? "", new Error("APNs answered 503."));
    await task.start();
    try {
      expect(await boss.getQueue(APPLE_PASS_UPDATE_QUEUE)).toMatchObject({
        policy: "short",
        retryLimit: 12,
        retryDelay: 30,
        retryBackoff: true,
        retryDelayMax: 3_600,
        expireInSeconds: 120,
      });
      const id = (await boss.send(APPLE_PASS_UPDATE_QUEUE, { cafeId: pass.cafeId, passId: pass.passId })) ?? "";
      await vi.waitFor(
        async () => {
          expect(await boss.findJobs(APPLE_PASS_UPDATE_QUEUE, { id })).toMatchObject([{ state: "retry", retryLimit: 12 }]);
        },
        { timeout: 20_000, interval: 250 },
      );
    } finally {
      await task.stop();
    }
  });

  it("leaves pass updates queued on a worker without Apple Wallet, for one that has it", async () => {
    const pass = await passWithDevices(1);
    const { boss, task } = jobQueue({ apns: false });
    await task.start();
    try {
      const id = (await boss.send(APPLE_PASS_UPDATE_QUEUE, { cafeId: pass.cafeId, passId: pass.passId })) ?? "";
      // Longer than pg-boss's polling interval (2 seconds).
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(await boss.findJobs(APPLE_PASS_UPDATE_QUEUE, { id })).toMatchObject([{ state: "created" }]);
    } finally {
      await task.stop();
    }
  });

  it("reads only the job's café: a job naming another café's pass pushes nothing and removes nothing (AC 2)", async () => {
    const mine = await passWithDevices(1);
    const theirs = await passWithDevices(1);
    const { boss, task, pusher } = jobQueue();
    pusher.answers.set(theirs.tokens[0] ?? "", "unregistered");
    await task.start();
    try {
      const id = (await boss.send(APPLE_PASS_UPDATE_QUEUE, { cafeId: mine.cafeId, passId: theirs.passId })) ?? "";
      expect(await finished(boss, APPLE_PASS_UPDATE_QUEUE, id, "completed")).toMatchObject({ output: { sent: 0, removed: 0 } });
      expect(pusher.pushed).toEqual([]);
      expect(await registrationTokens(theirs.cafeId)).toEqual(theirs.tokens);
    } finally {
      await task.stop();
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
