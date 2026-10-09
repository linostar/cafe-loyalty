import { randomBytes, randomUUID, webcrypto } from "node:crypto";
import { createTestDatabase, type TestDatabase } from "@cafe-loyalty/db/testing";
import {
  COUNTER_BUILT_AT_HEADER,
  devicePairProofPayload,
  deviceTokenSigningPayload,
  normalizePairingCode,
  syncEventSigningPayload,
  type DevicePublicKeyJwk,
} from "@cafe-loyalty/shared";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pg from "pg";
import { afterAll, afterEach, beforeAll, expect } from "vitest";
import type { RouteAccess } from "../access.js";
import { apiRoutes } from "../api.js";
import { customerPages } from "../customer-pages.js";
import { encryptPhone, phoneLookup, signCardQr, type CustomerSecrets } from "../customer-crypto.js";
import { buildApp } from "../app.js";
import { BackgroundTasks } from "../background.js";
import { createOwnerInvite } from "../invites.js";
import type { EmailMessage, Mailer } from "../mailer.js";

export const DASHBOARD_URL = "https://dashboard.example.test";
export const COUNTER_URL = "https://counter.example.test";
export const PASSWORD = "correct horse battery";
export const PUBLIC_URL = "https://card.example.test";

/** Test-only secrets, fresh per test file. */
export const TEST_SECRETS: CustomerSecrets = {
  phoneLookupPepper: randomBytes(32),
  phoneEncryption: { keys: [{ id: "p1", key: randomBytes(32) }] },
  cardQr: { keys: [{ id: "q1", key: randomBytes(32) }] },
};

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
/** The release build time every harness app gets: counter builds made up to 14 days before it are current. */
export const RELEASE_BUILT_AT = new Date("2026-10-01T00:00:00Z");
/** The header a current counter build sends (AC 26). */
export const CURRENT_BUILD = { [COUNTER_BUILT_AT_HEADER]: RELEASE_BUILT_AT.toISOString() };
/** A paired device's token, sent by a current counter build. */
export const withBearer = (token: string) => ({ authorization: `Bearer ${token}`, ...CURRENT_BUILD });

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

async function signText(privateKey: webcrypto.CryptoKey, text: string): Promise<string> {
  const signature = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, Buffer.from(text));
  return Buffer.from(signature).toString("base64url");
}

/** A sync event signed by the device key, as the counter app sends it: the device's ids, then `fields`. */
export async function signedEvent(device: Pick<PairedDevice, "deviceId" | "keyId" | "privateKey">, fields: Record<string, unknown>): Promise<Record<string, unknown>> {
  const raw = { deviceId: device.deviceId, keyId: device.keyId, ...fields };
  return { ...raw, signature: await signText(device.privateKey, syncEventSigningPayload(raw)) };
}

/** The `previous` proof a device sends when pairing again with `code`: its old key signs over the code and the new public key. */
export async function pairProof(device: Pick<PairedDevice, "deviceId" | "keyId" | "privateKey">, code: string, publicKey: webcrypto.JsonWebKey) {
  const previous = { deviceId: device.deviceId, keyId: device.keyId };
  const payload = devicePairProofPayload(normalizePairingCode(code) ?? code, previous, publicKey as DevicePublicKeyJwk);
  return { ...previous, signature: await signText(device.privateKey, payload) };
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

    harness: async (overrides: { customerLimits?: { signupPerCafe?: number }; secrets?: CustomerSecrets } = {}): Promise<Harness> => {
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
      await app.register(apiRoutes, {
        prefix: "/api",
        db: context.testDb.app.db,
        mailer,
        background,
        dashboardUrl: DASHBOARD_URL,
        counterUrl: COUNTER_URL,
        publicUrl: PUBLIC_URL,
        releaseBuiltAt: RELEASE_BUILT_AT,
        secrets: overrides.secrets ?? TEST_SECRETS,
      });
      await app.register(customerPages, {
        db: context.testDb.app.db,
        mailer,
        background,
        publicUrl: PUBLIC_URL,
        secrets: overrides.secrets ?? TEST_SECRETS,
        ...(overrides.customerLimits === undefined ? {} : { limits: overrides.customerLimits }),
      });
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
      const paired = await app.inject({
        method: "POST",
        url: "/api/device/pair",
        headers: CURRENT_BUILD,
        payload: { code: created.json<{ code: string }>().code, publicKey: publicJwk },
      });
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

    /**
     * A card of `cafeId` as signup makes it, with its QR signed by the test keys. With `phone`, the card is linked to
     * that number, and `phoneConfirmed` marks it as already scanned at a counter (so it may be stamped by phone).
     */
    issueCard: async (cafeId: string, options: { phone?: string; phoneConfirmed?: boolean } = {}): Promise<{ cardId: string; qr: string }> => {
      let customerId: string | null = null;
      if (options.phone !== undefined) {
        const encrypted = encryptPhone(TEST_SECRETS, options.phone);
        const { rows } = await context.admin.query<{ id: string }>(
          "INSERT INTO app.customers (phone_lookup, phone_ciphertext, phone_key_id) VALUES ($1, $2, $3) RETURNING id",
          [phoneLookup(TEST_SECRETS, options.phone), encrypted.ciphertext, encrypted.keyId],
        );
        customerId = rows[0]?.id ?? null;
      }
      const { rows } = await context.admin.query<{ id: string }>(
        `INSERT INTO app.cards (cafe_id, customer_id, web_secret_hash, privacy_accepted_at, phone_confirmed_at)
         VALUES ($1, $2, $3, now(), CASE WHEN $4 THEN now() END) RETURNING id`,
        [cafeId, customerId, randomBytes(32), options.phoneConfirmed === true],
      );
      const cardId = rows[0]?.id ?? "missing";
      return { cardId, qr: signCardQr(TEST_SECRETS, { cardId, cafeId, epoch: 1 }) };
    },

    auditActions: async (cafeId: string): Promise<string[]> => {
      const { rows } = await context.admin.query<{ action: string }>("SELECT action FROM app.audit_log WHERE cafe_id = $1 ORDER BY id", [cafeId]);
      return rows.map((row) => row.action);
    },
  };
  return context;
}
