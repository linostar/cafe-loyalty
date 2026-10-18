import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { syncResponseSchema } from "@cafe-loyalty/shared";
import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { hashToken } from "./credentials.js";
import { setOperatorPassword } from "./operators.js";
import { DASHBOARD_URL, PASSWORD, cookieToken, signedEvent, useApiHarness, withBearer, withCookie } from "./testing/api-harness.js";

const context = useApiHarness();
const { harness, signUp, pairDevice, issueCard, auditActions } = context;

const formBody = (fields: Record<string, string>) => ({
  headers: { "content-type": "application/x-www-form-urlencoded" },
  payload: new URLSearchParams(fields).toString(),
});

function operatorToken(response: LightMyRequestResponse): string {
  const header = response.headers["set-cookie"];
  const match = /^__Host-cl_operator=([A-Za-z0-9_-]{43});/.exec(String(Array.isArray(header) ? header[0] : header));
  if (match?.[1] === undefined) {
    throw new Error(`No operator cookie in the response (status ${String(response.statusCode)}).`);
  }
  return match[1];
}

/** A harness app with a café (owner, order type, barista, paired counter) and a signed-in operator. */
async function adminApp() {
  const h = await harness();
  const owner = await signUp(h.app);
  const asOwner = (method: "GET" | "POST" | "PUT", url: string, payload: Record<string, unknown> = {}) =>
    h.app.inject({ method, url, headers: withCookie(owner.session), ...(method === "GET" ? {} : { payload }) });
  const coffee =
    (await asOwner("POST", "/api/cafe/order-types", { nameAr: "قهوة", nameEn: "Coffee", priceCents: 300, costCents: 90, stampsEarned: 1, active: true })).json<{ orderTypes: { id: string }[] }>()
      .orderTypes[0]?.id ?? "missing";
  const staffId = (await asOwner("POST", "/api/staff", { name: "Rami", pin: "482913" })).json<{ staff: { id: string }[] }>().staff[0]?.id ?? "missing";
  const device = await pairDevice(h.app, owner);
  const email = `operator-${randomUUID()}@example.com`;
  const { password } = await setOperatorPassword(context.testDb.app.db, email);
  const login = await h.app.inject({ method: "POST", url: "/api/admin/login", payload: { email, password } });
  expect(login.statusCode).toBe(200);
  const operator = operatorToken(login);
  const asOperator = (method: "GET" | "POST" | "PATCH", url: string, payload: Record<string, unknown> = {}) =>
    h.app.inject({ method, url, headers: { cookie: `__Host-cl_operator=${operator}` }, ...(method === "GET" ? {} : { payload }) });
  return { ...h, owner, asOwner, coffee, staffId, device, email, password, operator, asOperator };
}

let sequence = 0;
async function stamp(app: Awaited<ReturnType<typeof adminApp>>, qr: string): Promise<string> {
  sequence += 1;
  const event = await signedEvent(app.device, {
    eventId: randomUUID(),
    staffId: app.staffId,
    sequence,
    schemaVersion: 1,
    type: "visit.recorded",
    occurredAt: new Date().toISOString(),
    payload: { card: { kind: "qr", token: qr }, items: [{ orderTypeId: app.coffee, quantity: 1, unitPriceCents: 300, unitCostCents: 90, catalogVersion: 1 }], totalCents: 300 },
  });
  const response = await app.app.inject({ method: "POST", url: "/api/device/sync", headers: withBearer(app.device.accessToken), payload: { events: [event] } });
  return syncResponseSchema.parse(response.json()).results[0]?.code ?? "missing";
}

describe("operator accounts (AC 39)", () => {
  it("sign in with the password create-operator printed, and sign out of every session", async () => {
    const app = await adminApp();
    expect((await app.asOperator("GET", "/api/admin/session")).json()).toMatchObject({ operator: { email: app.email } });
    const wrong = await app.app.inject({ method: "POST", url: "/api/admin/login", payload: { email: app.email, password: "not the password" } });
    expect(wrong.statusCode).toBe(401);
    const unknown = await app.app.inject({ method: "POST", url: "/api/admin/login", payload: { email: "nobody@example.com", password: app.password } });
    expect(unknown.json()).toEqual(wrong.json());
    // An owner's login does not take an operator's credentials, nor the other way round.
    expect((await app.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: app.email, password: app.password } })).statusCode).toBe(401);

    const second = operatorToken(await app.app.inject({ method: "POST", url: "/api/admin/login", payload: { email: app.email, password: app.password } }));
    const loggedOut = await app.app.inject({ method: "POST", url: "/api/admin/logout", headers: { cookie: `__Host-cl_operator=${second}`, "content-type": "application/json" }, payload: {} });
    expect(loggedOut.statusCode).toBe(204);
    expect(String(loggedOut.headers["set-cookie"])).toContain("__Host-cl_operator=; ");
    expect((await app.asOperator("GET", "/api/admin/session")).statusCode).toBe(401);
  });

  it("lose every session and the old password when create-operator runs again", async () => {
    const app = await adminApp();
    const replaced = await setOperatorPassword(context.testDb.app.db, app.email);
    expect(replaced.created).toBe(false);
    expect(replaced.password).not.toBe(app.password);
    expect((await app.asOperator("GET", "/api/admin/session")).statusCode).toBe(401);
    expect((await app.app.inject({ method: "POST", url: "/api/admin/login", payload: { email: app.email, password: app.password } })).statusCode).toBe(401);
    expect((await app.app.inject({ method: "POST", url: "/api/admin/login", payload: { email: app.email, password: replaced.password } })).statusCode).toBe(200);
  });

  it("end after 2 hours without a request or 12 hours after sign-in, and stay alive while used", async () => {
    const app = await adminApp();
    const age = (column: "last_seen_at" | "expires_at", interval: string) =>
      context.admin.query(`UPDATE app.operator_sessions SET ${column} = now() ${interval} WHERE token_hash = $1`, [hashToken(app.operator)]);
    // Just under the idle limit: still signed in, and the request counts as activity.
    await age("last_seen_at", "- interval '1 hour 59 minutes'");
    expect((await app.asOperator("GET", "/api/admin/session")).statusCode).toBe(200);
    const { rows } = await context.admin.query<{ idle: number }>("SELECT extract(epoch FROM now() - last_seen_at)::int AS idle FROM app.operator_sessions WHERE token_hash = $1", [
      hashToken(app.operator),
    ]);
    expect(rows[0]?.idle).toBeLessThan(60);
    await age("last_seen_at", "- interval '2 hours 1 minute'");
    const idle = await app.asOperator("GET", "/api/admin/session");
    expect(idle.statusCode).toBe(401);
    expect(String(idle.headers["set-cookie"])).toContain("__Host-cl_operator=; ");

    const fresh = await adminApp();
    // Sign-in sets the 12-hour end, on the session and on the cookie.
    const { rows: lifetimes } = await context.admin.query<{ hours: number }>(
      "SELECT round(extract(epoch FROM expires_at - created_at) / 3600)::int AS hours FROM app.operator_sessions WHERE token_hash = $1",
      [hashToken(fresh.operator)],
    );
    expect(lifetimes).toEqual([{ hours: 12 }]);
    const signIn = await fresh.app.inject({ method: "POST", url: "/api/admin/login", payload: { email: fresh.email, password: fresh.password } });
    expect(String(signIn.headers["set-cookie"])).toContain("Max-Age=43200");
    await context.admin.query("UPDATE app.operator_sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [hashToken(fresh.operator)]);
    expect((await fresh.asOperator("GET", "/api/admin/session")).statusCode).toBe(401);
  });

  it("limit failed sign-ins per account and address, without counting the right password", async () => {
    const app = await adminApp();
    const login = (password: string) => app.app.inject({ method: "POST", url: "/api/admin/login", payload: { email: app.email, password }, remoteAddress: "198.51.100.9" });
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect((await login("not the password")).statusCode).toBe(401);
    }
    // A right password is refunded, so it does not use up the fifth try.
    expect((await login(app.password)).statusCode).toBe(200);
    expect((await login("not the password")).statusCode).toBe(401);
    const blocked = await login(app.password);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    // Another address is not blocked by this one.
    expect((await app.app.inject({ method: "POST", url: "/api/admin/login", payload: { email: app.email, password: app.password }, remoteAddress: "198.51.100.10" })).statusCode).toBe(200);
  });

  it("change their password with the current one, ending every session, and refuse a wrong one by its field", async () => {
    const app = await adminApp();
    const second = operatorToken(await app.app.inject({ method: "POST", url: "/api/admin/login", payload: { email: app.email, password: app.password } }));
    const wrong = await app.asOperator("POST", "/api/admin/password", { currentPassword: "not the password", newPassword: "a brand new password" });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ code: "VALIDATION_FAILED", details: [{ path: "currentPassword" }] });
    expect((await app.asOperator("POST", "/api/admin/password", { currentPassword: app.password, newPassword: "short" })).statusCode).toBe(400);
    // Operators need 16 characters, and nothing from the common-password list.
    const fifteen = await app.asOperator("POST", "/api/admin/password", { currentPassword: app.password, newPassword: "fifteen chars!!" });
    expect(fifteen.json()).toMatchObject({ code: "VALIDATION_FAILED", details: [{ path: "newPassword", issue: "Use at least 16 characters." }] });
    // Whichever listed password is long enough, so the test holds whatever the list holds.
    const listed = readFileSync(new URL("../assets/common-passwords/common-passwords.txt", import.meta.url), "utf8")
      .split("\n")
      .find((line) => Array.from(line).length >= 16);
    const common = await app.asOperator("POST", "/api/admin/password", { currentPassword: app.password, newPassword: listed?.toUpperCase() });
    expect(common.json()).toMatchObject({ code: "VALIDATION_FAILED", details: [{ path: "newPassword", issue: "This password is too common. Choose another." }] });
    // A refused change leaves the session alone.
    expect((await app.asOperator("GET", "/api/admin/session")).statusCode).toBe(200);

    expect((await app.asOperator("POST", "/api/admin/password", { currentPassword: "not the password", newPassword: "sixteen chars!!!" })).json()).toMatchObject({
      details: [{ path: "currentPassword" }],
    });
    const changed = await app.asOperator("POST", "/api/admin/password", { currentPassword: app.password, newPassword: "a brand new password" });
    expect(changed.statusCode).toBe(204);
    expect(String(changed.headers["set-cookie"])).toContain("__Host-cl_operator=; ");
    expect((await app.asOperator("GET", "/api/admin/session")).statusCode).toBe(401);
    expect((await app.app.inject({ method: "GET", url: "/api/admin/session", headers: { cookie: `__Host-cl_operator=${second}` } })).statusCode).toBe(401);
    expect((await app.app.inject({ method: "POST", url: "/api/admin/login", payload: { email: app.email, password: app.password } })).statusCode).toBe(401);
    expect((await app.app.inject({ method: "POST", url: "/api/admin/login", payload: { email: app.email, password: "a brand new password" } })).statusCode).toBe(200);
  });

  it("limit password changes per operator", async () => {
    const app = await adminApp();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      statuses.push((await app.asOperator("POST", "/api/admin/password", { currentPassword: "not the password", newPassword: "a brand new password" })).statusCode);
    }
    expect(statuses.slice(0, 10).every((status) => status === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("answer 401 without an operator session, and 403 to an owner or a device, on every operator route", async () => {
    const app = await adminApp();
    const operatorRoutes = app.routes.filter((route) => route.access === "operator" && route.method !== "HEAD");
    expect(operatorRoutes.map((route) => `${route.method} ${route.url}`).sort()).toEqual([
      "GET /api/admin/cafes",
      "GET /api/admin/session",
      "PATCH /api/admin/cafes/:id",
      "POST /api/admin/cafes",
      "POST /api/admin/cafes/:id/invites",
      "POST /api/admin/cafes/:id/payments",
      "POST /api/admin/cafes/:id/payments/:paymentId/void",
      "POST /api/admin/password",
    ]);
    for (const route of operatorRoutes) {
      const call = (headers: Record<string, string>) =>
        app.app.inject({ method: route.method as "GET", url: route.url.replace(":id", app.owner.cafeId), headers, ...(route.method === "GET" ? {} : { payload: {} }) });
      const results = {
        none: (await call({})).statusCode,
        owner: (await call(withCookie(app.owner.session))).statusCode,
        device: (await call(withBearer(app.device.accessToken))).statusCode,
      };
      expect({ route: `${route.method} ${route.url}`, ...results }).toEqual({ route: `${route.method} ${route.url}`, none: 401, owner: 403, device: 403 });
    }
  });
});

describe("the admin screen (AC 39)", () => {
  it("lists every café, sets its plan and records its payments, in the café's audit log", async () => {
    const app = await adminApp();
    const listed = (await app.asOperator("GET", "/api/admin/cafes")).json<{ cafes: { id: string; plan: string }[] }>().cafes;
    expect(listed.find((cafe) => cafe.id === app.owner.cafeId)).toMatchObject({ name: "Café Test", plan: "pilot", paidCents: 0, payments: [] });

    const active = await app.asOperator("PATCH", `/api/admin/cafes/${app.owner.cafeId}`, { plan: "active" });
    expect(active.json()).toMatchObject({ id: app.owner.cafeId, plan: "active" });
    expect((await app.asOperator("PATCH", `/api/admin/cafes/${app.owner.cafeId}`, { plan: "free" })).statusCode).toBe(400);

    const paid = await app.asOperator("POST", `/api/admin/cafes/${app.owner.cafeId}/payments`, { paymentId: randomUUID(), amountCents: 2500, paidOn: "2026-10-01", method: "whish", reference: " W-1042 " });
    expect(paid.statusCode).toBe(201);
    await app.asOperator("POST", `/api/admin/cafes/${app.owner.cafeId}/payments`, { paymentId: randomUUID(), amountCents: 1000, paidOn: "2026-10-05", method: "cash" });
    expect((await app.asOperator("GET", "/api/admin/cafes")).json<{ cafes: { id: string }[] }>().cafes.find((cafe) => cafe.id === app.owner.cafeId)).toMatchObject({
      plan: "active",
      paidCents: 3500,
      payments: [
        { amountCents: 1000, paidOn: "2026-10-05", method: "cash", reference: null },
        { amountCents: 2500, paidOn: "2026-10-01", method: "whish", reference: "W-1042" },
      ],
    });
    for (const wrong of [
      { amountCents: 0, paidOn: "2026-10-01", method: "cash" },
      { amountCents: 100, paidOn: "2026-02-30", method: "cash" },
      { amountCents: 100, paidOn: "2099-01-01", method: "cash" },
      { amountCents: 100, paidOn: "2025-12-31", method: "cash" },
      { amountCents: 100, paidOn: "2026-10-01", method: "card" },
    ]) {
      expect((await app.asOperator("POST", `/api/admin/cafes/${app.owner.cafeId}/payments`, { paymentId: randomUUID(), ...wrong })).statusCode).toBe(400);
    }
    expect((await app.asOperator("PATCH", `/api/admin/cafes/${randomUUID()}`, { plan: "active" })).statusCode).toBe(404);
    expect((await app.asOperator("POST", `/api/admin/cafes/${randomUUID()}/payments`, { paymentId: randomUUID(), amountCents: 100, paidOn: "2026-10-01", method: "cash" })).statusCode).toBe(404);

    const actions = await auditActions(app.owner.cafeId);
    expect(actions.filter((action) => action === "cafe.plan_changed" || action === "cafe.payment_recorded")).toEqual(["cafe.plan_changed", "cafe.payment_recorded", "cafe.payment_recorded"]);
    const { rows } = await context.admin.query<{ action: string; actor_type: string; actor_id: string; changes: unknown }>(
      "SELECT action, actor_type, actor_id, changes FROM app.audit_log WHERE cafe_id = $1 AND action IN ('cafe.plan_changed', 'cafe.payment_recorded') ORDER BY id",
      [app.owner.cafeId],
    );
    const operatorId = (await app.asOperator("GET", "/api/admin/session")).json<{ operator: { id: string } }>().operator.id;
    // The payment's reference is the operator's free text, so it stays out of the audit log.
    expect(rows).toEqual([
      { action: "cafe.plan_changed", actor_type: "operator", actor_id: operatorId, changes: { from: "pilot", to: "active" } },
      { action: "cafe.payment_recorded", actor_type: "operator", actor_id: operatorId, changes: { amountCents: 2500, paidOn: "2026-10-01", method: "whish" } },
      { action: "cafe.payment_recorded", actor_type: "operator", actor_id: operatorId, changes: { amountCents: 1000, paidOn: "2026-10-05", method: "cash" } },
    ]);
    // The same plan again changes nothing and writes no entry.
    expect((await app.asOperator("PATCH", `/api/admin/cafes/${app.owner.cafeId}`, { plan: "active" })).json()).toMatchObject({ plan: "active" });
    expect((await auditActions(app.owner.cafeId)).filter((action) => action === "cafe.plan_changed")).toHaveLength(1);
  });

  it("creates a café with a signup link its owner signs up with, once when sent again, in the café's audit log", async () => {
    const app = await adminApp();
    const cafeId = randomUUID();
    const created = await app.asOperator("POST", "/api/admin/cafes", { cafeId, name: "  Café Nouveau  " });
    expect(created.statusCode).toBe(201);
    const body = created.json<{ cafe: { id: string; name: string; plan: string }; link: string; expiresAt: string }>();
    expect(body.cafe).toMatchObject({ id: cafeId, name: "Café Nouveau", plan: "pilot", paidCents: 0, payments: [] });
    const link = new URL(body.link);
    expect(`${link.origin}${link.pathname}`).toBe(new URL("/signup", DASHBOARD_URL).toString());
    expect(Date.parse(body.expiresAt) - Date.now()).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
    // Sent again (its response lost): the same café, with a fresh link.
    const again = await app.asOperator("POST", "/api/admin/cafes", { cafeId, name: "Café Nouveau" });
    expect(again.statusCode).toBe(201);
    expect(again.json<{ link: string }>().link).not.toBe(body.link);
    expect((await app.asOperator("POST", "/api/admin/cafes", { cafeId, name: "Another name" })).json()).toMatchObject({ code: "CONFLICT" });
    // An existing café's id with another name never renames it.
    expect((await app.asOperator("POST", "/api/admin/cafes", { cafeId: app.owner.cafeId, name: "Another name" })).statusCode).toBe(409);
    for (const wrong of [{ cafeId, name: "   " }, { cafeId, name: "x".repeat(121) }, { cafeId: "not-a-uuid", name: "Café" }, { name: "Café" }]) {
      expect((await app.asOperator("POST", "/api/admin/cafes", wrong)).statusCode).toBe(400);
    }
    const listed = (await app.asOperator("GET", "/api/admin/cafes")).json<{ cafes: { id: string }[] }>().cafes;
    expect(listed.filter((cafe) => cafe.id === cafeId)).toHaveLength(1);

    // Either link signs an owner up for the new café, once.
    for (const sentLink of [body.link, again.json<{ link: string }>().link]) {
      const token = new URLSearchParams(new URL(sentLink).hash.slice(1)).get("invite");
      const signUpWith = () =>
        app.app.inject({ method: "POST", url: "/api/auth/signup", payload: { inviteToken: token, email: `owner-${randomUUID()}@example.com`, password: PASSWORD } });
      const signup = await signUpWith();
      expect(signup.statusCode).toBe(201);
      expect((await app.app.inject({ method: "GET", url: "/api/cafe", headers: withCookie(cookieToken(signup)) })).json()).toMatchObject({ cafe: { id: cafeId } });
      expect((await signUpWith()).statusCode).not.toBe(201);
    }

    const operatorId = (await app.asOperator("GET", "/api/admin/session")).json<{ operator: { id: string } }>().operator.id;
    const { rows } = await context.admin.query<{ action: string; actor_type: string; actor_id: string; changes: unknown }>(
      "SELECT action, actor_type, actor_id, changes FROM app.audit_log WHERE cafe_id = $1 AND action IN ('cafe.created', 'owner_invite.created') ORDER BY id",
      [cafeId],
    );
    expect(rows).toEqual([
      { action: "cafe.created", actor_type: "operator", actor_id: operatorId, changes: {} },
      { action: "owner_invite.created", actor_type: "operator", actor_id: operatorId, changes: {} },
      { action: "owner_invite.created", actor_type: "operator", actor_id: operatorId, changes: {} },
    ]);
  });

  it("gives an existing café a fresh signup link, and none to a café that does not exist", async () => {
    const app = await adminApp();
    const fresh = await app.asOperator("POST", `/api/admin/cafes/${app.owner.cafeId}/invites`);
    expect(fresh.statusCode).toBe(201);
    const body = fresh.json<{ cafe: { id: string }; link: string }>();
    expect(body.cafe).toMatchObject({ id: app.owner.cafeId, name: "Café Test" });
    const token = new URLSearchParams(new URL(body.link).hash.slice(1)).get("invite");
    // Another owner for the café.
    const signup = await app.app.inject({ method: "POST", url: "/api/auth/signup", payload: { inviteToken: token, email: `owner-${randomUUID()}@example.com`, password: PASSWORD } });
    expect(signup.statusCode).toBe(201);
    expect((await app.asOperator("POST", `/api/admin/cafes/${randomUUID()}/invites`)).statusCode).toBe(404);
    expect((await auditActions(app.owner.cafeId)).filter((action) => action === "owner_invite.created")).toHaveLength(2);
  });

  it("voids a payment once with its reason, keeping it listed but out of the total, in the audit log without the reason", async () => {
    const app = await adminApp();
    const payments = `/api/admin/cafes/${app.owner.cafeId}/payments`;
    const wrong = { paymentId: randomUUID(), amountCents: 2500, paidOn: "2026-10-01", method: "cash" };
    const right = { paymentId: randomUUID(), amountCents: 1000, paidOn: "2026-10-02", method: "whish" };
    await app.asOperator("POST", payments, wrong);
    await app.asOperator("POST", payments, right);

    const voided = await app.asOperator("POST", `${payments}/${wrong.paymentId}/void`, { reason: "  Typed the wrong amount " });
    expect(voided.statusCode).toBe(200);
    const after = voided.json<{ paidCents: number; payments: { id: string; voided: { at: string; reason: string } | null }[] }>();
    expect(after.paidCents).toBe(1000);
    expect(after.payments.map((payment) => [payment.id, payment.voided?.reason ?? null])).toEqual([
      [right.paymentId, null],
      [wrong.paymentId, "Typed the wrong amount"],
    ]);

    // Sent again (its response lost), or with another reason: the first void stays, once in the audit log.
    const again = await app.asOperator("POST", `${payments}/${wrong.paymentId}/void`, { reason: "Another reason" });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ paidCents: 1000, payments: [{ voided: null }, { voided: { reason: "Typed the wrong amount", at: after.payments[1]?.voided?.at } }] });
    const { rows } = await context.admin.query<{ actor_type: string; entity_id: string; changes: unknown }>(
      "SELECT actor_type, entity_id, changes FROM app.audit_log WHERE cafe_id = $1 AND action = 'cafe.payment_voided'",
      [app.owner.cafeId],
    );
    expect(rows).toEqual([{ actor_type: "operator", entity_id: wrong.paymentId, changes: { amountCents: 2500 } }]);
    expect(JSON.stringify(rows)).not.toContain("wrong amount");

    for (const reason of ["", "   ", "x".repeat(201)]) {
      const refused = await app.asOperator("POST", `${payments}/${right.paymentId}/void`, { reason });
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({ code: "VALIDATION_FAILED", details: [{ path: "reason" }] });
    }
    expect((await app.asOperator("POST", `${payments}/${right.paymentId}/void`, {})).statusCode).toBe(400);
    // An unknown payment, another café's payment, an unknown café: none is voided.
    const other = await signUp(app.app);
    const theirs = { paymentId: randomUUID(), amountCents: 500, paidOn: "2026-10-03", method: "cash" };
    await app.asOperator("POST", `/api/admin/cafes/${other.cafeId}/payments`, theirs);
    expect((await app.asOperator("POST", `${payments}/${randomUUID()}/void`, { reason: "No such payment" })).statusCode).toBe(404);
    expect((await app.asOperator("POST", `${payments}/${theirs.paymentId}/void`, { reason: "Not this café's" })).statusCode).toBe(404);
    expect((await app.asOperator("POST", `/api/admin/cafes/${randomUUID()}/payments/${right.paymentId}/void`, { reason: "No such café" })).statusCode).toBe(404);
    expect((await app.asOperator("POST", `${payments}/not-a-uuid/void`, { reason: "Bad id" })).statusCode).toBe(400);
    expect((await app.asOperator("GET", "/api/admin/cafes")).json<{ cafes: { id: string; paidCents: number }[] }>().cafes.find((cafe) => cafe.id === other.cafeId)?.paidCents).toBe(500);
  });

  it("records a payment sent again (its response lost) once, and refuses the same id with other details", async () => {
    const app = await adminApp();
    const payment = { paymentId: randomUUID(), amountCents: 2500, paidOn: "2026-10-01", method: "cash" };
    const first = await app.asOperator("POST", `/api/admin/cafes/${app.owner.cafeId}/payments`, payment);
    const again = await app.asOperator("POST", `/api/admin/cafes/${app.owner.cafeId}/payments`, payment);
    expect([first.statusCode, again.statusCode]).toEqual([201, 201]);
    expect(again.json()).toMatchObject({ paidCents: 2500, payments: [{ id: payment.paymentId, amountCents: 2500 }] });
    const changed = await app.asOperator("POST", `/api/admin/cafes/${app.owner.cafeId}/payments`, { ...payment, amountCents: 3000 });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({ code: "CONFLICT" });
    // Another café never sees, nor collides silently with, this café's payment.
    const other = await signUp(app.app);
    expect((await app.asOperator("POST", `/api/admin/cafes/${other.cafeId}/payments`, payment)).statusCode).toBe(409);
    expect((await auditActions(app.owner.cafeId)).filter((action) => action === "cafe.payment_recorded")).toHaveLength(1);
  });

  it("stops a suspended café enrolling customers while its counter still syncs, and tells its owner", async () => {
    const app = await adminApp();
    const card = await issueCard(app.owner.cafeId);
    const join = await app.asOwner("GET", "/api/cafe/join");
    const code = /\/join\/([0-9a-f]{32})$/.exec(join.json<{ joinUrl: string }>().joinUrl)?.[1] ?? "missing";
    await app.asOperator("PATCH", `/api/admin/cafes/${app.owner.cafeId}`, { plan: "suspended" });

    const page = await app.app.inject({ method: "GET", url: `/join/${code}?lang=en` });
    expect(page.statusCode).toBe(403);
    expect(page.body).toContain("This café is not taking new members right now.");
    const signup = await app.app.inject({ method: "POST", url: `/join/${code}`, ...formBody({ phone: "70 123 456", privacy: "yes", lang: "ar" }) });
    expect(signup.statusCode).toBe(403);
    expect(signup.body).toContain("هذا المقهى لا يستقبل أعضاء جدداً حالياً.");
    expect((await context.admin.query("SELECT 1 FROM app.cards WHERE cafe_id = $1", [app.owner.cafeId])).rowCount).toBe(1);
    // The counter still records and syncs visits of existing cards.
    expect(await stamp(app, card.qr)).toBe("OK");
    expect((await app.asOwner("GET", "/api/cafe")).json()).toMatchObject({ cafe: { plan: "suspended" } });

    await app.asOperator("PATCH", `/api/admin/cafes/${app.owner.cafeId}`, { plan: "active" });
    expect((await app.app.inject({ method: "GET", url: `/join/${code}?lang=en` })).statusCode).toBe(200);
  });
});
