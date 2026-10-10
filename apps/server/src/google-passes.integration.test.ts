import { createVerify, randomUUID } from "node:crypto";
import { GOOGLE_PASS_UPDATE_QUEUE } from "@cafe-loyalty/db";
import { syncResponseSchema } from "@cafe-loyalty/shared";
import { describe, expect, it } from "vitest";
import { hashToken, newToken } from "./credentials.js";
import { emailLookup, signCardQr } from "./customer-crypto.js";
import { GOOGLE_WALLET_BADGES } from "./google-pass.js";
import { PUBLIC_URL, TEST_GOOGLE, TEST_SECRETS, signedEvent, useApiHarness, withBearer, withCookie } from "./testing/api-harness.js";
import { parseWalletCheckArgs, runWalletCheck } from "./wallet-check.js";

const context = useApiHarness();
const { harness, signUp, pairDevice, issueCard, queuedPassUpdates } = context;

const ISSUER = TEST_GOOGLE.config.issuerId;
const IPHONE = { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" };
const ANDROID = { "user-agent": "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36" };
const HOUR = 60 * 60 * 1000;
const SAVE_PREFIX = "https://pay.google.com/gp/v/save/";

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
  return { ...h, owner, as, coffee, staffId, device };
}

type App = Awaited<ReturnType<typeof cafeApp>>;
let sequence = 0;

/** Records a visit of one coffee for the card through the counter sync; it adds a stamp unless refused. */
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

interface SaveLink {
  url: string;
  claims: Record<string, unknown>;
  loyaltyClass: Record<string, unknown>;
  object: Record<string, unknown>;
}

/** Opens "Add to Google Wallet" and reads the JWT of Google's save page, checking the service account signed it. */
async function openSaveLink(app: App, webSecret: string): Promise<SaveLink> {
  const response = await app.app.inject({ method: "GET", url: `/c/${webSecret}/google-pass?lang=en`, headers: ANDROID });
  expect(response.statusCode).toBe(303);
  const location = String(response.headers.location);
  expect(location.startsWith(SAVE_PREFIX)).toBe(true);
  const [header = "", claims = "", signature = ""] = location.slice(SAVE_PREFIX.length).split(".");
  expect(JSON.parse(Buffer.from(header, "base64url").toString("utf8"))).toEqual({ alg: "RS256", typ: "JWT" });
  expect(createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(TEST_GOOGLE.publicKey, signature, "base64url")).toBe(true);
  const parsed = JSON.parse(Buffer.from(claims, "base64url").toString("utf8")) as { payload: { loyaltyClasses: Record<string, unknown>[]; loyaltyObjects: Record<string, unknown>[] } };
  return { url: location, claims: parsed, loyaltyClass: parsed.payload.loyaltyClasses[0] ?? {}, object: parsed.payload.loyaltyObjects[0] ?? {} };
}

const googlePassIds = async (cardId: string): Promise<string[]> =>
  (await context.admin.query<{ id: string }>("SELECT id FROM app.google_passes WHERE card_id = $1 ORDER BY epoch", [cardId])).rows.map((row) => row.id);

const clearJobs = (cafeId: string) => context.admin.query("DELETE FROM pgboss.job WHERE data->>'cafeId' = $1", [cafeId]);

describe("Google pass save links", () => {
  it("offers the card as a Google pass on other devices' web cards, through a save link the service account signs (AC 10, 12)", async () => {
    const app = await cafeApp();
    const card = await issueCard(app.owner.cafeId);
    const page = await app.app.inject({ method: "GET", url: `/c/${card.webSecret}?lang=en`, headers: ANDROID });
    expect(page.body).toContain(`href="/c/${card.webSecret}/google-pass?lang=en"`);
    // Google's own badge (its brand guidelines allow no other), named in the page's language.
    expect(page.body).toContain(`<img src="${GOOGLE_WALLET_BADGES.en}" alt="Add to Google Wallet" width="199" height="55">`);
    const arabic = await app.app.inject({ method: "GET", url: `/c/${card.webSecret}?lang=ar`, headers: ANDROID });
    expect(arabic.body).toContain(`<img src="${GOOGLE_WALLET_BADGES.ar}" alt="إضافة إلى محفظة Google"`);
    expect(GOOGLE_WALLET_BADGES.ar).not.toBe(GOOGLE_WALLET_BADGES.en);
    // Apple devices get the Apple pass instead.
    expect((await app.app.inject({ method: "GET", url: `/c/${card.webSecret}?lang=en`, headers: IPHONE })).body).not.toContain("google-pass");

    expect(await stamp(app, card.qr)).toBe("OK");
    const link = await openSaveLink(app, card.webSecret);
    expect(link.claims).toMatchObject({ iss: TEST_GOOGLE.config.serviceAccount.email, aud: "google", typ: "savetowallet", origins: [] });
    // Ids derive from the café and the card at its epoch, so every write lands on the same class and object.
    expect(link.loyaltyClass).toMatchObject({
      id: `${ISSUER}.cafe-${app.owner.cafeId}`,
      issuerName: "Café Test",
      programLogo: { sourceUri: { uri: `${PUBLIC_URL}/wallet/logo.png` } },
      reviewStatus: "UNDER_REVIEW",
    });
    expect(link.object).toMatchObject({
      id: `${ISSUER}.card-${card.cardId}-1`,
      classId: `${ISSUER}.cafe-${app.owner.cafeId}`,
      state: "ACTIVE",
      barcode: { type: "QR_CODE", value: card.qr },
      loyaltyPoints: { balance: { string: "1/2" } },
    });
    // Short enough for every browser (Google advises under about 1,800 characters); the queued write adds the texts.
    expect(link.url.length).toBeLessThan(1_800);
    expect(link.object).not.toHaveProperty("textModulesData");

    // The pass is recorded and its write queued, whether or not the customer saves it; opening the link again
    // keeps the one pass and its one waiting job.
    const [passId] = await googlePassIds(card.cardId);
    expect(await queuedPassUpdates(app.owner.cafeId, GOOGLE_PASS_UPDATE_QUEUE)).toEqual([{ passId, state: "created" }]);
    await openSaveLink(app, card.webSecret);
    expect(await googlePassIds(card.cardId)).toEqual([passId]);
    expect(await queuedPassUpdates(app.owner.cafeId, GOOGLE_PASS_UPDATE_QUEUE)).toEqual([{ passId, state: "created" }]);
  });

  it("records the pass and still sends the browser to Google when the job queue could not start; the sweep writes it later", async () => {
    const app = await cafeApp({ jobs: null });
    const card = await issueCard(app.owner.cafeId);
    await openSaveLink(app, card.webSecret);
    const [passId] = await googlePassIds(card.cardId);
    expect(passId).toBeDefined();
    expect(await queuedPassUpdates(app.owner.cafeId, GOOGLE_PASS_UPDATE_QUEUE)).toEqual([]);
    // Never delivered, so the worker's sweep (undelivered_passes) queues its write.
    const { rows } = await context.admin.query<{ delivered: boolean }>("SELECT delivered_xid IS NOT DISTINCT FROM updated_xid AS delivered FROM app.google_passes WHERE id = $1", [
      passId,
    ]);
    expect(rows).toEqual([{ delivered: false }]);
  });

  it("limits the save links one card opens, since each queues a write to Google", async () => {
    const app = await cafeApp();
    const card = await issueCard(app.owner.cafeId);
    for (let link = 0; link < 20; link += 1) {
      expect((await app.app.inject({ method: "GET", url: `/c/${card.webSecret}/google-pass?lang=en` })).statusCode).toBe(303);
    }
    const refused = await app.app.inject({ method: "GET", url: `/c/${card.webSecret}/google-pass?lang=en` });
    expect(refused.statusCode).toBe(429);
    expect(refused.headers["retry-after"]).toBeDefined();
  });

  it("offers no Google pass when Google Wallet is not configured", async () => {
    const app = await cafeApp({ google: null });
    const card = await issueCard(app.owner.cafeId);
    expect((await app.app.inject({ method: "GET", url: `/c/${card.webSecret}?lang=en`, headers: ANDROID })).body).not.toContain("google-pass");
    expect((await app.app.inject({ method: "GET", url: `/c/${card.webSecret}/google-pass` })).statusCode).toBe(404);
    expect((await app.app.inject({ method: "GET", url: "/wallet/logo.png" })).statusCode).toBe(404);
  });

  it("serves the class logo Google fetches as a PNG", async () => {
    const app = await cafeApp();
    const logo = await app.app.inject({ method: "GET", url: "/wallet/logo.png" });
    expect(logo.statusCode).toBe(200);
    expect(logo.headers["content-type"]).toBe("image/png");
    expect(logo.rawPayload.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });
});

describe("Google pass updates", () => {
  it("queues the pass's write with each stamp, and after a recovery only the old object's, which goes INACTIVE (AC 8, 13)", async () => {
    const app = await cafeApp();
    const card = await issueCard(app.owner.cafeId);
    const email = `card-${randomUUID()}@example.com`;
    await context.admin.query("UPDATE app.cards SET email = $1, email_lookup = $2 WHERE id = $3", [email, emailLookup(TEST_SECRETS, email), card.cardId]);
    await openSaveLink(app, card.webSecret);
    const [old = ""] = await googlePassIds(card.cardId);
    await clearJobs(app.owner.cafeId);
    expect(await stamp(app, card.qr, new Date(Date.now() - HOUR))).toBe("OK");
    expect(await queuedPassUpdates(app.owner.cafeId, GOOGLE_PASS_UPDATE_QUEUE)).toEqual([{ passId: old, state: "created" }]);

    await clearJobs(app.owner.cafeId);
    const recovery = newToken();
    await context.admin.query("INSERT INTO app.customer_recovery_tokens (email_lookup, token_hash, expires_at) VALUES ($1, $2, now() + interval '10 minutes')", [
      emailLookup(TEST_SECRETS, email),
      hashToken(recovery),
    ]);
    const restored = await app.app.inject({ method: "POST", url: `/r/${recovery}`, ...formBody({ action: "restore", lang: "en" }) });
    expect(restored.statusCode).toBe(303);
    expect(await queuedPassUpdates(app.owner.cafeId, GOOGLE_PASS_UPDATE_QUEUE)).toEqual([{ passId: old, state: "created" }]);

    // The new phone's object is a new one; visits reach it only.
    const newSecret = /^\/c\/([A-Za-z0-9_-]{43})\?/.exec(String(restored.headers.location))?.[1] ?? "missing";
    const fresh = await openSaveLink(app, newSecret);
    expect(fresh.object).toMatchObject({ id: `${ISSUER}.card-${card.cardId}-2`, state: "ACTIVE" });
    const [, renewed] = await googlePassIds(card.cardId);
    await clearJobs(app.owner.cafeId);
    expect(await stamp(app, signCardQr(TEST_SECRETS, { cardId: card.cardId, cafeId: app.owner.cafeId, epoch: 2 }))).toBe("OK");
    expect(await queuedPassUpdates(app.owner.cafeId, GOOGLE_PASS_UPDATE_QUEUE)).toEqual([{ passId: renewed, state: "created" }]);
  });

  it("deletes a card's Google passes with the card (AC 9)", async () => {
    const app = await cafeApp();
    const card = await issueCard(app.owner.cafeId);
    await openSaveLink(app, card.webSecret);
    const deleted = await app.app.inject({ method: "POST", url: `/c/${card.webSecret}/delete`, ...formBody({ confirm: "yes", lang: "en" }) });
    expect(deleted.statusCode).toBe(200);
    expect(await googlePassIds(card.cardId)).toEqual([]);
  });
});

describe("wallet delivery failures (AC 13)", () => {
  it("shows the owner each wallet whose passes keep failing to update, for their café only", async () => {
    const app = await cafeApp();
    const other = await cafeApp();
    const failing = await issueCard(app.owner.cafeId);
    const alsoFailing = await issueCard(app.owner.cafeId);
    const retrying = await issueCard(app.owner.cafeId);
    const theirs = await issueCard(other.owner.cafeId);
    expect((await app.app.inject({ method: "GET", url: `/c/${failing.webSecret}/apple-pass` })).statusCode).toBe(200);
    for (const [owner, card] of [
      [app, failing],
      [app, alsoFailing],
      [app, retrying],
      [other, theirs],
    ] as const) {
      await openSaveLink(owner, card.webSecret);
    }
    const fail = (table: string, cardId: string, failures: number, error: string, minutesAgo: number) =>
      context.admin.query(
        `UPDATE app.${table} SET delivery_failures = $1, delivery_error = $2, delivery_failed_at = now() - make_interval(mins => $3) WHERE card_id = $4`,
        [failures, error, minutesAgo, cardId],
      );
    expect((await app.as("GET", "/api/cafe/wallet-deliveries")).json()).toEqual({ failing: [] });

    await fail("apple_passes", failing.cardId, 3, "apns_503_ServiceUnavailable", 5);
    await fail("google_passes", failing.cardId, 7, "google_503_UNAVAILABLE", 1);
    // Older: the newest failure's time and code are the ones shown.
    await fail("google_passes", alsoFailing.cardId, 12, "timeout", 30);
    // Two failures are routine retries, not yet shown.
    await fail("google_passes", retrying.cardId, 2, "timeout", 0);
    await fail("google_passes", theirs.cardId, 9, "google_auth_401", 0);

    const response = await app.as("GET", "/api/cafe/wallet-deliveries");
    expect(response.statusCode).toBe(200);
    const body = response.json<{ failing: { wallet: string; passes: number; lastError: string; lastFailedAt: string }[] }>();
    expect(body.failing).toEqual([
      { wallet: "apple", passes: 1, lastError: "apns_503_ServiceUnavailable", lastFailedAt: expect.any(String) as unknown },
      { wallet: "google", passes: 2, lastError: "google_503_UNAVAILABLE", lastFailedAt: expect.any(String) as unknown },
    ]);
    const age = Date.now() - Date.parse(body.failing[1]?.lastFailedAt ?? "");
    expect(age).toBeGreaterThan(50_000);
    expect(age).toBeLessThan(2 * 60 * 1000 + 5_000);
  });
});

describe("manual wallet check (AC 46)", () => {
  it("reads its commands and refuses anything else", () => {
    const cafeId = randomUUID();
    const secret = newToken();
    expect(parseWalletCheckArgs(["issue", "--cafe-id", cafeId])).toEqual({ command: "issue", cafeId });
    expect(parseWalletCheckArgs(["stamp", `${PUBLIC_URL}/c/${secret}?lang=ar`])).toEqual({ command: "stamp", secret });
    expect(parseWalletCheckArgs(["restore", secret])).toEqual({ command: "restore", secret });
    expect(parseWalletCheckArgs(["offer", secret])).toEqual({ command: "offer", secret });
    for (const wrong of [[], ["issue"], ["issue", "--cafe-id", "nope"], ["stamp"], ["stamp", "https://card.example.test/c/short"], ["stamp", secret, "extra"], ["delete", secret], ["stamp", secret, "--cafe-id", cafeId]]) {
      expect(parseWalletCheckArgs(wrong)).toBeNull();
    }
  });

  it("issues a demo card, stamps it round to its reward and moves it, queueing every pass's update", async () => {
    const app = await cafeApp();
    const db = context.testDb.app.db;
    const issued = await runWalletCheck(db, context.jobs, PUBLIC_URL, { command: "issue", cafeId: app.owner.cafeId });
    const secret = new RegExp(`${PUBLIC_URL}/c/([A-Za-z0-9_-]{43})`).exec(issued)?.[1] ?? "missing";
    expect((await app.app.inject({ method: "GET", url: `/c/${secret}?lang=en` })).statusCode).toBe(200);
    expect((await app.app.inject({ method: "GET", url: `/c/${secret}/apple-pass` })).statusCode).toBe(200);
    await openSaveLink(app, secret);
    await clearJobs(app.owner.cafeId);

    // Two stamps fill the card; the next starts it again, as a redeemed reward would.
    const said = [];
    for (let round = 0; round < 3; round += 1) {
      said.push(await runWalletCheck(db, context.jobs, PUBLIC_URL, { command: "stamp", secret }));
    }
    expect(said.map((line) => /has (\d+) stamps/.exec(line)?.[1])).toEqual(["1", "2", "0"]);
    expect(await queuedPassUpdates(app.owner.cafeId)).toHaveLength(1);
    expect(await queuedPassUpdates(app.owner.cafeId, GOOGLE_PASS_UPDATE_QUEUE)).toHaveLength(1);

    // An offer needs a running campaign the card was not told of yet; it opts the card in.
    await expect(runWalletCheck(db, context.jobs, PUBLIC_URL, { command: "offer", secret })).rejects.toThrow("no running campaign");
    const campaign = await app.app.inject({
      method: "POST",
      url: "/api/campaigns",
      headers: withCookie(app.owner.session),
      payload: { nameAr: "عصرية", nameEn: "Afternoon", weekdays: [1], startsMinute: 840, endsMinute: 960, discount: { kind: "percent", value: 10 }, orderTypeIds: [app.coffee] },
    });
    expect(campaign.statusCode).toBe(201);
    await clearJobs(app.owner.cafeId);
    expect(await runWalletCheck(db, context.jobs, PUBLIC_URL, { command: "offer", secret })).toContain('Announced "Afternoon"');
    expect(await queuedPassUpdates(app.owner.cafeId)).toHaveLength(1);
    expect(await queuedPassUpdates(app.owner.cafeId, GOOGLE_PASS_UPDATE_QUEUE)).toHaveLength(1);
    const { rows } = await context.admin.query("SELECT offers_opt_in_at IS NOT NULL AS opted_in FROM app.cards WHERE web_secret_hash = $1", [hashToken(secret)]);
    expect(rows).toEqual([{ opted_in: true }]);
    await expect(runWalletCheck(db, context.jobs, PUBLIC_URL, { command: "offer", secret })).rejects.toThrow("no running campaign");

    await clearJobs(app.owner.cafeId);
    const moved = await runWalletCheck(db, context.jobs, PUBLIC_URL, { command: "restore", secret });
    const newSecret = new RegExp(`${PUBLIC_URL}/c/([A-Za-z0-9_-]{43})`).exec(moved)?.[1] ?? "missing";
    expect((await app.app.inject({ method: "GET", url: `/c/${secret}?lang=en` })).statusCode).toBe(404);
    expect((await app.app.inject({ method: "GET", url: `/c/${newSecret}?lang=en` })).statusCode).toBe(200);
    expect(await queuedPassUpdates(app.owner.cafeId)).toHaveLength(1);
    expect(await queuedPassUpdates(app.owner.cafeId, GOOGLE_PASS_UPDATE_QUEUE)).toHaveLength(1);
    await expect(runWalletCheck(db, context.jobs, PUBLIC_URL, { command: "stamp", secret })).rejects.toThrow("No card has this link");
    expect(await context.auditActions(app.owner.cafeId)).toEqual(expect.arrayContaining(["card.created", "card.stamps_set", "card.offer_announced", "card.restored"]));
  });
});
