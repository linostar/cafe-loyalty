import { randomUUID } from "node:crypto";
import { createTestDatabase, type TestDatabase } from "@cafe-loyalty/db/testing";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { BackgroundTasks } from "./background.js";
import { hashToken, newToken } from "./credentials.js";
import { createOwnerInvite } from "./invites.js";
import { EmailDeliveryError, type EmailMessage, type Mailer } from "./mailer.js";
import { RESET_REQUESTED_MESSAGE, ownerAuthRoutes } from "./owner-auth.js";

const DASHBOARD_URL = "https://dashboard.example.test";
const PASSWORD = "correct horse battery";

class FakeMailer implements Mailer {
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

  close(): void {
    // Nothing to release.
  }
}

interface Harness {
  app: FastifyInstance;
  mailer: FakeMailer;
  background: BackgroundTasks;
  logs: string[];
}

let testDb: TestDatabase;
let admin: pg.Client;
const open: Harness[] = [];

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = new pg.Client({ connectionString: testDb.adminUrl });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
  await testDb.cleanup();
});

afterEach(async () => {
  for (const harness of open.splice(0)) {
    await harness.background.drain();
    await harness.app.close();
  }
});

/** A fresh app (with fresh rate limits) on the shared test database. */
async function harness(): Promise<Harness> {
  const logs: string[] = [];
  const app = buildApp({ logLevel: "info", logDestination: { write: (line) => logs.push(line) } });
  const mailer = new FakeMailer();
  const background = new BackgroundTasks(app.log);
  await app.register(ownerAuthRoutes, { prefix: "/api/auth", db: testDb.app.db, mailer, background, dashboardUrl: DASHBOARD_URL });
  await app.ready();
  const created = { app, mailer, background, logs };
  open.push(created);
  return created;
}

const uniqueEmail = (): string => `owner-${randomUUID()}@example.com`;

function cookieToken(response: LightMyRequestResponse): string {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  const match = /^__Host-cl_session=([A-Za-z0-9_-]{43});/.exec(value ?? "");
  if (match?.[1] === undefined) {
    throw new Error(`No session cookie in the response (status ${String(response.statusCode)}).`);
  }
  return match[1];
}

const withCookie = (token: string) => ({ cookie: `__Host-cl_session=${token}` });

async function invite(cafeName = "Café Test"): Promise<{ cafeId: string; token: string }> {
  return createOwnerInvite(testDb.app.db, { newCafeName: cafeName });
}

async function signUp(app: FastifyInstance, email = uniqueEmail()): Promise<{ email: string; cafeId: string; ownerId: string; session: string }> {
  const { token, cafeId } = await invite();
  const response = await app.inject({ method: "POST", url: "/api/auth/signup", payload: { inviteToken: token, email, password: PASSWORD } });
  expect(response.statusCode).toBe(201);
  const body = response.json<{ owner: { id: string } }>();
  return { email, cafeId, ownerId: body.owner.id, session: cookieToken(response) };
}

async function signIn(app: FastifyInstance, email: string, password = PASSWORD, remoteAddress = "203.0.113.1"): Promise<LightMyRequestResponse> {
  return app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password }, remoteAddress });
}

async function auditActions(cafeId: string): Promise<string[]> {
  const { rows } = await admin.query<{ action: string }>("SELECT action FROM app.audit_log WHERE cafe_id = $1 ORDER BY id", [cafeId]);
  return rows.map((row) => row.action);
}

describe("signup", () => {
  it("creates the invited café's owner and signs them in", async () => {
    const { app } = await harness();
    const { token, cafeId } = await invite("Café Najjar");
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { inviteToken: token, email: " Rana@Example.COM ", password: PASSWORD },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<{ owner: { id: string; email: string }; cafe: unknown }>();
    expect(body).toEqual({ owner: { id: expect.any(String) as unknown, email: "rana@example.com" }, cafe: { id: cafeId, name: "Café Najjar" } });
    expect(response.headers["set-cookie"]).toMatch(/^__Host-cl_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000$/);
    expect(response.headers["cache-control"]).toBe("no-store");

    const session = await app.inject({ method: "GET", url: "/api/auth/session", headers: withCookie(cookieToken(response)) });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toEqual(body);

    const stored = await admin.query<{ password_hash: string }>("SELECT password_hash FROM app.owners WHERE id = $1", [body.owner.id]);
    expect(stored.rows[0]?.password_hash).toMatch(/^\$argon2id\$/);
    expect(await auditActions(cafeId)).toEqual(["cafe.created", "owner_invite.created", "owner.signed_up"]);
  });

  it("accepts each invite once", async () => {
    const { app } = await harness();
    const { token } = await invite();
    const first = await app.inject({ method: "POST", url: "/api/auth/signup", payload: { inviteToken: token, email: uniqueEmail(), password: PASSWORD } });
    const second = await app.inject({ method: "POST", url: "/api/auth/signup", payload: { inviteToken: token, email: uniqueEmail(), password: PASSWORD } });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(410);
    expect(second.json()).toMatchObject({ code: "LINK_EXPIRED", retryable: false });
  });

  it("refuses an expired or unknown invite", async () => {
    const { app } = await harness();
    const { token } = await invite();
    await admin.query("UPDATE app.owner_invites SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [hashToken(token)]);
    for (const inviteToken of [token, newToken()]) {
      const response = await app.inject({ method: "POST", url: "/api/auth/signup", payload: { inviteToken, email: uniqueEmail(), password: PASSWORD } });
      expect(response.statusCode).toBe(410);
    }
  });

  it("keeps the invite usable when the email already has an account", async () => {
    const { app } = await harness();
    const existing = await signUp(app);
    const { token } = await invite();
    const taken = await app.inject({ method: "POST", url: "/api/auth/signup", payload: { inviteToken: token, email: existing.email, password: PASSWORD } });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ code: "CONFLICT" });
    const retry = await app.inject({ method: "POST", url: "/api/auth/signup", payload: { inviteToken: token, email: uniqueEmail(), password: PASSWORD } });
    expect(retry.statusCode).toBe(201);
  });

  it("requires a password of at least 10 characters", async () => {
    const { app } = await harness();
    const { token } = await invite();
    const response = await app.inject({ method: "POST", url: "/api/auth/signup", payload: { inviteToken: token, email: uniqueEmail(), password: "short" } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "VALIDATION_FAILED", details: [{ path: "password", issue: "Use at least 10 characters." }] });
  });
});

describe("invites", () => {
  it("can be issued again for an existing café, and never for an unknown one", async () => {
    const { app } = await harness();
    const owner = await signUp(app);
    const again = await createOwnerInvite(testDb.app.db, { cafeId: owner.cafeId });
    const second = await app.inject({ method: "POST", url: "/api/auth/signup", payload: { inviteToken: again.token, email: uniqueEmail(), password: PASSWORD } });
    expect(second.statusCode).toBe(201);
    expect(second.json()).toMatchObject({ cafe: { id: owner.cafeId } });
    await expect(createOwnerInvite(testDb.app.db, { cafeId: randomUUID() })).rejects.toThrow("No café has this id.");
  });
});

describe("sign-in", () => {
  it("answers a wrong password and an unknown email the same way", async () => {
    const { app } = await harness();
    const owner = await signUp(app);
    const wrongPassword = await signIn(app, owner.email, "wrong password!");
    const unknownEmail = await signIn(app, uniqueEmail());
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.body).toBe(unknownEmail.body);
    expect(wrongPassword.json()).toMatchObject({ code: "UNAUTHENTICATED", retryable: false });
    expect(wrongPassword.headers["set-cookie"]).toBeUndefined();
  });

  it("signs in whatever the email's case, with a new session each time", async () => {
    const { app } = await harness();
    const owner = await signUp(app);
    const response = await signIn(app, owner.email.toUpperCase());
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ owner: { id: owner.ownerId, email: owner.email }, cafe: { id: owner.cafeId } });
    expect(cookieToken(response)).not.toBe(owner.session);
    expect(await auditActions(owner.cafeId)).toContain("owner.signed_in");
  });

  it("limits failed attempts per account from one address, without locking the owner out elsewhere", async () => {
    const { app } = await harness();
    const owner = await signUp(app);
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      expect((await signIn(app, owner.email, "wrong password!", "198.51.100.1")).statusCode).toBe(401);
    }
    const blocked = await signIn(app, owner.email, PASSWORD, "198.51.100.1");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ code: "RATE_LIMITED", retryable: true });
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect((await signIn(app, owner.email, PASSWORD, "198.51.100.2")).statusCode).toBe(200);
  });

  it("holds the limit against parallel attempts", async () => {
    const { app } = await harness();
    const owner = await signUp(app);
    const replies = await Promise.all(Array.from({ length: 15 }, () => signIn(app, owner.email, "wrong password!", "198.51.100.3")));
    expect(replies.filter((reply) => reply.statusCode === 401)).toHaveLength(10);
    expect(replies.filter((reply) => reply.statusCode === 429)).toHaveLength(5);
  });

  it("never counts correct passwords", async () => {
    const { app } = await harness();
    const owner = await signUp(app);
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      expect((await signIn(app, owner.email)).statusCode).toBe(200);
    }
  });

  it("caps failed attempts per account across addresses", async () => {
    const { app } = await harness();
    const owner = await signUp(app);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const address = `198.51.100.${String(10 + Math.floor(attempt / 10))}`;
      expect((await signIn(app, owner.email, "wrong password!", address)).statusCode).toBe(401);
    }
    expect((await signIn(app, owner.email, PASSWORD, "198.51.100.250")).statusCode).toBe(429);
  });

  it("counts an IPv6 /64 network as one address", async () => {
    const { app } = await harness();
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      expect((await signIn(app, uniqueEmail(), "wrong password!", `2001:db8:1:2::${attempt.toString(16)}`)).statusCode).toBe(401);
    }
    expect((await signIn(app, uniqueEmail(), "wrong password!", "2001:db8:1:2:ffff::1")).statusCode).toBe(429);
  });

  it("limits attempts per address, across accounts", async () => {
    const { app } = await harness();
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      expect((await signIn(app, uniqueEmail(), "wrong password!", "192.0.2.7")).statusCode).toBe(401);
    }
    expect((await signIn(app, uniqueEmail(), "wrong password!", "192.0.2.7")).statusCode).toBe(429);
    expect((await signIn(app, uniqueEmail(), "wrong password!", "192.0.2.8")).statusCode).toBe(401);
  });
});

describe("sessions", () => {
  it("require the cookie", async () => {
    const { app } = await harness();
    const response = await app.inject({ method: "GET", url: "/api/auth/session" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ code: "UNAUTHENTICATED", message: "Your session has ended. Sign in again.", retryable: false });
  });

  it("end after 7 days idle and clear the cookie", async () => {
    const { app } = await harness();
    const owner = await signUp(app);
    await admin.query("UPDATE app.owner_sessions SET last_seen_at = now() - interval '7 days 1 second' WHERE token_hash = $1", [hashToken(owner.session)]);
    const response = await app.inject({ method: "GET", url: "/api/auth/session", headers: withCookie(owner.session) });
    expect(response.statusCode).toBe(401);
    expect(response.headers["set-cookie"]).toContain("Max-Age=0");
  });

  it("end at their absolute expiry however recently used", async () => {
    const { app } = await harness();
    const owner = await signUp(app);
    await admin.query("UPDATE app.owner_sessions SET expires_at = now() - interval '1 second', last_seen_at = now() WHERE token_hash = $1", [hashToken(owner.session)]);
    expect((await app.inject({ method: "GET", url: "/api/auth/session", headers: withCookie(owner.session) })).statusCode).toBe(401);
  });

  it("record use, so an active session stays open", async () => {
    const { app } = await harness();
    const owner = await signUp(app);
    await admin.query("UPDATE app.owner_sessions SET last_seen_at = now() - interval '6 days' WHERE token_hash = $1", [hashToken(owner.session)]);
    expect((await app.inject({ method: "GET", url: "/api/auth/session", headers: withCookie(owner.session) })).statusCode).toBe(200);
    const { rows } = await admin.query<{ recent: boolean }>(
      "SELECT last_seen_at > now() - interval '1 minute' AS recent FROM app.owner_sessions WHERE token_hash = $1",
      [hashToken(owner.session)],
    );
    expect(rows[0]?.recent).toBe(true);
  });

  it("are stored as hashes only", async () => {
    const { app } = await harness();
    const owner = await signUp(app);
    const { rows } = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM app.owner_sessions WHERE token_hash = $1", [
      Buffer.from(owner.session),
    ]);
    expect(rows[0]?.n).toBe(0);
  });
});

describe("sign-out", () => {
  it("ends every session of the owner and clears the cookie", async () => {
    const { app } = await harness();
    const owner = await signUp(app);
    const other = cookieToken(await signIn(app, owner.email));
    const response = await app.inject({ method: "POST", url: "/api/auth/logout", headers: withCookie(owner.session) });
    expect(response.statusCode).toBe(204);
    expect(response.headers["set-cookie"]).toContain("Max-Age=0");
    for (const token of [owner.session, other]) {
      expect((await app.inject({ method: "GET", url: "/api/auth/session", headers: withCookie(token) })).statusCode).toBe(401);
    }
    expect(await auditActions(owner.cafeId)).toContain("owner.signed_out");
  });

  it("succeeds without a session", async () => {
    const { app } = await harness();
    expect((await app.inject({ method: "POST", url: "/api/auth/logout" })).statusCode).toBe(204);
  });
});

describe("password change", () => {
  it("refuses a wrong current password", async () => {
    const { app } = await harness();
    const owner = await signUp(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: withCookie(owner.session),
      payload: { currentPassword: "not the password", newPassword: "a brand new password" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "VALIDATION_FAILED", details: [{ path: "currentPassword" }] });
  });

  it("sets the new password and ends every session and reset link", async () => {
    const { app, background } = await harness();
    const owner = await signUp(app);
    const other = cookieToken(await signIn(app, owner.email));
    await app.inject({ method: "POST", url: "/api/auth/password-reset", payload: { email: owner.email } });
    await background.drain();

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: withCookie(owner.session),
      payload: { currentPassword: PASSWORD, newPassword: "a brand new password" },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers["set-cookie"]).toContain("Max-Age=0");
    for (const token of [owner.session, other]) {
      expect((await app.inject({ method: "GET", url: "/api/auth/session", headers: withCookie(token) })).statusCode).toBe(401);
    }
    const resets = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM app.password_reset_tokens WHERE owner_id = $1", [owner.ownerId]);
    expect(resets.rows[0]?.n).toBe(0);
    expect((await signIn(app, owner.email)).statusCode).toBe(401);
    expect((await signIn(app, owner.email, "a brand new password")).statusCode).toBe(200);
    expect(await auditActions(owner.cafeId)).toContain("owner.password_changed");
  });
});

describe("password reset", () => {
  function linkToken(message: EmailMessage | undefined): string {
    const match = /https:\/\/dashboard\.example\.test\/reset-password#token=([A-Za-z0-9_-]{43})/.exec(message?.text ?? "");
    if (match?.[1] === undefined) {
      throw new Error("No reset link in the email.");
    }
    return match[1];
  }

  async function requestReset(h: Harness, email: string): Promise<LightMyRequestResponse> {
    const response = await h.app.inject({ method: "POST", url: "/api/auth/password-reset", payload: { email } });
    await h.background.drain();
    return response;
  }

  it("answers known and unknown emails the same way and emails only a known one", async () => {
    const h = await harness();
    const owner = await signUp(h.app);
    const known = await requestReset(h, owner.email);
    const unknown = await requestReset(h, uniqueEmail());
    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(known.body).toBe(unknown.body);
    expect(known.json()).toEqual({ message: RESET_REQUESTED_MESSAGE });
    expect(h.mailer.sent).toHaveLength(1);
    expect(h.mailer.sent[0]).toMatchObject({ to: owner.email, subject: "Reset your Cafe Loyalty password" });
  });

  it("replies before looking the email up or sending anything", async () => {
    const h = await harness();
    const owner = await signUp(h.app);
    let release: () => void = () => undefined;
    h.mailer.gate = new Promise((resolve) => {
      release = resolve;
    });
    const response = await h.app.inject({ method: "POST", url: "/api/auth/password-reset", payload: { email: owner.email } });
    expect(response.statusCode).toBe(202);
    expect(h.mailer.sent).toHaveLength(0);
    release();
    await h.background.drain();
    expect(h.mailer.sent).toHaveLength(1);
  });

  it("stores only the link's hash, valid for 30 minutes", async () => {
    const h = await harness();
    const owner = await signUp(h.app);
    await requestReset(h, owner.email);
    const token = linkToken(h.mailer.sent[0]);
    const { rows } = await admin.query<{ token_hash: Buffer; lifetime_seconds: number }>(
      "SELECT token_hash, extract(epoch FROM expires_at - created_at)::int AS lifetime_seconds FROM app.password_reset_tokens WHERE owner_id = $1",
      [owner.ownerId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash.equals(hashToken(token))).toBe(true);
    expect(rows[0]?.lifetime_seconds).toBe(1800);
  });

  it("sets the password once per link, ends every session and works only for the newest link", async () => {
    const h = await harness();
    const owner = await signUp(h.app);
    await requestReset(h, owner.email);
    await requestReset(h, owner.email);
    const [older, newer] = [linkToken(h.mailer.sent[0]), linkToken(h.mailer.sent[1])];
    const complete = (token: string) =>
      h.app.inject({ method: "POST", url: "/api/auth/password-reset/complete", payload: { token, password: "reset password 123" } });

    expect((await complete(older)).statusCode).toBe(410);
    const done = await complete(newer);
    expect(done.statusCode).toBe(204);
    const again = await complete(newer);
    expect(again.statusCode).toBe(410);
    expect(again.json()).toMatchObject({ code: "LINK_EXPIRED", retryable: false });

    expect((await h.app.inject({ method: "GET", url: "/api/auth/session", headers: withCookie(owner.session) })).statusCode).toBe(401);
    expect((await signIn(h.app, owner.email)).statusCode).toBe(401);
    expect((await signIn(h.app, owner.email, "reset password 123")).statusCode).toBe(200);
    expect(await auditActions(owner.cafeId)).toEqual(
      expect.arrayContaining(["owner.password_reset_requested", "owner.password_reset"]) as unknown,
    );
  });

  it("refuses an expired link", async () => {
    const h = await harness();
    const owner = await signUp(h.app);
    await requestReset(h, owner.email);
    await admin.query("UPDATE app.password_reset_tokens SET expires_at = now() - interval '1 second' WHERE owner_id = $1", [owner.ownerId]);
    const response = await h.app.inject({
      method: "POST",
      url: "/api/auth/password-reset/complete",
      payload: { token: linkToken(h.mailer.sent[0]), password: "reset password 123" },
    });
    expect(response.statusCode).toBe(410);
  });

  it("leaves one working link when requests overlap", async () => {
    const h = await harness();
    const owner = await signUp(h.app);
    await Promise.all([1, 2, 3].map(() => h.app.inject({ method: "POST", url: "/api/auth/password-reset", payload: { email: owner.email } })));
    await h.background.drain();
    const { rows } = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM app.password_reset_tokens WHERE owner_id = $1", [owner.ownerId]);
    expect(rows[0]?.n).toBe(1);
  });

  it("limits requests per email", async () => {
    const h = await harness();
    const email = uniqueEmail();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect((await requestReset(h, email)).statusCode).toBe(202);
    }
    expect((await requestReset(h, email)).statusCode).toBe(429);
  });

  it("logs a failed email with the café and without the address", async () => {
    const h = await harness();
    const owner = await signUp(h.app);
    // What the SMTP mailer throws when the server rejects the recipient.
    h.mailer.failWith = new EmailDeliveryError(Object.assign(new Error(`550 mailbox ${owner.email} unavailable`), { code: "EENVELOPE", responseCode: 550 }));
    expect((await requestReset(h, owner.email)).statusCode).toBe(202);
    const failure = h.logs.find((line) => line.includes("password reset email failed")) ?? "";
    expect(JSON.parse(failure)).toMatchObject({ level: 50, cafeId: owner.cafeId, err: { smtpCode: "EENVELOPE", responseCode: 550 } });
    expect(h.logs.join("")).not.toContain(owner.email);
  });
});

describe("logs", () => {
  it("never contain emails, passwords or tokens", async () => {
    const h = await harness();
    const owner = await signUp(h.app);
    await signIn(h.app, owner.email, "wrong password!");
    const session = cookieToken(await signIn(h.app, owner.email));
    await h.app.inject({ method: "GET", url: "/api/auth/session", headers: withCookie(session) });
    await h.app.inject({ method: "POST", url: "/api/auth/password-reset", payload: { email: owner.email } });
    await h.background.drain();
    const reset = /token=([A-Za-z0-9_-]{43})/.exec(h.mailer.sent[0]?.text ?? "")?.[1] ?? "missing";
    await h.app.inject({ method: "POST", url: "/api/auth/password-reset/complete", payload: { token: reset, password: "reset password 123" } });

    const output = h.logs.join("");
    expect(output).toContain("owner signed in");
    for (const secret of [owner.email, PASSWORD, "wrong password!", "reset password 123", owner.session, session, reset]) {
      expect(output).not.toContain(secret);
    }
  });
});
