import { APPLE_PASS_UPDATE_QUEUE, type Database, type PgBoss } from "@cafe-loyalty/db";
import type { FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";

export interface ReadinessOptions {
  db: Kysely<Database>;
  /** Undefined when the server runs without its job queue (main.ts: the queue's schema is another version). */
  jobs: PgBoss | undefined;
}

type Check = "ok" | "failed";

/**
 * GET /health/ready (AC 44), which the deploy waits for: 200 when the database answers and the job queue reaches its
 * tables, 503 otherwise. A server running without its queue on purpose (a release rolled back past a pg-boss upgrade)
 * is ready, with the queue reported off, so that rollback can finish.
 */
export function registerReadiness(app: FastifyInstance, options: ReadinessOptions): void {
  app.get("/health/ready", async (request, reply) => {
    const { db, jobs } = options;
    const database = await check(request.log, "database", () => sql`SELECT 1`.execute(db));
    const jobQueue = jobs === undefined ? "off" : await check(request.log, "job queue", () => jobs.getQueue(APPLE_PASS_UPDATE_QUEUE));
    const ready = database === "ok" && jobQueue !== "failed";
    return reply
      .code(ready ? 200 : 503)
      .header("cache-control", "no-store")
      .send({ status: ready ? "ready" : "not ready", database, jobQueue });
  });
}

async function check(log: FastifyInstance["log"], name: string, probe: () => Promise<unknown>): Promise<Check> {
  try {
    await probe();
    return "ok";
  } catch (error) {
    log.error({ err: error, check: name }, "readiness check failed");
    return "failed";
  }
}
