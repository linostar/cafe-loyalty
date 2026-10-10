import { pbkdf2Sync, randomUUID } from "node:crypto";
import { deviceInfoSchema, deviceStaffSchema, pairResponseSchema, tokenRenewalResponseSchema } from "@cafe-loyalty/shared";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerAccessControl } from "./access.js";
import { hashToken } from "./credentials.js";
import {
  COUNTER_URL,
  CURRENT_BUILD,
  PASSWORD,
  deviceKeyPair,
  signedRenewal,
  useApiHarness,
  withBearer,
  withCookie,
} from "./testing/api-harness.js";

const context = useApiHarness();
const { harness, signUp, pairDevice, auditActions } = context;

const ORDER_TYPE = { nameAr: "إسبريسو", nameEn: "Espresso", priceCents: 250, costCents: 70, stampsEarned: 1 };

async function ownerApp() {
  const h = await harness();
  const owner = await signUp(h.app);
  // Writes always carry a JSON body, as the dashboard sends them.
  const as = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload: Record<string, unknown> = {}) =>
    h.app.inject({ method, url, headers: withCookie(owner.session), ...(method === "GET" ? {} : { payload }) });
  return { ...h, owner, as };
}

describe("access control", () => {
  it("refuses a route that declares no access", async () => {
    const app = Fastify();
    registerAccessControl(app, context.testDb.app.db);
    // The onRoute hook throws as the route is added, so the server never starts with it.
    expect(() => app.get("/undeclared", () => ({}))).toThrow('must declare config.access ("owner", "device" or "public")');
    await app.close();
  });

  it("answers 403 to a paired device's token on every owner route (AC 20)", async () => {
    const { app, routes, owner } = await ownerApp();
    const device = await pairDevice(app, owner);
    const ownerRoutes = routes.filter((route) => route.access === "owner" && route.method !== "HEAD");
    expect(ownerRoutes.length).toBeGreaterThanOrEqual(24);
    for (const route of ownerRoutes) {
      const response = await app.inject({
        method: route.method as "GET",
        // The harness records full paths, prefix included.
        url: route.url.replace(":id", randomUUID()),
        headers: withBearer(device.accessToken),
        ...(route.method === "GET" ? {} : { payload: {} }),
      });
      expect({ route: `${route.method} ${route.url}`, status: response.statusCode, code: response.json<{ code: string }>().code }).toEqual({
        route: `${route.method} ${route.url}`,
        status: 403,
        code: "FORBIDDEN",
      });
    }
  });

  it("checks access before reading the body, and marks every API response no-store", async () => {
    const { app, as } = await ownerApp();
    const unauthenticated = await app.inject({ method: "POST", url: "/api/cafe/order-types", headers: { "content-type": "application/json" }, payload: "{not json" });
    expect(unauthenticated.statusCode).toBe(401);
    const missing = await app.inject({ method: "GET", url: "/api/no-such-route" });
    expect(missing.statusCode).toBe(404);
    for (const response of [unauthenticated, missing, await as("GET", "/api/cafe"), await as("GET", "/api/staff"), await as("GET", "/api/devices")]) {
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it("answers 401 to an owner route without credentials and to a device route with an owner session", async () => {
    const { app, as } = await ownerApp();
    expect((await app.inject({ method: "GET", url: "/api/cafe" })).statusCode).toBe(401);
    const asDevice = await as("GET", "/api/device/me");
    expect(asDevice.statusCode).toBe(401);
    // A device route always points a caller without a valid device token at renewal, which decides the rest.
    expect(asDevice.json()).toMatchObject({ code: "TOKEN_EXPIRED" });
  });
});

describe("café setup", () => {
  it("starts with the invited café, no program and no order types", async () => {
    const { as, owner } = await ownerApp();
    const setup = await as("GET", "/api/cafe");
    expect(setup.statusCode).toBe(200);
    expect(setup.json()).toEqual({ cafe: { id: owner.cafeId, name: "Café Test", catalogVersion: 1, minMarginPercent: 0 }, program: null, orderTypes: [] });
  });

  it("renames the café and saves the loyalty program, audit-logged", async () => {
    const { as, owner } = await ownerApp();
    expect((await as("PATCH", "/api/cafe", { name: "  Café Najjar " })).json()).toMatchObject({ cafe: { name: "Café Najjar" } });
    const program = { stampsRequired: 9, rewardNameAr: "قهوة مجانية", rewardNameEn: "Free coffee" };
    expect((await as("PUT", "/api/cafe/program", program)).json()).toMatchObject({ program });
    const changed = { ...program, stampsRequired: 8 };
    expect((await as("PUT", "/api/cafe/program", changed)).json()).toMatchObject({ program: changed });
    const created = await as("POST", "/api/cafe/order-types", ORDER_TYPE);
    const id = created.json<{ orderTypes: { id: string }[] }>().orderTypes[0]?.id ?? "";
    await as("PATCH", `/api/cafe/order-types/${id}`, { active: false });
    // One entry per change, in order (AC 1).
    expect((await auditActions(owner.cafeId)).slice(-5)).toEqual(["cafe.updated", "loyalty_program.saved", "loyalty_program.saved", "order_type.created", "order_type.updated"]);
  });

  it("adds and edits order types, bumping the catalog version only when a price or cost changes", async () => {
    const { as, owner } = await ownerApp();
    const created = await as("POST", "/api/cafe/order-types", ORDER_TYPE);
    expect(created.statusCode).toBe(201);
    const setup = created.json<{ cafe: { catalogVersion: number }; orderTypes: { id: string }[] }>();
    expect(setup.cafe.catalogVersion).toBe(2);
    expect(setup.orderTypes).toEqual([{ id: expect.any(String) as unknown, ...ORDER_TYPE, active: true }]);
    const id = setup.orderTypes[0]?.id ?? "";

    const renamed = await as("PATCH", `/api/cafe/order-types/${id}`, { nameEn: "Single espresso", active: false });
    expect(renamed.json()).toMatchObject({ cafe: { catalogVersion: 2 }, orderTypes: [{ nameEn: "Single espresso", active: false }] });
    const repriced = await as("PATCH", `/api/cafe/order-types/${id}`, { priceCents: 275 });
    expect(repriced.json()).toMatchObject({ cafe: { catalogVersion: 3 }, orderTypes: [{ priceCents: 275 }] });

    const { rows } = await context.admin.query<{ changes: unknown }>(
      "SELECT changes FROM app.audit_log WHERE cafe_id = $1 AND action = 'order_type.updated' ORDER BY id DESC LIMIT 1",
      [owner.cafeId],
    );
    expect(rows[0]?.changes).toEqual({ price_cents: { from: 250, to: 275 } });
  });

  it("validates amounts and names", async () => {
    const { as } = await ownerApp();
    const response = await as("POST", "/api/cafe/order-types", { ...ORDER_TYPE, priceCents: -1, nameEn: "" });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ details: { path: string }[] }>().details.map((detail) => detail.path).sort()).toEqual(["nameEn", "priceCents"]);
    expect((await as("PATCH", "/api/cafe/order-types/not-an-id", { active: true })).statusCode).toBe(400);
  });

  it("cannot reach another café's order type", async () => {
    const first = await ownerApp();
    const id = (await first.as("POST", "/api/cafe/order-types", ORDER_TYPE)).json<{ orderTypes: { id: string }[] }>().orderTypes[0]?.id ?? "";
    const second = await ownerApp();
    const response = await second.as("PATCH", `/api/cafe/order-types/${id}`, { priceCents: 1 });
    expect(response.statusCode).toBe(404);
    expect((await first.as("GET", "/api/cafe")).json()).toMatchObject({ orderTypes: [{ priceCents: 250 }] });
  });
});

describe("staff", () => {
  it("keeps only a PBKDF2 hash of the PIN and never returns it to the owner", async () => {
    const { as, owner } = await ownerApp();
    const added = await as("POST", "/api/staff", { name: "Rami", pin: "482913" });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toEqual({ staff: [{ id: expect.any(String) as unknown, name: "Rami", revoked: false, createdAt: expect.any(String) as unknown }] });
    const { rows } = await context.admin.query<{ pin_salt: Buffer; pin_hash: Buffer; pin_iterations: number }>(
      "SELECT pin_salt, pin_hash, pin_iterations FROM app.staff WHERE cafe_id = $1",
      [owner.cafeId],
    );
    const row = rows[0];
    expect(row?.pin_iterations).toBe(600_000);
    expect(row?.pin_hash.equals(pbkdf2Sync("482913", row.pin_salt, row.pin_iterations, 32, "sha256"))).toBe(true);
  });

  it("refuses easy PINs", async () => {
    const { as } = await ownerApp();
    for (const pin of ["12345", "111111", "123456"]) {
      const response = await as("POST", "/api/staff", { name: "Rami", pin });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ details: [{ path: "pin" }] });
    }
  });

  it("changes a PIN, revokes, and keeps audit entries free of names", async () => {
    const { as, owner } = await ownerApp();
    const id = (await as("POST", "/api/staff", { name: "Rami Haddad", pin: "482913" })).json<{ staff: { id: string }[] }>().staff[0]?.id ?? "";
    const before = await context.admin.query<{ pin_hash: Buffer }>("SELECT pin_hash FROM app.staff WHERE id = $1", [id]);
    expect((await as("PATCH", `/api/staff/${id}`, { pin: "205871" })).statusCode).toBe(200);
    const after = await context.admin.query<{ pin_hash: Buffer }>("SELECT pin_hash FROM app.staff WHERE id = $1", [id]);
    expect(after.rows[0]?.pin_hash.equals(before.rows[0]?.pin_hash ?? Buffer.alloc(0))).toBe(false);

    expect((await as("POST", `/api/staff/${id}/revoke`)).json()).toMatchObject({ staff: [{ id, revoked: true }] });
    expect((await as("POST", `/api/staff/${id}/revoke`)).statusCode).toBe(200);
    expect((await as("PATCH", `/api/staff/${id}`, { pin: "205871" })).statusCode).toBe(409);

    const { rows } = await context.admin.query<{ action: string; changes: unknown }>(
      "SELECT action, changes FROM app.audit_log WHERE cafe_id = $1 AND entity_type = 'staff' ORDER BY id",
      [owner.cafeId],
    );
    expect(rows.map((entry) => entry.action)).toEqual(["staff.added", "staff.updated", "staff.revoked"]);
    expect(JSON.stringify(rows)).not.toContain("Rami");
  });

  it("cannot reach another café's staff", async () => {
    const first = await ownerApp();
    const id = (await first.as("POST", "/api/staff", { name: "Rami", pin: "482913" })).json<{ staff: { id: string }[] }>().staff[0]?.id ?? "";
    const second = await ownerApp();
    expect((await second.as("POST", `/api/staff/${id}/revoke`)).statusCode).toBe(404);
    expect((await second.as("PATCH", `/api/staff/${id}`, { pin: "205871" })).statusCode).toBe(404);
    expect((await second.as("GET", "/api/staff")).json()).toEqual({ staff: [] });
  });
});

describe("pairing", () => {
  async function newCode(as: Awaited<ReturnType<typeof ownerApp>>["as"]) {
    const response = await as("POST", "/api/devices/pairing-codes", { deviceName: "Counter 1" });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string; code: string; pairingUrl: string; expiresAt: string }>();
  }

  it("shows a 12-character code once, with the counter's pairing link, valid 10 minutes", async () => {
    const { as } = await ownerApp();
    const code = await newCode(as);
    expect(code.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(code.pairingUrl).toBe(`${COUNTER_URL}/pair#code=${code.code.replace(/-/g, "")}`);
    const { rows } = await context.admin.query<{ lifetime: number }>(
      "SELECT extract(epoch FROM expires_at - created_at)::int AS lifetime FROM app.pairing_codes WHERE id = $1",
      [code.id],
    );
    expect(rows[0]?.lifetime).toBe(600);
    const listed = (await as("GET", "/api/devices")).json<{ pairingCodes: unknown[] }>();
    expect(listed.pairingCodes).toEqual([{ id: code.id, deviceName: "Counter 1", expiresAt: code.expiresAt }]);
    expect(JSON.stringify(listed)).not.toContain(code.code.replace(/-/g, "").slice(4));
  });

  it("pairs a device once, however the code is typed", async () => {
    const { app, as, owner } = await ownerApp();
    const code = await newCode(as);
    const { publicJwk } = await deviceKeyPair();
    const typed = ` ${code.code.toLowerCase().replace(/-/g, " ")} `;
    const paired = await app.inject({ method: "POST", url: "/api/device/pair", headers: CURRENT_BUILD, payload: { code: typed, publicKey: publicJwk } });
    expect(paired.statusCode).toBe(201);
    expect(pairResponseSchema.parse(paired.json())).toMatchObject({ deviceName: "Counter 1", cafe: { id: owner.cafeId, name: "Café Test" } });
    const again = await app.inject({ method: "POST", url: "/api/device/pair", headers: CURRENT_BUILD, payload: { code: code.code, publicKey: publicJwk } });
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ code: "PAIRING_CODE_INVALID", retryable: false });
    expect((await as("GET", "/api/devices")).json()).toMatchObject({ devices: [{ name: "Counter 1", revoked: false }], pairingCodes: [] });
    expect(await auditActions(owner.cafeId)).toEqual(expect.arrayContaining(["pairing_code.created", "device.paired"]) as unknown);
  });

  it("burns a code after 5 wrong secrets", async () => {
    const { app, as, owner } = await ownerApp();
    const code = await newCode(as).then((created) => created.code.replace(/-/g, ""));
    const wrong = `${code.slice(0, 4)}${code.slice(4) === "00000000" ? "11111111" : "00000000"}`;
    const { publicJwk } = await deviceKeyPair();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect((await app.inject({ method: "POST", url: "/api/device/pair", headers: CURRENT_BUILD, payload: { code: wrong, publicKey: publicJwk } })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: "POST", url: "/api/device/pair", headers: CURRENT_BUILD, payload: { code, publicKey: publicJwk } })).statusCode).toBe(400);
    expect(await auditActions(owner.cafeId)).toContain("pairing_code.burned");
  });

  it("still pairs with the right code after 4 wrong tries", async () => {
    const { app, as } = await ownerApp();
    const code = await newCode(as).then((created) => created.code.replace(/-/g, ""));
    const wrong = `${code.slice(0, 4)}${code.slice(4) === "00000000" ? "11111111" : "00000000"}`;
    const { publicJwk } = await deviceKeyPair();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await app.inject({ method: "POST", url: "/api/device/pair", headers: CURRENT_BUILD, payload: { code: wrong, publicKey: publicJwk } });
      expect(response.json()).toMatchObject({ code: "PAIRING_CODE_INVALID" });
    }
    expect((await app.inject({ method: "POST", url: "/api/device/pair", headers: CURRENT_BUILD, payload: { code, publicKey: publicJwk } })).statusCode).toBe(201);
  });

  it("counts only failed pairings against an address", async () => {
    const { app, as } = await ownerApp();
    for (let device = 1; device <= 12; device += 1) {
      const code = await newCode(as);
      const { publicJwk } = await deviceKeyPair();
      expect((await app.inject({ method: "POST", url: "/api/device/pair", headers: CURRENT_BUILD, payload: { code: code.code, publicKey: publicJwk } })).statusCode).toBe(201);
    }
  });

  it("refuses an expired or cancelled code and an invalid key", async () => {
    const { app, as } = await ownerApp();
    const { publicJwk } = await deviceKeyPair();
    const expired = await newCode(as);
    await context.admin.query("UPDATE app.pairing_codes SET expires_at = now() - interval '1 second' WHERE id = $1", [expired.id]);
    expect((await app.inject({ method: "POST", url: "/api/device/pair", headers: CURRENT_BUILD, payload: { code: expired.code, publicKey: publicJwk } })).statusCode).toBe(400);

    const cancelled = await newCode(as);
    expect((await as("DELETE", `/api/devices/pairing-codes/${cancelled.id}`)).statusCode).toBe(204);
    expect((await app.inject({ method: "POST", url: "/api/device/pair", headers: CURRENT_BUILD, payload: { code: cancelled.code, publicKey: publicJwk } })).statusCode).toBe(400);

    const valid = await newCode(as);
    const badKey = { kty: "EC", crv: "P-256", x: "A".repeat(43), y: "A".repeat(43) };
    const response = await app.inject({ method: "POST", url: "/api/device/pair", headers: CURRENT_BUILD, payload: { code: valid.code, publicKey: badKey } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "VALIDATION_FAILED", details: [{ path: "publicKey" }] });
  });

  it("burns a code once under parallel wrong guesses", async () => {
    const { app, as, owner } = await ownerApp();
    const code = await newCode(as).then((created) => created.code.replace(/-/g, ""));
    const wrong = `${code.slice(0, 4)}${code.slice(4) === "00000000" ? "11111111" : "00000000"}`;
    const { publicJwk } = await deviceKeyPair();
    const replies = await Promise.all(
      Array.from({ length: 8 }, () => app.inject({ method: "POST", url: "/api/device/pair", headers: CURRENT_BUILD, payload: { code: wrong, publicKey: publicJwk } })),
    );
    expect(replies.every((reply) => reply.statusCode === 400)).toBe(true);
    expect((await app.inject({ method: "POST", url: "/api/device/pair", headers: CURRENT_BUILD, payload: { code, publicKey: publicJwk } })).statusCode).toBe(400);
    expect((await auditActions(owner.cafeId)).filter((action) => action === "pairing_code.burned")).toHaveLength(1);
  });

  it("drops the owner's open codes when the password is reset (AC 16)", async () => {
    const h = await ownerApp();
    await newCode(h.as);
    await h.app.inject({ method: "POST", url: "/api/auth/password-reset", payload: { email: h.owner.email } });
    await h.background.drain();
    const token = /token=([A-Za-z0-9_-]{43})/.exec(h.mailer.sent[0]?.text ?? "")?.[1] ?? "missing";
    const reset = await h.app.inject({ method: "POST", url: "/api/auth/password-reset/complete", payload: { token, password: "a brand new password" } });
    expect(reset.statusCode).toBe(204);
    const { rows } = await context.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM app.pairing_codes WHERE owner_id = $1", [h.owner.ownerId]);
    expect(rows[0]?.n).toBe(0);
  });

  it("drops the owner's open codes when the password changes (AC 16)", async () => {
    const { as, owner } = await ownerApp();
    await newCode(as);
    const changed = await as("POST", "/api/auth/password", { currentPassword: PASSWORD, newPassword: "a brand new password" });
    expect(changed.statusCode).toBe(204);
    const { rows } = await context.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM app.pairing_codes WHERE owner_id = $1", [owner.ownerId]);
    expect(rows[0]?.n).toBe(0);
  });
});

describe("device tokens", () => {
  async function pairedApp(): Promise<Awaited<ReturnType<typeof ownerApp>> & { device: Awaited<ReturnType<typeof pairDevice>> }> {
    const setup = await ownerApp();
    return { ...setup, device: await pairDevice(setup.app, setup.owner) };
  }

  it("let a device read its café and the active staff's PIN hashes", async () => {
    const { app, as, owner, device } = await pairedApp();
    await as("POST", "/api/staff", { name: "Rami", pin: "482913" });
    const removed = (await as("POST", "/api/staff", { name: "Lina", pin: "205871" })).json<{ staff: { id: string; name: string }[] }>();
    await as("POST", `/api/staff/${removed.staff.find((member) => member.name === "Lina")?.id ?? ""}/revoke`);

    const me = await app.inject({ method: "GET", url: "/api/device/me", headers: withBearer(device.accessToken) });
    expect(deviceInfoSchema.parse(me.json())).toEqual({ deviceId: device.deviceId, deviceName: "Counter 1", cafe: { id: owner.cafeId, name: "Café Test" } });
    const staff = deviceStaffSchema.parse((await app.inject({ method: "GET", url: "/api/device/staff", headers: withBearer(device.accessToken) })).json()).staff;
    expect(staff.map((member) => member.name)).toEqual(["Rami"]);
    const rami = staff[0];
    expect(rami && pbkdf2Sync("482913", Buffer.from(rami.pinSalt, "base64url"), rami.pinIterations, 32, "sha256").toString("base64url")).toBe(rami?.pinHash);
  });

  it("expire, and renew with a signature from the device key", async () => {
    const { app, device } = await pairedApp();
    await context.admin.query("UPDATE app.device_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [hashToken(device.accessToken)]);
    const expired = await app.inject({ method: "GET", url: "/api/device/me", headers: withBearer(device.accessToken) });
    expect(expired.statusCode).toBe(401);
    expect(expired.json()).toMatchObject({ code: "TOKEN_EXPIRED" });

    const renewed = await app.inject({ method: "POST", url: "/api/device/token", payload: await signedRenewal(device) });
    expect(renewed.statusCode).toBe(200);
    const token = tokenRenewalResponseSchema.parse(renewed.json());
    expect(new Date(token.accessTokenExpiresAt).getTime() - Date.now()).toBeGreaterThan(55 * 60 * 1000);
    expect((await app.inject({ method: "GET", url: "/api/device/me", headers: withBearer(token.accessToken) })).statusCode).toBe(200);
  });

  it("go through when correctly signed, even after the address used up its failures", async () => {
    const { app, device } = await pairedApp();
    const junk = { deviceId: device.deviceId, keyId: device.keyId, issuedAt: new Date().toISOString(), signature: "A".repeat(86) };
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      expect((await app.inject({ method: "POST", url: "/api/device/token", payload: junk })).json()).toMatchObject({ code: "PAIRING_REQUIRED" });
    }
    expect((await app.inject({ method: "POST", url: "/api/device/token", payload: junk })).statusCode).toBe(429);
    expect((await app.inject({ method: "POST", url: "/api/device/token", payload: await signedRenewal(device) })).statusCode).toBe(200);
  });

  it("refuse a replayed, forged, mismatched or mistimed renewal", async () => {
    const { app, device } = await pairedApp();
    const renewal = await signedRenewal(device);
    expect((await app.inject({ method: "POST", url: "/api/device/token", payload: renewal })).statusCode).toBe(200);
    const replayed = await app.inject({ method: "POST", url: "/api/device/token", payload: renewal });
    expect(replayed.statusCode).toBe(400);
    expect(replayed.json()).toMatchObject({ code: "VALIDATION_FAILED", details: [{ path: "issuedAt" }] });

    const other = await deviceKeyPair();
    const forged = await signedRenewal({ ...device, privateKey: other.privateKey });
    expect((await app.inject({ method: "POST", url: "/api/device/token", payload: forged })).json()).toMatchObject({ code: "PAIRING_REQUIRED" });
    const mismatched = await signedRenewal({ ...device, deviceId: randomUUID() });
    expect((await app.inject({ method: "POST", url: "/api/device/token", payload: mismatched })).json()).toMatchObject({ code: "PAIRING_REQUIRED" });

    for (const offsetMs of [10 * 60 * 1000, -10 * 60 * 1000]) {
      const mistimed = await signedRenewal(device, new Date(Date.now() + offsetMs).toISOString());
      const skewed = await app.inject({ method: "POST", url: "/api/device/token", payload: mistimed });
      expect(skewed.statusCode).toBe(400);
      expect(skewed.json()).toMatchObject({ details: [{ path: "issuedAt" }] });
    }
  });

  it("renew after almost 7 days offline (AC 18)", async () => {
    const { app, device } = await pairedApp();
    await context.admin.query("UPDATE app.devices SET last_renewed_at = now() - interval '6 days 23 hours' WHERE id = $1", [device.deviceId]);
    expect((await app.inject({ method: "POST", url: "/api/device/token", payload: await signedRenewal(device) })).statusCode).toBe(200);
  });

  it("still renew after the server clock steps back", async () => {
    const { app, device } = await pairedApp();
    await context.admin.query("UPDATE app.devices SET last_renewal_issued_at = now() + interval '1 day' WHERE id = $1", [device.deviceId]);
    expect((await app.inject({ method: "POST", url: "/api/device/token", payload: await signedRenewal(device) })).statusCode).toBe(200);
  });

  it("require pairing again after 7 days without a renewal (AC 18)", async () => {
    const { app, device } = await pairedApp();
    await context.admin.query("UPDATE app.devices SET last_renewed_at = now() - interval '7 days 1 minute' WHERE id = $1", [device.deviceId]);
    const response = await app.inject({ method: "POST", url: "/api/device/token", payload: await signedRenewal(device) });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "PAIRING_REQUIRED" });
  });

  it("stop working for a revoked device, which is told so (AC 21)", async () => {
    const { app, as, owner, device } = await pairedApp();
    expect((await as("POST", `/api/devices/${device.deviceId}/revoke`)).json()).toMatchObject({ devices: [{ id: device.deviceId, revoked: true }] });
    const me = await app.inject({ method: "GET", url: "/api/device/me", headers: withBearer(device.accessToken) });
    expect(me.json()).toMatchObject({ code: "DEVICE_REVOKED" });
    const renewal = await app.inject({ method: "POST", url: "/api/device/token", payload: await signedRenewal(device) });
    expect(renewal.json()).toMatchObject({ code: "DEVICE_REVOKED" });
    // A revoked device's token is no longer "valid", so owner routes answer 401, not 403.
    expect((await app.inject({ method: "GET", url: "/api/cafe", headers: withBearer(device.accessToken) })).statusCode).toBe(401);
    expect(await auditActions(owner.cafeId)).toContain("device.revoked");
  });

  it("never put codes, tokens, PINs or staff names in the logs", async () => {
    const { app, as, owner, logs } = await ownerApp();
    await as("POST", "/api/staff", { name: "Rami Haddad", pin: "482913" });
    const created = await as("POST", "/api/devices/pairing-codes", { deviceName: "Counter 1" });
    const code = created.json<{ code: string }>().code;
    const { privateKey, publicJwk } = await deviceKeyPair();
    const paired = (await app.inject({ method: "POST", url: "/api/device/pair", headers: CURRENT_BUILD, payload: { code, publicKey: publicJwk } })).json<{
      deviceId: string;
      keyId: string;
      accessToken: string;
    }>();
    const renewal = await signedRenewal({ ...paired, privateKey });
    const renewed = (await app.inject({ method: "POST", url: "/api/device/token", payload: renewal })).json<{ accessToken: string }>();
    await app.inject({ method: "GET", url: "/api/device/staff", headers: withBearer(renewed.accessToken) });

    const output = logs.join("");
    expect(output).toContain("device paired");
    for (const secret of [owner.email, "482913", "Rami Haddad", code, code.replace(/-/g, ""), paired.accessToken, renewed.accessToken, renewal.signature]) {
      expect(output).not.toContain(secret);
    }
  });

  it("stay within their café", async () => {
    const first = await pairedApp();
    const second = await ownerApp();
    expect((await second.as("POST", `/api/devices/${first.device.deviceId}/revoke`)).statusCode).toBe(404);
    expect((await second.as("GET", "/api/devices")).json()).toEqual({ devices: [], pairingCodes: [] });
  });
});
