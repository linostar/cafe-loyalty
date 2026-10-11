import { createDatabase, createJobQueue, startJobQueue, type PgBoss } from "@cafe-loyalty/db";
import { createTestDatabase, type TestDatabase } from "@cafe-loyalty/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { registerReadiness, type ReadinessOptions } from "./health.js";

let testDb: TestDatabase;
let jobs: PgBoss;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  testDb = await createTestDatabase();
  jobs = createJobQueue(testDb.appUrl, { error: () => undefined, warn: () => undefined }, { applicationName: "health-test", maxConnections: 1, sendOnly: true });
  await startJobQueue(jobs);
});

afterAll(async () => {
  await jobs.stop({ graceful: false });
  await testDb.cleanup();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function ready(options: ReadinessOptions): Promise<{ statusCode: number; body: unknown; cacheControl: unknown }> {
  app = buildApp({ logLevel: "silent" });
  registerReadiness(app, options);
  const response = await app.inject({ method: "GET", url: "/health/ready" });
  return { statusCode: response.statusCode, body: response.json(), cacheControl: response.headers["cache-control"] };
}

describe("GET /health/ready (AC 44)", () => {
  it("is ready when the database answers and the job queue reaches its tables", async () => {
    expect(await ready({ db: testDb.app.db, jobs })).toEqual({
      statusCode: 200,
      body: { status: "ready", database: "ok", jobQueue: "ok" },
      cacheControl: "no-store",
    });
  });

  it("is ready with the job queue off when the server runs without it", async () => {
    expect((await ready({ db: testDb.app.db, jobs: undefined })).body).toEqual({ status: "ready", database: "ok", jobQueue: "off" });
  });

  it("is not ready when the database does not answer", async () => {
    const unreachable = createDatabase({
      connectionString: testDb.appUrl.replace(/@[^/]+\//, "@127.0.0.1:9/"),
      applicationName: "health-test",
      maxConnections: 1,
      connectionTimeoutMs: 1_000,
      statementTimeoutMs: 1_000,
      idleInTransactionTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
      onPoolError: () => undefined,
    });
    try {
      expect(await ready({ db: unreachable.db, jobs })).toMatchObject({ statusCode: 503, body: { status: "not ready", database: "failed", jobQueue: "ok" } });
    } finally {
      await unreachable.close();
    }
  });

  it("is not ready when the job queue cannot reach its tables", async () => {
    const stopped = createJobQueue(testDb.appUrl.replace(/@[^/]+\//, "@127.0.0.1:9/"), { error: () => undefined, warn: () => undefined }, {
      applicationName: "health-test",
      maxConnections: 1,
      sendOnly: true,
    });
    expect(await ready({ db: testDb.app.db, jobs: stopped })).toMatchObject({ statusCode: 503, body: { status: "not ready", database: "ok", jobQueue: "failed" } });
  });
});
