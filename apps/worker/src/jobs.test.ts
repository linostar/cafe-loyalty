import { APPLE_PASS_UPDATE_QUEUE, type PgBoss } from "@cafe-loyalty/db";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { resendUndeliveredPasses } from "./jobs.js";

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
  const lines: { msg: string }[] = [];
  const logger = pino({ level: "info" }, { write: (line: string) => lines.push(JSON.parse(line) as { msg: string }) });
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
  });

  it("fails the job even when the marking rejects without a value", async () => {
    const { boss, logger, sent } = failingMarking(undefined);
    await expect(resendUndeliveredPasses(boss, logger)).rejects.toThrow("Passes on an older layout could not be marked");
    expect(sent).toHaveLength(1);
  });
});
