import { randomUUID } from "node:crypto";
import { syncResponseSchema } from "@cafe-loyalty/shared";
import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { setOperatorPassword } from "./operators.js";
import { signedEvent, useApiHarness, withBearer, withCookie } from "./testing/api-harness.js";

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

  it("answer 401 without an operator session, and 403 to an owner or a device, on every operator route", async () => {
    const app = await adminApp();
    const operatorRoutes = app.routes.filter((route) => route.access === "operator" && route.method !== "HEAD");
    expect(operatorRoutes.map((route) => `${route.method} ${route.url}`).sort()).toEqual(["GET /api/admin/cafes", "GET /api/admin/session", "PATCH /api/admin/cafes/:id", "POST /api/admin/cafes/:id/payments"]);
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

    const paid = await app.asOperator("POST", `/api/admin/cafes/${app.owner.cafeId}/payments`, { amountCents: 2500, paidOn: "2026-10-01", method: "whish", reference: " W-1042 " });
    expect(paid.statusCode).toBe(201);
    await app.asOperator("POST", `/api/admin/cafes/${app.owner.cafeId}/payments`, { amountCents: 1000, paidOn: "2026-10-05", method: "cash" });
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
      expect((await app.asOperator("POST", `/api/admin/cafes/${app.owner.cafeId}/payments`, wrong)).statusCode).toBe(400);
    }
    expect((await app.asOperator("PATCH", `/api/admin/cafes/${randomUUID()}`, { plan: "active" })).statusCode).toBe(404);
    expect((await app.asOperator("POST", `/api/admin/cafes/${randomUUID()}/payments`, { amountCents: 100, paidOn: "2026-10-01", method: "cash" })).statusCode).toBe(404);

    const actions = await auditActions(app.owner.cafeId);
    expect(actions.filter((action) => action === "cafe.plan_changed" || action === "cafe.payment_recorded")).toEqual(["cafe.plan_changed", "cafe.payment_recorded", "cafe.payment_recorded"]);
    const { rows } = await context.admin.query<{ actor_type: string; changes: unknown }>("SELECT actor_type, changes FROM app.audit_log WHERE cafe_id = $1 AND action = 'cafe.plan_changed'", [app.owner.cafeId]);
    expect(rows).toEqual([{ actor_type: "operator", changes: { from: "pilot", to: "active" } }]);
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
