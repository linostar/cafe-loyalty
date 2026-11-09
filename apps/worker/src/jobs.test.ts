import { APPLE_PASS_UPDATE_QUEUE, type PgBoss } from "@cafe-loyalty/db";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { resendUndeliveredPasses } from "./jobs.js";

describe("resendUndeliveredPasses", () => {
  it("still queues undelivered passes when marking passes on an older layout fails, and logs the failure", async () => {
    const sent: unknown[] = [];
    const boss = {
      getDb: () => ({
        executeSql: (text: string) =>
          text.includes("mark_outdated_passes")
            ? Promise.reject(new Error("canceling statement due to statement timeout"))
            : Promise.resolve({ rows: [{ wallet: "apple", cafe_id: "cafe-1", pass_id: "pass-1" }] }),
      }),
      send: (queue: string, data: unknown) => {
        sent.push({ queue, data });
        return Promise.resolve("job-1");
      },
    } as unknown as PgBoss;
    const lines: { level: number; msg: string }[] = [];
    const logger = pino({ level: "info" }, { write: (line: string) => lines.push(JSON.parse(line) as { level: number; msg: string }) });

    expect(await resendUndeliveredPasses(boss, logger)).toEqual({ found: 1, queued: 1 });
    expect(sent).toEqual([{ queue: APPLE_PASS_UPDATE_QUEUE, data: { cafeId: "cafe-1", passId: "pass-1" } }]);
    expect(lines).toContainEqual(expect.objectContaining({ level: 50, msg: "passes on an older layout could not be marked; the next run tries again" }));
  });
});
