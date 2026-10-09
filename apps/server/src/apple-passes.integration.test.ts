import { randomUUID } from "node:crypto";
import { syncResponseSchema } from "@cafe-loyalty/shared";
import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { applePassToken } from "./apple-pass.js";
import { hashToken, newToken } from "./credentials.js";
import { emailLookup, signCardQr } from "./customer-crypto.js";
import { MAX_REGISTRATIONS_PER_PASS } from "./passkit-routes.js";
import { unzipPass } from "./testing/certificates.js";
import { TEST_SECRETS, signedEvent, useApiHarness, withBearer, withCookie } from "./testing/api-harness.js";

const context = useApiHarness();
const { harness, signUp, pairDevice, issueCard, queuedPassUpdates } = context;

const PASS_TYPE = "pass.example.test";
const PUSH_TOKEN = "ab".repeat(32);
const HOUR = 60 * 60 * 1000;

const formBody = (fields: Record<string, string>) => ({
  headers: { "content-type": "application/x-www-form-urlencoded" },
  payload: new URLSearchParams(fields).toString(),
});

async function cafeApp(overrides: Parameters<typeof harness>[0] = {}) {
  const h = await harness(overrides);
  const owner = await signUp(h.app);
  const as = (method: "GET" | "POST" | "PUT", url: string, payload: Record<string, unknown> = {}) =>
    h.app.inject({ method, url, headers: withCookie(owner.session), ...(method === "GET" ? {} : { payload }) });
  await as("PUT", "/api/cafe/program", { stampsRequired: 2, rewardNameAr: "قهوة مجانية", rewardNameEn: "Free coffee" });
  const setup = (await as("POST", "/api/cafe/order-types", { nameAr: "قهوة", nameEn: "Coffee", priceCents: 300, costCents: 90, stampsEarned: 1, active: true })).json<{
    orderTypes: { id: string }[];
  }>();
  const coffee = setup.orderTypes[0]?.id ?? "missing";
  const staffId = (await as("POST", "/api/staff", { name: "Rami", pin: "482913" })).json<{ staff: { id: string }[] }>().staff[0]?.id ?? "missing";
  const device = await pairDevice(h.app, owner);
  return { ...h, owner, coffee, staffId, device };
}

type App = Awaited<ReturnType<typeof cafeApp>>;
let sequence = 0;

/** Records a visit of one coffee for the card at `at` through the counter sync; it adds a stamp unless refused. */
async function stamp(app: App, qr: string, at = new Date()): Promise<string> {
  sequence += 1;
  const event = await signedEvent(app.device, {
    eventId: randomUUID(),
    staffId: app.staffId,
    sequence,
    schemaVersion: 1,
    type: "visit.recorded",
    occurredAt: at.toISOString(),
    payload: { card: { kind: "qr", token: qr }, items: [{ orderTypeId: app.coffee, quantity: 1, unitPriceCents: 300, unitCostCents: 90, catalogVersion: 1 }], totalCents: 300 },
  });
  const response = await app.app.inject({ method: "POST", url: "/api/device/sync", headers: withBearer(app.device.accessToken), payload: { events: [event] } });
  return syncResponseSchema.parse(response.json()).results[0]?.code ?? "missing";
}

interface DownloadedPass {
  serial: string;
  token: string;
  json: Record<string, unknown>;
  strings: (lang: "ar" | "en") => string;
}

function readPass(response: LightMyRequestResponse): DownloadedPass {
  expect(response.headers["content-type"]).toBe("application/vnd.apple.pkpass");
  const files = unzipPass(response.rawPayload);
  const json = JSON.parse(files.get("pass.json")?.toString("utf8") ?? "{}") as Record<string, unknown>;
  return {
    serial: String(json.serialNumber),
    token: String(json.authenticationToken),
    json,
    strings: (lang) => files.get(`${lang}.lproj/pass.strings`)?.toString("utf8") ?? "",
  };
}

/** The card's pass as Safari gets it from "Add to Apple Wallet" on the web card. */
async function download(app: App, webSecret: string): Promise<DownloadedPass> {
  const response = await app.app.inject({ method: "GET", url: `/c/${webSecret}/apple-pass` });
  expect(response.statusCode).toBe(200);
  return readPass(response);
}

const auth = (token: string) => ({ authorization: `ApplePass ${token}` });
const registrationUrl = (device: string, serial: string, passType = PASS_TYPE) => `/passkit/v1/devices/${device}/registrations/${passType}/${serial}`;
const register = (app: App, pass: Pick<DownloadedPass, "serial" | "token">, device = "device-1", pushToken = PUSH_TOKEN) =>
  app.app.inject({ method: "POST", url: registrationUrl(device, pass.serial), headers: auth(pass.token), payload: { pushToken } });
const serials = (app: App, device: string, since?: string) =>
  app.app.inject({ method: "GET", url: `/passkit/v1/devices/${device}/registrations/${PASS_TYPE}${since === undefined ? "" : `?passesUpdatedSince=${since}`}` });
const latest = (app: App, pass: Pick<DownloadedPass, "serial" | "token">, headers: Record<string, string> = {}) =>
  app.app.inject({ method: "GET", url: `/passkit/v1/passes/${PASS_TYPE}/${pass.serial}`, headers: { ...auth(pass.token), ...headers } });

async function registrations(passId: string) {
  const { rows } = await context.admin.query<{ device_library_hash: Buffer; push_token: string }>(
    "SELECT device_library_hash, push_token FROM app.apple_pass_registrations WHERE pass_id = $1 ORDER BY updated_at",
    [passId],
  );
  return rows;
}

describe("Apple pass downloads", () => {
  it("offers the card as an Apple pass on the web card, the same pass on every download (AC 10, 11)", async () => {
    const app = await cafeApp();
    const card = await issueCard(app.owner.cafeId);
    const page = await app.app.inject({ method: "GET", url: `/c/${card.webSecret}?lang=en` });
    expect(page.body).toContain(`href="/c/${card.webSecret}/apple-pass"`);
    expect(page.body).toContain("Add to Apple Wallet");

    const first = await download(app, card.webSecret);
    const again = await download(app, card.webSecret);
    expect(again.serial).toBe(first.serial);
    expect(again.token).toBe(first.token);
    expect(first.token).toBe(applePassToken(TEST_SECRETS, card.webSecret));
    expect(first.json).toMatchObject({ barcodes: [{ message: card.qr }], webServiceURL: "https://card.example.test/passkit" });
    // The token is stored only as its hash, with the layout the pass was built with (AC 11, 12).
    const { rows } = await context.admin.query("SELECT id, epoch, auth_token_hash, layout_version FROM app.apple_passes WHERE card_id = $1", [card.cardId]);
    expect(rows).toEqual([{ id: first.serial, epoch: 1, auth_token_hash: hashToken(first.token), layout_version: 1 }]);
  });

  it("offers no Apple pass when Apple Wallet is not configured", async () => {
    const app = await cafeApp({ apple: null });
    const card = await issueCard(app.owner.cafeId);
    expect((await app.app.inject({ method: "GET", url: `/c/${card.webSecret}?lang=en` })).body).not.toContain("apple-pass");
    expect((await app.app.inject({ method: "GET", url: `/c/${card.webSecret}/apple-pass` })).statusCode).toBe(404);
    expect((await app.app.inject({ method: "GET", url: `/passkit/v1/devices/device-1/registrations/${PASS_TYPE}` })).statusCode).toBe(404);
  });
});

describe("PassKit web service (AC 11)", () => {
  it("registers a device for a pass: 201 when new, 200 when known, with the device's newest push token", async () => {
    const app = await cafeApp();
    const pass = await download(app, (await issueCard(app.owner.cafeId)).webSecret);
    expect((await register(app, pass)).statusCode).toBe(201);
    expect((await register(app, pass, "device-1", "cd".repeat(32))).statusCode).toBe(200);
    expect(await registrations(pass.serial)).toEqual([{ device_library_hash: hashToken("device-1"), push_token: "cd".repeat(32) }]);
    expect((await register(app, pass, "device-1", "not-a-token")).statusCode).toBe(400);
  });

  it("answers 401 to a missing or wrong token, another pass's serial number or another pass type", async () => {
    const app = await cafeApp();
    const pass = await download(app, (await issueCard(app.owner.cafeId)).webSecret);
    const other = await download(app, (await issueCard(app.owner.cafeId)).webSecret);
    const post = (url: string, headers: Record<string, string>) => app.app.inject({ method: "POST", url, headers, payload: { pushToken: PUSH_TOKEN } });
    expect((await post(registrationUrl("device-1", pass.serial), {})).statusCode).toBe(401);
    expect((await post(registrationUrl("device-1", pass.serial), auth(newToken()))).statusCode).toBe(401);
    expect((await post(registrationUrl("device-1", other.serial), auth(pass.token))).statusCode).toBe(401);
    expect((await post(registrationUrl("device-1", pass.serial, "pass.other.test"), auth(pass.token))).statusCode).toBe(401);
    expect((await latest(app, { serial: pass.serial, token: other.token })).statusCode).toBe(401);
    expect((await app.app.inject({ method: "DELETE", url: registrationUrl("device-1", pass.serial), headers: auth(other.token) })).statusCode).toBe(401);
    expect(await registrations(pass.serial)).toEqual([]);
  });

  it("lists a device's passes changed since the tag it last got, and none when nothing changed", async () => {
    const app = await cafeApp();
    const card = await issueCard(app.owner.cafeId);
    const pass = await download(app, card.webSecret);
    await register(app, pass, "device-2");
    const all = await serials(app, "device-2");
    expect(all.statusCode).toBe(200);
    expect(all.json()).toEqual({ serialNumbers: [pass.serial], lastUpdated: expect.stringMatching(/^[0-9]+$/) as unknown });
    // Transactions of other test files still running hold the tag back (they could still change a pass), which lists
    // the pass again; once none is older, nothing changed since the tag.
    await vi.waitFor(
      async () => {
        const tag = (await serials(app, "device-2")).json<{ lastUpdated: string }>().lastUpdated;
        expect((await serials(app, "device-2", tag)).statusCode).toBe(204);
      },
      { timeout: 15_000, interval: 200 },
    );
    const tag = (await serials(app, "device-2")).json<{ lastUpdated: string }>().lastUpdated;
    expect(await stamp(app, card.qr)).toBe("OK");
    const changed = await serials(app, "device-2", tag);
    expect(changed.statusCode).toBe(200);
    expect(changed.json<{ serialNumbers: string[]; lastUpdated: string }>().serialNumbers).toEqual([pass.serial]);
    // Never earlier (equal while an older transaction elsewhere is still running).
    expect(BigInt(changed.json<{ lastUpdated: string }>().lastUpdated)).toBeGreaterThanOrEqual(BigInt(tag));
    // A tag from before a restore (ahead of the transaction counter) lists every pass again.
    expect((await serials(app, "device-2", "999999999999")).json<{ serialNumbers: string[] }>().serialNumbers).toEqual([pass.serial]);
    expect((await serials(app, "unknown-device")).statusCode).toBe(204);
    expect((await serials(app, "device-2", "not-a-tag")).statusCode).toBe(400);
    expect((await serials(app, "device-2", "99999999999999999999")).statusCode).toBe(400);
  });

  it("sends the latest pass, 304 while it is unchanged, and the new stamps after a visit", async () => {
    const app = await cafeApp();
    const card = await issueCard(app.owner.cafeId);
    const pass = await download(app, card.webSecret);
    const first = await latest(app, pass);
    expect(first.statusCode).toBe(200);
    expect(readPass(first).strings("en")).toContain('"stamps_value" = "⁨0⁩ of ⁨2 stamps⁩";');
    const lastModified = String(first.headers["last-modified"]);
    expect((await latest(app, pass, { "if-modified-since": lastModified })).statusCode).toBe(304);

    expect(await stamp(app, card.qr)).toBe("OK");
    const updated = await latest(app, pass, { "if-modified-since": lastModified });
    expect(updated.statusCode).toBe(200);
    expect(readPass(updated).strings("en")).toContain('"stamps_value" = "⁨1⁩ of ⁨2 stamps⁩";');
    expect(Date.parse(String(updated.headers["last-modified"]))).toBeGreaterThan(Date.parse(lastModified));
  });

  it("unregisters a device, and keeps only a pass's newest registrations", async () => {
    const app = await cafeApp();
    const pass = await download(app, (await issueCard(app.owner.cafeId)).webSecret);
    for (let index = 0; index <= MAX_REGISTRATIONS_PER_PASS; index += 1) {
      expect((await register(app, pass, `device-${String(index)}`)).statusCode).toBe(201);
    }
    const kept = await registrations(pass.serial);
    expect(kept).toHaveLength(MAX_REGISTRATIONS_PER_PASS);
    expect(kept.map((row) => row.device_library_hash)).not.toContainEqual(hashToken("device-0"));

    const removed = await app.app.inject({ method: "DELETE", url: registrationUrl("device-1", pass.serial), headers: auth(pass.token) });
    expect(removed.statusCode).toBe(200);
    expect((await registrations(pass.serial)).map((row) => row.device_library_hash)).not.toContainEqual(hashToken("device-1"));
  });

  it("logs Wallet's error reports", async () => {
    const app = await cafeApp();
    const response = await app.app.inject({ method: "POST", url: "/passkit/v1/log", payload: { logs: ["Web service error for pass.example.test"] } });
    expect(response.statusCode).toBe(200);
    expect(app.logs.join("\n")).toContain("apple wallet reported a web service problem");
  });
});

describe("pass updates", () => {
  it("queues one update job per card in the stamping transaction, folding updates while one waits, and none without a pass (AC 13)", async () => {
    const app = await cafeApp();
    const withPass = await issueCard(app.owner.cafeId);
    const withoutPass = await issueCard(app.owner.cafeId);
    await download(app, withPass.webSecret);
    expect(await stamp(app, withPass.qr, new Date(Date.now() - 2 * HOUR))).toBe("OK");
    expect(await stamp(app, withPass.qr, new Date(Date.now() - HOUR))).toBe("OK");
    expect(await stamp(app, withoutPass.qr)).toBe("OK");
    expect(await queuedPassUpdates(app.owner.cafeId)).toEqual([{ cardId: withPass.cardId, state: "created" }]);

    // A reward changes the stamps too.
    await context.admin.query("DELETE FROM pgboss.job WHERE data->>'cafeId' = $1", [app.owner.cafeId]);
    const redeemed = await app.app.inject({
      method: "POST",
      url: "/api/device/redemptions",
      headers: withBearer(app.device.accessToken),
      payload: { eventId: randomUUID(), staffId: app.staffId, cardQr: withPass.qr },
    });
    expect(redeemed.statusCode).toBe(201);
    expect(await queuedPassUpdates(app.owner.cafeId)).toEqual([{ cardId: withPass.cardId, state: "created" }]);
  });

  it("voids the old phone's pass by an update after a recovery, and gives the new phone a pass of its own (AC 8)", async () => {
    const app = await cafeApp();
    const card = await issueCard(app.owner.cafeId);
    const email = `card-${randomUUID()}@example.com`;
    await context.admin.query("UPDATE app.cards SET email = $1, email_lookup = $2 WHERE id = $3", [email, emailLookup(TEST_SECRETS, email), card.cardId]);
    const old = await download(app, card.webSecret);
    await register(app, old, "old-phone");
    const recovery = newToken();
    await context.admin.query("INSERT INTO app.customer_recovery_tokens (email_lookup, token_hash, expires_at) VALUES ($1, $2, now() + interval '10 minutes')", [
      emailLookup(TEST_SECRETS, email),
      hashToken(recovery),
    ]);

    const restored = await app.app.inject({ method: "POST", url: `/r/${recovery}`, ...formBody({ action: "restore", lang: "en" }) });
    expect(restored.statusCode).toBe(303);
    const newSecret = /^\/c\/([A-Za-z0-9_-]{43})\?/.exec(String(restored.headers.location))?.[1] ?? "missing";
    expect(await queuedPassUpdates(app.owner.cafeId)).toEqual([{ cardId: card.cardId, state: "created" }]);

    const voided = readPass(await latest(app, old));
    expect(voided.json).toMatchObject({ voided: true });
    expect(voided.json).not.toHaveProperty("barcodes");

    const fresh = await download(app, newSecret);
    expect(fresh.serial).not.toBe(old.serial);
    expect(fresh.token).not.toBe(old.token);
    expect(fresh.json).toMatchObject({ barcodes: [{ message: signCardQr(TEST_SECRETS, { cardId: card.cardId, cafeId: app.owner.cafeId, epoch: 2 }) }] });
  });

  it("deletes a card's passes and their registrations with the card (AC 9)", async () => {
    const app = await cafeApp();
    const card = await issueCard(app.owner.cafeId);
    const pass = await download(app, card.webSecret);
    await register(app, pass);
    const deleted = await app.app.inject({ method: "POST", url: `/c/${card.webSecret}/delete`, ...formBody({ confirm: "yes", lang: "en" }) });
    expect(deleted.statusCode).toBe(200);
    expect((await context.admin.query("SELECT 1 FROM app.apple_passes WHERE card_id = $1", [card.cardId])).rowCount).toBe(0);
    expect(await registrations(pass.serial)).toEqual([]);
    expect((await latest(app, pass)).statusCode).toBe(401);
  });
});
