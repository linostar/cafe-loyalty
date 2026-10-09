import { randomUUID, webcrypto } from "node:crypto";
import { createTestDatabase, type TestDatabase } from "@cafe-loyalty/db/testing";
import { deviceTokenSigningPayload } from "@cafe-loyalty/shared";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pg from "pg";
import { afterAll, afterEach, beforeAll, expect } from "vitest";
import type { RouteAccess } from "../access.js";
import { apiRoutes } from "../api.js";
import { buildApp } from "../app.js";
import { BackgroundTasks } from "../background.js";
import { createOwnerInvite } from "../invites.js";
import type { EmailMessage, Mailer } from "../mailer.js";

export const DASHBOARD_URL = "https://dashboard.example.test";
export const COUNTER_URL = "https://counter.example.test";
export const PASSWORD = "correct horse battery";

export class FakeMailer implements Mailer {
  readonly sent: EmailMessage[] = [];
  /** When set, send waits for it, to show that a request does not wait for its email. */
  gate: Promise<void> | undefined;
  failWith: Error | undefined;

  async send(message: EmailMessage): Promise<void> {
    await this.gate;
    if (this.failWith !== undefined) {
      throw this.failWith;
    }
    this.sent.push(message);
  }

  verify(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {
    // Nothing to release.
  }
}

export interface RegisteredRoute {
  method: string;
  url: string;
  access: RouteAccess | undefined;
}

export interface Harness {
  app: FastifyInstance;
  mailer: FakeMailer;
  background: BackgroundTasks;
  logs: string[];
  /** Every route the API registered, with its declared access. */
  routes: RegisteredRoute[];
}

export const uniqueEmail = (): string => `owner-${randomUUID()}@example.com`;

export function cookieToken(response: LightMyRequestResponse): string {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  const match = /^__Host-cl_session=([A-Za-z0-9_-]{43});/.exec(value ?? "");
  if (match?.[1] === undefined) {
    throw new Error(`No session cookie in the response (status ${String(response.statusCode)}).`);
  }
  return match[1];
}

export const withCookie = (token: string) => ({ cookie: `__Host-cl_session=${token}` });
export const withBearer = (token: string) => ({ authorization: `Bearer ${token}` });

export async function signIn(app: FastifyInstance, email: string, password = PASSWORD, remoteAddress = "203.0.113.1"): Promise<LightMyRequestResponse> {
  return app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password }, remoteAddress });
}

export interface SignedUpOwner {
  email: string;
  cafeId: string;
  ownerId: string;
  session: string;
}

export interface PairedDevice {
  deviceId: string;
  keyId: string;
  accessToken: string;
  privateKey: webcrypto.CryptoKey;
}

/** A device key pair as the counter app makes it: non-extractable private key, public key exported as a JWK. */
export async function deviceKeyPair(): Promise<{ privateKey: webcrypto.CryptoKey; publicJwk: webcrypto.JsonWebKey }> {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { privateKey: pair.privateKey, publicJwk: await webcrypto.subtle.exportKey("jwk", pair.publicKey) };
}

/** A token renewal request signed by the device key, as the counter app sends it. */
export async function signedRenewal(device: Pick<PairedDevice, "deviceId" | "keyId" | "privateKey">, issuedAt = new Date().toISOString()) {
  const fields = { deviceId: device.deviceId, keyId: device.keyId, issuedAt };
  const signature = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, device.privateKey, Buffer.from(deviceTokenSigningPayload(fields)));
  return { ...fields, signature: Buffer.from(signature).toString("base64url") };
}

/**
 * Registers a test database for the calling test file (created before its tests, dropped after) and returns
 * helpers to build apps on it. Each harness() is a fresh app, so rate limits start empty.
 */
export function useApiHarness() {
  let testDb: TestDatabase | undefined;
  let admin: pg.Client | undefined;
  const open: Harness[] = [];
  const holders: pg.Client[] = [];

  beforeAll(async () => {
    testDb = await createTestDatabase();
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
  });

  afterAll(async () => {
    await admin?.end();
    await testDb?.cleanup();
  });

  afterEach(async () => {
    // A test that failed before releasing its hold must not leave the row locked for the next one.
    for (const holder of holders.splice(0)) {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end().catch(() => undefined);
    }
    for (const created of open.splice(0)) {
      await created.background.drain();
      await created.app.close();
    }
  });

  const context = {
    get testDb(): TestDatabase {
      if (testDb === undefined) {
        throw new Error("The test database is created in beforeAll; use it inside a test.");
      }
      return testDb;
    },
    get admin(): pg.Client {
      if (admin === undefined) {
        throw new Error("The admin connection is opened in beforeAll; use it inside a test.");
      }
      return admin;
    },

    harness: async (): Promise<Harness> => {
      const logs: string[] = [];
      const routes: RegisteredRoute[] = [];
      const app = buildApp({ logLevel: "info", logDestination: { write: (line) => logs.push(line) } });
      app.addHook("onRoute", (route) => {
        for (const method of [route.method].flat()) {
          routes.push({ method, url: route.url, access: route.config?.access });
        }
      });
      const mailer = new FakeMailer();
      const background = new BackgroundTasks(app.log);
      await app.register(apiRoutes, { prefix: "/api", db: context.testDb.app.db, mailer, background, dashboardUrl: DASHBOARD_URL, counterUrl: COUNTER_URL });
      await app.ready();
      const created = { app, mailer, background, logs, routes };
      open.push(created);
      return created;
    },

    invite: (cafeName = "Café Test"): Promise<{ cafeId: string; token: string }> =>
      createOwnerInvite(context.testDb.app.db, { newCafeName: cafeName }),

    signUp: async (app: FastifyInstance, email = uniqueEmail()): Promise<SignedUpOwner> => {
      const { token, cafeId } = await context.invite();
      const response = await app.inject({ method: "POST", url: "/api/auth/signup", payload: { inviteToken: token, email, password: PASSWORD } });
      expect(response.statusCode).toBe(201);
      const body = response.json<{ owner: { id: string } }>();
      return { email, cafeId, ownerId: body.owner.id, session: cookieToken(response) };
    },

    /** Creates a pairing code as the owner and pairs a new device with it. */
    pairDevice: async (app: FastifyInstance, owner: SignedUpOwner, deviceName = "Counter 1"): Promise<PairedDevice> => {
      const created = await app.inject({ method: "POST", url: "/api/devices/pairing-codes", headers: withCookie(owner.session), payload: { deviceName } });
      expect(created.statusCode).toBe(201);
      const { privateKey, publicJwk } = await deviceKeyPair();
      const paired = await app.inject({ method: "POST", url: "/api/device/pair", payload: { code: created.json<{ code: string }>().code, publicKey: publicJwk } });
      expect(paired.statusCode).toBe(201);
      const body = paired.json<{ deviceId: string; keyId: string; accessToken: string }>();
      return { deviceId: body.deviceId, keyId: body.keyId, accessToken: body.accessToken, privateKey };
    },

    /**
     * Locks an owner row from a second connection, so a test can let a request reach that lock, change the row,
     * and release it: a deterministic interleaving instead of a timing guess.
     */
    holdOwnerRow: async (ownerId: string, mode: "FOR NO KEY UPDATE" | "FOR UPDATE" = "FOR NO KEY UPDATE") => {
      const holder = new pg.Client({ connectionString: context.testDb.adminUrl });
      await holder.connect();
      holders.push(holder);
      await holder.query("BEGIN");
      // The same lock mode the app takes on owner rows unless a test asks otherwise.
      await holder.query(`SELECT 1 FROM app.owners WHERE id = $1 ${mode}`, [ownerId]);
      const { rows: pidRows } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const holderPid = pidRows[0]?.pid ?? -1;
      return {
        /** Resolves once a request is waiting on this holder's lock. */
        untilBlocked: async (): Promise<void> => {
          for (let attempt = 0; attempt < 200; attempt += 1) {
            const { rows } = await context.admin.query<{ n: number }>(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid <> $1 AND pg_blocking_pids(pid) @> ARRAY[$1::int]",
              [holderPid],
            );
            if ((rows[0]?.n ?? 0) > 0) {
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          throw new Error("No request blocked on the held owner row within 5 seconds.");
        },
        /** Runs `change` on the holding connection (which bypasses row-level security), then commits. */
        release: async (change?: (client: pg.Client) => Promise<unknown>): Promise<void> => {
          await change?.(holder);
          await holder.query("COMMIT");
          holders.splice(holders.indexOf(holder), 1);
          await holder.end();
        },
      };
    },

    auditActions: async (cafeId: string): Promise<string[]> => {
      const { rows } = await context.admin.query<{ action: string }>("SELECT action FROM app.audit_log WHERE cafe_id = $1 ORDER BY id", [cafeId]);
      return rows.map((row) => row.action);
    },
  };
  return context;
}
