import { APPLE_PASS_UPDATE_QUEUE, type Database, type PgBoss } from "@cafe-loyalty/db";
import type { Kysely } from "kysely";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { jobQueueTask, resendUndeliveredPasses } from "./jobs.js";

describe("jobQueueTask", () => {
  /** A job queue whose start fails with `failure`, recording whether anything else was asked of it. */
  function failingStart(failure: Error) {
    const calls: string[] = [];
    const boss = {
      start: () => {
        calls.push("start");
        return Promise.reject(failure);
      },
      stop: () => {
        calls.push("stop");
        return Promise.resolve();
      },
      createQueue: () => {
        calls.push("createQueue");
        return Promise.resolve();
      },
    } as unknown as PgBoss;
    const lines: { level: number; msg: string }[] = [];
    const logger = pino({ level: "info" }, { write: (line: string) => lines.push(JSON.parse(line) as { level: number; msg: string }) });
    const task = jobQueueTask(boss, logger, 15_000, { db: {} as Kysely<Database>, pusher: undefined, google: undefined });
    return { task, calls, lines };
  }

  it("runs without the queue on a pg-boss schema of another version, rather than stop the worker, and stops cleanly", async () => {
    const { task, calls, lines } = failingStart(new Error("pg-boss database requires migrations"));
    await expect(task.start()).resolves.toBeUndefined();
    expect(lines).toContainEqual(expect.objectContaining({ level: 50, msg: expect.stringContaining("another pg-boss version") as string }));
    await expect(task.stop()).resolves.toBeUndefined();
    // Nothing more was asked of a queue that never started.
    expect(calls).toEqual(["start"]);
  });

  it("still fails to start on any other failure", async () => {
    const { task } = failingStart(new Error("connect ECONNREFUSED 127.0.0.1:5432"));
    await expect(task.start()).rejects.toThrow("ECONNREFUSED");
  });
});

/** A job queue whose marking of outdated passes rejects with `rejection`, and which holds one undelivered pass. */
function failingMarking(rejection: unknown) {
  const sent: unknown[] = [];
  const boss = {
    getDb: () => ({
      executeSql: (text: string) =>
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- what a driver could reject with
        text.includes("mark_outdated_passes") ? Promise.reject(rejection) : Promise.resolve({ rows: [{ wallet: "apple", cafe_id: "cafe-1", pass_id: "pass-1" }] }),
    }),
    send: (queue: string, data: unknown) => {
      sent.push({ queue, data });
      return Promise.resolve("job-1");
    },
  } as unknown as PgBoss;
  const lines: { level: number; msg: string; err?: { message?: string } }[] = [];
  const logger = pino({ level: "info" }, { write: (line: string) => lines.push(JSON.parse(line) as { level: number; msg: string; err?: { message?: string } }) });
  return { boss, logger, sent, lines };
}

describe("resendUndeliveredPasses", () => {
  it("logs a failed marking at once, still queues undelivered passes, then fails the job", async () => {
    const { boss, logger, sent, lines } = failingMarking(new Error("canceling statement due to statement timeout"));
    // Failed, so pg-boss records it, with the marking's error as its cause.
    await expect(resendUndeliveredPasses(boss, logger)).rejects.toMatchObject({ cause: { message: "canceling statement due to statement timeout" } });
    // The resend ran, after the failure was logged.
    expect(sent).toEqual([{ queue: APPLE_PASS_UPDATE_QUEUE, data: { cafeId: "cafe-1", passId: "pass-1" } }]);
    expect(lines.map((line) => line.msg)).toEqual([
      "passes on an older layout could not be marked; undelivered passes are queued anyway",
      "undelivered passes queued again",
    ]);
    // Logged as an error (pino level 50), with the marking's error.
    expect(lines[0]).toMatchObject({ level: 50, err: { message: "canceling statement due to statement timeout" } });
  });

  it("fails the job even when the marking rejects without a value", async () => {
    const { boss, logger, sent } = failingMarking(undefined);
    await expect(resendUndeliveredPasses(boss, logger)).rejects.toThrow("Passes on an older layout could not be marked");
    expect(sent).toHaveLength(1);
  });
});
