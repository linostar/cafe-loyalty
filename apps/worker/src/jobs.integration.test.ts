import { randomBytes, randomUUID } from "node:crypto";
import {
  APPLE_PASS_UPDATE_QUEUE,
  GOOGLE_PASS_UPDATE_QUEUE,
  createJobQueue,
  loadCardOffer,
  verifyCardQr,
  verifyFeedbackToken,
  withCafe,
  type GoogleLoyaltyClass,
  type GoogleLoyaltyObject,
  type GoogleOfferMessage,
} from "@cafe-loyalty/db";
import { createTestDatabase, type TestDatabase } from "@cafe-loyalty/db/testing";
import { sql } from "kysely";
import pg from "pg";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PassPusher, PushResult } from "./apns.js";
import { DeliveryError } from "./delivery.js";
import { writeGooglePass, type GooglePassSettings } from "./google-passes.js";
import type { GoogleWallet, SaveResult } from "./google-wallet.js";
import { PURGE_QUEUE, RESEND_QUEUE, jobQueueTask } from "./jobs.js";
import { ANNOUNCE_QUEUE, announceCampaigns } from "./offers.js";
import { FEEDBACK_QUEUE } from "./feedback.js";
import { WIN_BACK_QUEUE, runWinBack } from "./win-back.js";

let db: TestDatabase;
let admin: pg.Client;

beforeAll(async () => {
  db = await createTestDatabase();
  admin = new pg.Client({ connectionString: db.adminUrl });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
  await db.cleanup();
});

/** APNs as a test sees it: every push token it was sent, answering from `answers` (default "sent"). */
class FakePusher implements PassPusher {
  readonly pushed: string[] = [];
  readonly answers = new Map<string, PushResult | Error>();

  push(pushToken: string): Promise<PushResult> {
    this.pushed.push(pushToken);
    const answer = this.answers.get(pushToken) ?? "sent";
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  }

  close(): void {
    // Nothing to release.
  }
}

/** Google Wallet as a test sees it: every save it was asked for, answering `answer`. */
class FakeGoogleWallet implements GoogleWallet {
  readonly saved: { loyaltyClass: GoogleLoyaltyClass; object: GoogleLoyaltyObject; create: boolean; message: GoogleOfferMessage | undefined }[] = [];
  answer: SaveResult | Error = "updated";

  save(loyaltyClass: GoogleLoyaltyClass, object: GoogleLoyaltyObject, create: boolean, message?: GoogleOfferMessage): Promise<SaveResult> {
    this.saved.push({ loyaltyClass, object, create, message });
    return this.answer instanceof Error ? Promise.reject(this.answer) : Promise.resolve(this.answer);
  }
}

const GOOGLE: GooglePassSettings = { issuerId: "3388000000012345678", publicUrl: "https://card.example.test", cardQr: { keys: [{ id: "q1", key: randomBytes(32) }] } };

/**
 * A worker's job queue writing its log lines to `lines`; `apns: false` is a worker without Apple Wallet, `google:
 * false` one without Google Wallet.
 */
function jobQueue({ apns = true, google = true } = {}) {
  const lines: Record<string, unknown>[] = [];
  const logger = pino({ level: "info" }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
  const boss = createJobQueue(db.appUrl, logger, { applicationName: "worker-test", maxConnections: 4 });
  const pusher = new FakePusher();
  const wallet = new FakeGoogleWallet();
  const task = jobQueueTask(boss, logger, 15_000, { db: db.app.db, pusher: apns ? pusher : undefined, google: google ? { wallet, settings: GOOGLE } : undefined });
  return { boss, task, lines, pusher, wallet };
}

const codeOf = (query: Promise<unknown>) =>
  query.then(
    () => undefined,
    (caught: unknown) => (caught as { code?: string }).code,
  );

const finished = async (boss: ReturnType<typeof jobQueue>["boss"], queue: string, id: string, state: "completed" | "failed") => {
  await vi.waitFor(
    async () => {
      expect(await boss.findJobs(queue, { id })).toMatchObject([{ state }]);
    },
    { timeout: 20_000, interval: 250 },
  );
  return (await boss.findJobs(queue, { id }))[0];
};

/** A café's card with an Apple pass registered on `devices` devices; returns their push tokens. */
async function passWithDevices(devices: number): Promise<{ cafeId: string; passId: string; tokens: string[] }> {
  const cafeId = randomUUID();
  const cardId = randomUUID();
  const passId = randomUUID();
  await admin.query("INSERT INTO app.cafes (id, name) VALUES ($1, 'Café')", [cafeId]);
  await admin.query("INSERT INTO app.cards (id, cafe_id, web_secret_hash, privacy_accepted_at) VALUES ($1, $2, $3, now())", [cardId, cafeId, randomBytes(32)]);
  // Delivered, so a scheduled sweep during the tests leaves it alone.
  await admin.query(
    "INSERT INTO app.apple_passes (id, cafe_id, card_id, epoch, auth_token_hash, layout_version, delivered_xid) VALUES ($1, $2, $3, 1, $4, 1, pg_current_xact_id())",
    [passId, cafeId, cardId, randomBytes(32)],
  );
  const tokens: string[] = [];
  for (let device = 0; device < devices; device += 1) {
    const token = randomBytes(32).toString("hex");
    await admin.query("INSERT INTO app.apple_pass_registrations (cafe_id, pass_id, device_library_hash, push_token) VALUES ($1, $2, $3, $4)", [
      cafeId,
      passId,
      randomBytes(32),
      token,
    ]);
    tokens.push(token);
  }
  return { cafeId, passId, tokens: tokens.sort() };
}

/** A café's card with 3 of 9 stamps at `cardEpoch`, and its Google pass of `epoch` (delivered, like passWithDevices's). */
async function googlePass({ epoch = 1, cardEpoch = 1 } = {}): Promise<{ cafeId: string; cardId: string; passId: string }> {
  const cafeId = randomUUID();
  const cardId = randomUUID();
  const passId = randomUUID();
  await admin.query("INSERT INTO app.cafes (id, name) VALUES ($1, 'Café Najjar')", [cafeId]);
  await admin.query("INSERT INTO app.loyalty_programs (cafe_id, stamps_required, reward_name_ar, reward_name_en) VALUES ($1, 9, 'قهوة مجانية', 'Free coffee')", [cafeId]);
  await admin.query("INSERT INTO app.cards (id, cafe_id, web_secret_hash, privacy_accepted_at, epoch, stamps) VALUES ($1, $2, $3, now(), $4, 3)", [
    cardId,
    cafeId,
    randomBytes(32),
    cardEpoch,
  ]);
  await admin.query("INSERT INTO app.google_passes (id, cafe_id, card_id, epoch, delivered_xid) VALUES ($1, $2, $3, $4, pg_current_xact_id())", [
    passId,
    cafeId,
    cardId,
    epoch,
  ]);
  return { cafeId, cardId, passId };
}

/** A pass's failures in a row, and whether its latest change was delivered. */
const deliveryState = async (table: "apple_passes" | "google_passes", passId: string) =>
  (
    await admin.query<{ delivery_failures: number; delivery_error: string | null; failed: boolean; delivered: boolean }>(
      `SELECT delivery_failures, delivery_error, delivery_failed_at IS NOT NULL AS failed, delivered_xid IS NOT DISTINCT FROM updated_xid AS delivered
         FROM app.${table} WHERE id = $1`,
      [passId],
    )
  ).rows[0];

/** Marks a pass changed after its last delivery, as a change whose update never ran leaves it. */
const undeliver = (table: "apple_passes" | "google_passes", passId: string) =>
  admin.query(`UPDATE app.${table} SET updated_xid = pg_current_xact_id() WHERE id = $1`, [passId]);

const registrationTokens = async (cafeId: string): Promise<string[]> =>
  (await admin.query<{ push_token: string }>("SELECT push_token FROM app.apple_pass_registrations WHERE cafe_id = $1 ORDER BY push_token", [cafeId])).rows.map(
    (row) => row.push_token,
  );

/**
 * A café whose clock reads between 06:00 and 18:00 now (a fixed-offset zone picked from the UTC hour), so a campaign
 * running all day has hours left whenever the test runs; returns the café and its local minute of the day.
 */
async function cafeAtDaytime(): Promise<{ cafeId: string; minute: number; weekday: number }> {
  const cafeId = randomUUID();
  // Etc/GMT+6 is UTC-6 (POSIX signs).
  const timeZone = new Date().getUTCHours() >= 12 ? "Etc/GMT+6" : "Etc/GMT-6";
  await admin.query("INSERT INTO app.cafes (id, name, time_zone) VALUES ($1, 'Café Najjar', $2)", [cafeId, timeZone]);
  const { rows } = await admin.query<{ minute: number; weekday: number }>(
    `SELECT (extract(hour FROM now() AT TIME ZONE $1) * 60 + extract(minute FROM now() AT TIME ZONE $1))::int AS minute,
            extract(isodow FROM now() AT TIME ZONE $1)::int AS weekday`,
    [timeZone],
  );
  return { cafeId, minute: rows[0]?.minute ?? 0, weekday: rows[0]?.weekday ?? 0 };
}

const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];

/** A campaign of the café on `weekdays`, from `starts` to `ends` (local minutes), 20% off its one order type. */
async function campaign(cafeId: string, name: string, starts: number, ends: number, weekdays = EVERY_DAY): Promise<string> {
  const id = randomUUID();
  const orderType = randomUUID();
  await admin.query("INSERT INTO app.order_types (id, cafe_id, name_ar, name_en, price_cents, cost_cents) VALUES ($1, $2, 'إسبريسو', 'Espresso', 250, 70)", [orderType, cafeId]);
  await admin.query(
    `INSERT INTO app.campaigns (id, cafe_id, name_ar, name_en, weekdays, starts_minute, ends_minute, discount_kind, discount_value, min_margin_percent, created_at)
     VALUES ($1, $2, $3, $3, $6, $4, $5, 'percent', 20, 0, clock_timestamp())`,
    [id, cafeId, name, starts, ends, weekdays],
  );
  await admin.query("INSERT INTO app.campaign_order_types (cafe_id, campaign_id, order_type_id) VALUES ($1, $2, $3)", [cafeId, id, orderType]);
  return id;
}

/**
 * A card of the café, opted in to offers or not, with delivered Apple and Google passes when `passes`; the Apple pass
 * is on one device unless `onDevice` is false.
 */
async function offerCard(cafeId: string, { optedIn = true, passes = false, onDevice = true } = {}) {
  const cardId = randomUUID();
  await admin.query("INSERT INTO app.cards (id, cafe_id, web_secret_hash, privacy_accepted_at, offers_opt_in_at) VALUES ($1, $2, $3, now(), $4)", [
    cardId,
    cafeId,
    randomBytes(32),
    optedIn ? new Date() : null,
  ]);
  if (!passes) {
    return { cardId, applePassId: "", googlePassId: "", token: "" };
  }
  const applePassId = randomUUID();
  const googlePassId = randomUUID();
  const token = onDevice ? randomBytes(32).toString("hex") : "";
  await admin.query(
    "INSERT INTO app.apple_passes (id, cafe_id, card_id, epoch, auth_token_hash, layout_version, delivered_xid) VALUES ($1, $2, $3, 1, $4, 2, pg_current_xact_id())",
    [applePassId, cafeId, cardId, randomBytes(32)],
  );
  if (onDevice) {
    await admin.query("INSERT INTO app.apple_pass_registrations (cafe_id, pass_id, device_library_hash, push_token) VALUES ($1, $2, $3, $4)", [cafeId, applePassId, randomBytes(32), token]);
  }
  await admin.query("INSERT INTO app.google_passes (id, cafe_id, card_id, epoch, delivered_xid) VALUES ($1, $2, $3, 1, pg_current_xact_id())", [googlePassId, cafeId, cardId]);
  return { cardId, applePassId, googlePassId, token };
}

/** A café whose clock reads `hour` o'clock now (a fixed-offset zone picked from the UTC hour), with a win-back offer. */
async function cafeAtHour(hour: number, winBack: { percent: number; cooldownDays: number } | null = { percent: 20, cooldownDays: 30 }): Promise<string> {
  let offset = hour - new Date().getUTCHours();
  offset = offset > 14 ? offset - 24 : offset < -12 ? offset + 24 : offset;
  // Etc/GMT-3 is UTC+3 (POSIX signs).
  const timeZone = offset === 0 ? "UTC" : offset > 0 ? `Etc/GMT-${String(offset)}` : `Etc/GMT+${String(-offset)}`;
  const cafeId = randomUUID();
  await admin.query(
    "INSERT INTO app.cafes (id, name, time_zone, min_margin_percent, win_back_discount_kind, win_back_discount_value, win_back_cooldown_days) VALUES ($1, 'Café Najjar', $2, 30, $3, $4, $5)",
    [cafeId, timeZone, winBack === null ? null : "percent", winBack?.percent ?? null, winBack?.cooldownDays ?? 30],
  );
  return cafeId;
}

/**
 * Member visits of a card, `daysAgo` each. Bare rows: the admin connection skips the foreign keys for them (no
 * device, staff or signed event behind), and they add no stamps.
 */
async function visited(cafeId: string, cardId: string, daysAgo: readonly number[], outcome = "no_stamps"): Promise<void> {
  await admin.query("SET session_replication_role = replica");
  try {
    for (const days of daysAgo) {
      await admin.query(
        `INSERT INTO app.visits (cafe_id, sync_event_id, card_id, identified_by, device_id, staff_id, occurred_at, total_cents, stamps_earned, stamps_added, outcome)
         VALUES ($1, gen_random_uuid(), $2, 'qr', gen_random_uuid(), gen_random_uuid(), now() - $3 * interval '1 day', 300, 0, 0, $4)`,
        [cafeId, cardId, days, outcome],
      );
    }
  } finally {
    await admin.query("SET session_replication_role = DEFAULT");
  }
}

/** The café's lapses as "card offered|none", sorted. */
const lapses = async (cafeId: string): Promise<string[]> =>
  (
    await admin.query<{ entry: string }>(
      "SELECT card_id || CASE WHEN discount_kind IS NULL THEN ' none' ELSE ' offered' END AS entry FROM app.card_lapses WHERE cafe_id = $1",
      [cafeId],
    )
  ).rows
    .map((row) => row.entry)
    .sort();

/** The café's announcements as "card campaign" pairs, sorted. */
const announcements = async (cafeId: string): Promise<string[]> =>
  (await admin.query<{ pair: string }>("SELECT card_id || ' ' || campaign_id AS pair FROM app.campaign_announcements WHERE cafe_id = $1", [cafeId])).rows.map((row) => row.pair).sort();

// In order: the first starts the queue (creating it), which the last one tampers with.
describe("job queue", () => {
  it("runs the hourly purge as a job of the migrated pg-boss schema, as the app role", async () => {
    await admin.query("INSERT INTO app.customer_recovery_tokens (email_lookup, token_hash, expires_at) VALUES ($1, $2, now() - interval '1 minute')", [
      randomBytes(32),
      randomBytes(32),
    ]);
    const { boss, task } = jobQueue();
    // Fails if the pg-boss library expects another schema version than migration 0007 installed.
    await task.start();
    try {
      expect(
        (await boss.getSchedules()).map((schedule) => ({ name: schedule.name, cron: schedule.cron })).sort((a, b) => a.name.localeCompare(b.name)),
      ).toEqual([
        { name: ANNOUNCE_QUEUE, cron: "*/5 * * * *" },
        { name: PURGE_QUEUE, cron: "17 * * * *" },
        { name: FEEDBACK_QUEUE, cron: "9,24,39,54 * * * *" },
        { name: RESEND_QUEUE, cron: "4,19,34,49 * * * *" },
        { name: WIN_BACK_QUEUE, cron: "41 * * * *" },
      ]);
      // What the schedule sends every hour, picked up by the worker's own handler.
      const id = (await boss.send(PURGE_QUEUE)) ?? "";
      // Counts in the output; the token itself may have gone in a scheduled run at minute 17.
      expect(await finished(boss, PURGE_QUEUE, id, "completed")).toMatchObject({ output: { customer_recovery_tokens: expect.any(Number) as unknown } });
      expect((await admin.query("SELECT 1 FROM app.customer_recovery_tokens")).rowCount).toBe(0);
    } finally {
      await task.stop();
    }
  });

  it("logs a purge that fails, which pg-boss alone would only mark failed", async () => {
    await admin.query("REVOKE EXECUTE ON FUNCTION app.purge_expired_credentials() FROM cl_app");
    const { boss, task, lines } = jobQueue();
    await task.start();
    try {
      const id = (await boss.send(PURGE_QUEUE, null, { retryLimit: 0 })) ?? "";
      await finished(boss, PURGE_QUEUE, id, "failed");
      expect(lines).toContainEqual(expect.objectContaining({ level: 50, msg: "job failed", job: PURGE_QUEUE, jobId: id }));
    } finally {
      await task.stop();
      await admin.query("GRANT EXECUTE ON FUNCTION app.purge_expired_credentials() TO cl_app");
    }
  });

  it("pushes an update to every device registered for a pass and drops those APNs reports gone", async () => {
    const pass = await passWithDevices(3);
    const other = await passWithDevices(1);
    const { boss, task, pusher } = jobQueue();
    const [kept, gone, alsoKept] = pass.tokens;
    pusher.answers.set(gone ?? "", "unregistered");
    await task.start();
    try {
      const id = (await boss.send(APPLE_PASS_UPDATE_QUEUE, { cafeId: pass.cafeId, passId: pass.passId })) ?? "";
      expect(await finished(boss, APPLE_PASS_UPDATE_QUEUE, id, "completed")).toMatchObject({ output: { sent: 2, removed: 1 } });
      expect([...pusher.pushed].sort()).toEqual(pass.tokens);
      expect(await registrationTokens(pass.cafeId)).toEqual([kept, alsoKept]);
      expect(await registrationTokens(other.cafeId)).toEqual(other.tokens);
    } finally {
      await task.stop();
    }
  });

  it("fails and logs a pass update APNs did not take, with its job and café, keeping the registration", async () => {
    const pass = await passWithDevices(1);
    const { boss, task, pusher, lines } = jobQueue();
    pusher.answers.set(pass.tokens[0] ?? "", new DeliveryError("APNs answered 503.", "apns_503"));
    await task.start();
    try {
      const id = (await boss.send(APPLE_PASS_UPDATE_QUEUE, { cafeId: pass.cafeId, passId: pass.passId }, { retryLimit: 0 })) ?? "";
      await finished(boss, APPLE_PASS_UPDATE_QUEUE, id, "failed");
      expect(lines).toContainEqual(expect.objectContaining({ level: 50, msg: "job failed", job: APPLE_PASS_UPDATE_QUEUE, jobId: id, cafeId: pass.cafeId }));
      expect(await registrationTokens(pass.cafeId)).toEqual(pass.tokens);
      // Counted on the pass, for the owner dashboard (AC 13).
      expect(await deliveryState("apple_passes", pass.passId)).toEqual({ delivery_failures: 1, delivery_error: "apns_503", failed: true, delivered: true });
      // The push token never reaches the logs.
      expect(JSON.stringify(lines)).not.toContain(pass.tokens[0]);
    } finally {
      await task.stop();
    }
  });

  it("retries a failed pass update with backoff, as its queue is set up (AC 13)", async () => {
    const pass = await passWithDevices(1);
    const { boss, task, pusher } = jobQueue();
    pusher.answers.set(pass.tokens[0] ?? "", new Error("APNs answered 503."));
    await task.start();
    try {
      for (const queue of [APPLE_PASS_UPDATE_QUEUE, GOOGLE_PASS_UPDATE_QUEUE]) {
        expect(await boss.getQueue(queue)).toMatchObject({
          policy: "short",
          retryLimit: 12,
          retryDelay: 30,
          retryBackoff: true,
          retryDelayMax: 3_600,
          expireInSeconds: 120,
        });
      }
      const id = (await boss.send(APPLE_PASS_UPDATE_QUEUE, { cafeId: pass.cafeId, passId: pass.passId })) ?? "";
      await vi.waitFor(
        async () => {
          expect(await boss.findJobs(APPLE_PASS_UPDATE_QUEUE, { id })).toMatchObject([{ state: "retry", retryLimit: 12 }]);
        },
        { timeout: 20_000, interval: 250 },
      );
    } finally {
      await task.stop();
    }
  });

  it("leaves pass updates queued on a worker without Apple or Google Wallet, for one that has them", async () => {
    const pass = await passWithDevices(1);
    const google = await googlePass();
    const { boss, task } = jobQueue({ apns: false, google: false });
    await task.start();
    try {
      const appleId = (await boss.send(APPLE_PASS_UPDATE_QUEUE, { cafeId: pass.cafeId, passId: pass.passId })) ?? "";
      const googleId = (await boss.send(GOOGLE_PASS_UPDATE_QUEUE, { cafeId: google.cafeId, passId: google.passId })) ?? "";
      // Longer than pg-boss's polling interval (2 seconds).
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(await boss.findJobs(APPLE_PASS_UPDATE_QUEUE, { id: appleId })).toMatchObject([{ state: "created" }]);
      expect(await boss.findJobs(GOOGLE_PASS_UPDATE_QUEUE, { id: googleId })).toMatchObject([{ state: "created" }]);
    } finally {
      await task.stop();
      // The next tests' workers have both and would take them.
      await admin.query("DELETE FROM pgboss.job WHERE data->>'passId' = ANY($1)", [[pass.passId, google.passId]]);
    }
  });

  it("writes a Google pass's object as the card now is, creating it if nobody saved it yet, and clears its failures (AC 12, 13)", async () => {
    const pass = await googlePass();
    await admin.query("UPDATE app.google_passes SET delivery_failures = 4, delivery_error = 'timeout', delivery_failed_at = now() WHERE id = $1", [pass.passId]);
    await undeliver("google_passes", pass.passId);
    const { boss, task, wallet } = jobQueue();
    wallet.answer = "created";
    await task.start();
    try {
      const id = (await boss.send(GOOGLE_PASS_UPDATE_QUEUE, { cafeId: pass.cafeId, passId: pass.passId })) ?? "";
      expect(await finished(boss, GOOGLE_PASS_UPDATE_QUEUE, id, "completed")).toMatchObject({ output: { result: "created" } });
      const [saved] = wallet.saved;
      expect(saved?.create).toBe(true);
      expect(saved?.loyaltyClass).toMatchObject({ id: `${GOOGLE.issuerId}.cafe-${pass.cafeId}`, issuerName: "Café Najjar", programLogo: { sourceUri: { uri: "https://card.example.test/wallet/logo.png" } } });
      expect(saved?.object).toMatchObject({ id: `${GOOGLE.issuerId}.card-${pass.cardId}-1`, state: "ACTIVE", loyaltyPoints: { balance: { string: "3/9" } } });
      // The card's QR, signed as the server signs it.
      const qr = saved?.object.state === "ACTIVE" ? saved.object.barcode.value : "";
      expect(verifyCardQr(GOOGLE, qr)).toEqual({ cardId: pass.cardId, cafeId: pass.cafeId, epoch: 1 });
      expect(await deliveryState("google_passes", pass.passId)).toEqual({ delivery_failures: 0, delivery_error: null, failed: false, delivered: true });
    } finally {
      await task.stop();
    }
  });

  it("writes an earlier epoch's Google object INACTIVE, without the QR, and only if it exists (AC 8)", async () => {
    const pass = await googlePass({ epoch: 1, cardEpoch: 2 });
    const { boss, task, wallet } = jobQueue();
    wallet.answer = "missing";
    await task.start();
    try {
      const id = (await boss.send(GOOGLE_PASS_UPDATE_QUEUE, { cafeId: pass.cafeId, passId: pass.passId })) ?? "";
      expect(await finished(boss, GOOGLE_PASS_UPDATE_QUEUE, id, "completed")).toMatchObject({ output: { result: "missing" } });
      expect(wallet.saved).toHaveLength(1);
      expect(wallet.saved[0]?.create).toBe(false);
      expect(wallet.saved[0]?.object).toMatchObject({ id: `${GOOGLE.issuerId}.card-${pass.cardId}-1`, state: "INACTIVE" });
      expect(wallet.saved[0]?.object).not.toHaveProperty("barcode");
    } finally {
      await task.stop();
    }
  });

  it("counts a failed Google write on the pass, with its code, and logs it (AC 13)", async () => {
    const pass = await googlePass();
    const { boss, task, wallet, lines } = jobQueue();
    wallet.answer = new DeliveryError("Google Wallet answered 503 to PUT loyaltyObject.", "google_503_UNAVAILABLE");
    await task.start();
    try {
      for (const attempt of [1, 2]) {
        const id = (await boss.send(GOOGLE_PASS_UPDATE_QUEUE, { cafeId: pass.cafeId, passId: pass.passId }, { retryLimit: 0 })) ?? "";
        await finished(boss, GOOGLE_PASS_UPDATE_QUEUE, id, "failed");
        expect(lines).toContainEqual(expect.objectContaining({ level: 50, msg: "job failed", job: GOOGLE_PASS_UPDATE_QUEUE, jobId: id, cafeId: pass.cafeId }));
        expect(await deliveryState("google_passes", pass.passId)).toEqual({ delivery_failures: attempt, delivery_error: "google_503_UNAVAILABLE", failed: true, delivered: true });
      }
      // The QR token never reaches the logs.
      const qr = wallet.saved[0]?.object.state === "ACTIVE" ? wallet.saved[0].object.barcode.value : "missing";
      expect(JSON.stringify(lines)).not.toContain(qr);
    } finally {
      await task.stop();
    }
  });

  it("reads only the job's café: a job naming another café's pass pushes nothing and removes nothing (AC 2)", async () => {
    const mine = await passWithDevices(1);
    const theirs = await passWithDevices(1);
    const { boss, task, pusher } = jobQueue();
    pusher.answers.set(theirs.tokens[0] ?? "", "unregistered");
    await task.start();
    try {
      const id = (await boss.send(APPLE_PASS_UPDATE_QUEUE, { cafeId: mine.cafeId, passId: theirs.passId })) ?? "";
      expect(await finished(boss, APPLE_PASS_UPDATE_QUEUE, id, "completed")).toMatchObject({ output: { sent: 0, removed: 0 } });
      expect(pusher.pushed).toEqual([]);
      expect(await registrationTokens(theirs.cafeId)).toEqual(theirs.tokens);
    } finally {
      await task.stop();
    }
  });

  it("reads only the job's café: a job naming another café's Google pass writes nothing and records nothing (AC 2)", async () => {
    const mine = await googlePass();
    const theirs = await googlePass();
    // Failing and undelivered, so a write to it under the wrong café (a reset, a delivered change) would show.
    await admin.query("UPDATE app.google_passes SET delivery_failures = 4, delivery_error = 'timeout', delivery_failed_at = now() WHERE id = $1", [theirs.passId]);
    await undeliver("google_passes", theirs.passId);
    const { boss, task, wallet } = jobQueue();
    await task.start();
    try {
      const id = (await boss.send(GOOGLE_PASS_UPDATE_QUEUE, { cafeId: mine.cafeId, passId: theirs.passId })) ?? "";
      expect(await finished(boss, GOOGLE_PASS_UPDATE_QUEUE, id, "completed")).toMatchObject({ output: { result: "gone" } });
      expect(wallet.saved).toEqual([]);
      expect(await deliveryState("google_passes", theirs.passId)).toEqual({ delivery_failures: 4, delivery_error: "timeout", failed: true, delivered: false });
      // Delivered again, so the sweep in the next test does not take it.
      await admin.query("UPDATE app.google_passes SET delivered_xid = updated_xid WHERE id = $1", [theirs.passId]);
    } finally {
      await task.stop();
    }
  });

  it("queues again, once, every pass whose latest change was never delivered, until it is (AC 13)", async () => {
    const apple = await passWithDevices(1);
    const google = await googlePass();
    const settled = await passWithDevices(1);
    await undeliver("apple_passes", apple.passId);
    await undeliver("google_passes", google.passId);
    const { boss, task, pusher, wallet } = jobQueue();
    await task.start();
    try {
      // What the schedule sends every 15 minutes.
      const id = (await boss.send(RESEND_QUEUE)) ?? "";
      expect(await finished(boss, RESEND_QUEUE, id, "completed")).toMatchObject({ output: { found: 2, queued: 2 } });
      await vi.waitFor(
        async () => {
          expect(await deliveryState("apple_passes", apple.passId)).toMatchObject({ delivered: true });
          expect(await deliveryState("google_passes", google.passId)).toMatchObject({ delivered: true });
        },
        { timeout: 20_000, interval: 250 },
      );
      expect(pusher.pushed).toEqual(apple.tokens);
      expect(pusher.pushed).not.toContain(settled.tokens[0]);
      expect(wallet.saved.map((save) => save.object.id)).toEqual([`${GOOGLE.issuerId}.card-${google.cardId}-1`]);
      // Delivered now: the next sweep finds nothing.
      const again = (await boss.send(RESEND_QUEUE)) ?? "";
      expect(await finished(boss, RESEND_QUEUE, again, "completed")).toMatchObject({ output: { found: 0, queued: 0 } });
    } finally {
      await task.stop();
    }
  });

  it("announces each open campaign once to each opted-in card, at most once a day, and notifies once per announcement (AC 14)", async () => {
    const { cafeId, minute, weekday } = await cafeAtDaytime();
    // Not open now (closed already, too little left, starting later today, on the other days of the week), and made
    // first, so the daily cap would not hide them if they were listed.
    await campaign(cafeId, "Night", 1, 60);
    await campaign(cafeId, "Ending", 0, minute + 10);
    await campaign(cafeId, "Later", minute + 60, 1440);
    await campaign(
      cafeId,
      "Other days",
      0,
      1440,
      EVERY_DAY.filter((day) => day !== weekday),
    );
    const first = await campaign(cafeId, "Afternoon", 0, 1440);
    const second = await campaign(cafeId, "Evening", 0, 1440);
    // A card on Google Wallet only, one whose Apple pass is on a phone (and that has a Google pass too), one without a pass.
    const onGoogle = await offerCard(cafeId, { passes: true, onDevice: false });
    const onApple = await offerCard(cafeId, { passes: true });
    const withoutPasses = await offerCard(cafeId);
    const optedOut = await offerCard(cafeId, { optedIn: false });
    // Another café's opted-in card, with no campaign of its own.
    const elsewhere = await cafeAtDaytime();
    await offerCard(elsewhere.cafeId);
    const { boss, task, pusher, wallet } = jobQueue();
    const announce = async () => {
      const id = (await boss.send(ANNOUNCE_QUEUE)) ?? "";
      await finished(boss, ANNOUNCE_QUEUE, id, "completed");
    };
    const writes = (card: { cardId: string }) => wallet.saved.filter((save) => save.object.id.includes(card.cardId));
    const cards = [onGoogle, onApple, withoutPasses];
    await task.start();
    try {
      await announce();
      // The older campaign first; the daily cap holds the other back.
      expect(await announcements(cafeId)).toEqual(cards.map((card) => `${card.cardId} ${first}`).sort());
      expect(await announcements(elsewhere.cafeId)).toEqual([]);
      expect((await announcements(cafeId)).join()).not.toContain(optedOut.cardId);
      await vi.waitFor(
        async () => {
          for (const card of [onGoogle, onApple]) {
            expect(await deliveryState("apple_passes", card.applePassId)).toMatchObject({ delivered: true });
            expect(await deliveryState("google_passes", card.googlePassId)).toMatchObject({ delivered: true });
          }
        },
        { timeout: 20_000, interval: 250 },
      );
      expect(pusher.pushed).toEqual([onApple.token]);
      expect(writes(onGoogle)).toHaveLength(1);
      expect(writes(onGoogle)[0]?.object.textModulesData[0]).toMatchObject({ id: "offer", header: "Afternoon · 20% off" });
      expect(writes(onGoogle)[0]?.message).toMatchObject({ id: `offer-${first}`, messageType: "TEXT_AND_NOTIFY" });
      // Wallet tells the Apple pass itself (its changeMessage): the card's Google pass shows the offer silently.
      expect(writes(onApple)[0]?.object.textModulesData[0]).toMatchObject({ id: "offer" });
      expect(writes(onApple)[0]?.message).toBeUndefined();

      // Run again the same day: nothing new. A later write of the pass (a stamp) shows the offer silently.
      await announce();
      expect(await announcements(cafeId)).toHaveLength(3);
      const stamp = (await boss.send(GOOGLE_PASS_UPDATE_QUEUE, { cafeId, passId: onGoogle.googlePassId })) ?? "";
      await finished(boss, GOOGLE_PASS_UPDATE_QUEUE, stamp, "completed");
      expect(writes(onGoogle)[1]?.object.textModulesData[0]).toMatchObject({ id: "offer" });
      expect(writes(onGoogle)[1]?.message).toBeUndefined();

      // The next day the other campaign is announced, and notifies; the first is never announced again.
      await admin.query("UPDATE app.campaign_announcements SET announced_at = announced_at - interval '2 days' WHERE cafe_id = $1", [cafeId]);
      await announce();
      expect(await announcements(cafeId)).toEqual(cards.flatMap((card) => [`${card.cardId} ${first}`, `${card.cardId} ${second}`]).sort());
      await vi.waitFor(
        () => {
          expect(writes(onGoogle)).toHaveLength(3);
        },
        { timeout: 20_000, interval: 250 },
      );
      expect(writes(onGoogle)[2]?.message).toMatchObject({ id: `offer-${second}` });

      // Ending the campaign marks the passes showing it changed; their next write shows no offer, silently.
      await admin.query("UPDATE app.campaigns SET ended_at = now() WHERE id = $1", [second]);
      expect(await deliveryState("google_passes", onGoogle.googlePassId)).toMatchObject({ delivered: false });
      expect(await deliveryState("apple_passes", onApple.applePassId)).toMatchObject({ delivered: false });
      const ended = (await boss.send(GOOGLE_PASS_UPDATE_QUEUE, { cafeId, passId: onGoogle.googlePassId })) ?? "";
      await finished(boss, GOOGLE_PASS_UPDATE_QUEUE, ended, "completed");
      expect(writes(onGoogle)[3]?.object.textModulesData.map((module) => module.id)).toEqual(["about"]);
      expect(writes(onGoogle)[3]?.message).toBeUndefined();
    } finally {
      await task.stop();
    }
  });

  it("shows an offer silently on a Google pass saved after it was announced, so the card is not told twice that day (AC 14)", async () => {
    const { cafeId } = await cafeAtDaytime();
    const running = await campaign(cafeId, "Afternoon", 0, 1440);
    const card = await offerCard(cafeId, { passes: true, onDevice: false });
    // Announced before the pass existed, as when the card is saved again on a new phone the same day.
    await admin.query("INSERT INTO app.campaign_announcements (cafe_id, campaign_id, card_id, announced_at) VALUES ($1, $2, $3, now())", [cafeId, running, card.cardId]);
    await admin.query("UPDATE app.google_passes SET created_at = now() + interval '1 second' WHERE id = $1", [card.googlePassId]);
    const { boss, task, wallet } = jobQueue();
    await task.start();
    try {
      const id = (await boss.send(GOOGLE_PASS_UPDATE_QUEUE, { cafeId, passId: card.googlePassId })) ?? "";
      await finished(boss, GOOGLE_PASS_UPDATE_QUEUE, id, "completed");
      expect(wallet.saved[0]?.object.textModulesData[0]).toMatchObject({ id: "offer" });
      expect(wallet.saved[0]?.message).toBeUndefined();
    } finally {
      await task.stop();
    }
  });

  it("counts the day in the café's time zone, not UTC's, for the daily cap and for notifying (AC 14)", async () => {
    const { cafeId } = await cafeAtDaytime();
    const earlier = await campaign(cafeId, "Morning", 0, 1440);
    const later = await campaign(cafeId, "Afternoon", 0, 1440);
    const beforeMidnight = await offerCard(cafeId);
    const afterMidnight = await offerCard(cafeId);
    await admin.query("UPDATE app.cards SET offers_opt_in_at = now() - interval '2 days' WHERE cafe_id = $1", [cafeId]);
    // Announced a minute either side of the café's last midnight, which is 6 hours off UTC's.
    for (const [card, offset] of [
      [beforeMidnight, "-1 minute"],
      [afterMidnight, "1 minute"],
    ] as const) {
      await admin.query(
        `INSERT INTO app.campaign_announcements (cafe_id, campaign_id, card_id, announced_at)
         SELECT $1, $2, $3, (date_trunc('day', now() AT TIME ZONE time_zone) AT TIME ZONE time_zone) + $4::interval FROM app.cafes WHERE id = $1`,
        [cafeId, earlier, card.cardId, offset],
      );
    }
    const offerOf = (card: { cardId: string }) => withCafe(db.app.db, cafeId, (trx) => loadCardOffer(trx, card.cardId));
    expect((await offerOf(beforeMidnight)).offer?.mayNotify).toBe(false);
    expect((await offerOf(afterMidnight)).offer?.mayNotify).toBe(true);
    const { boss, task } = jobQueue();
    await task.start();
    try {
      await announceCampaigns(boss, db.app.db, pino({ level: "silent" }));
      // Yesterday's card is told of the other campaign; today's is not.
      expect(await announcements(cafeId)).toEqual(
        [`${beforeMidnight.cardId} ${earlier}`, `${beforeMidnight.cardId} ${later}`, `${afterMidnight.cardId} ${earlier}`].sort(),
      );
    } finally {
      await task.stop();
    }
  });

  it("serializes announcers on the café's row without holding up stamping's inserts (AC 13, 14)", async () => {
    const { cafeId } = await cafeAtDaytime();
    await campaign(cafeId, "Morning", 0, 1440);
    await campaign(cafeId, "Afternoon", 0, 1440);
    await offerCard(cafeId);
    // The first announcer to insert stays in its transaction, holding the café's row, for a second and a half.
    await admin.query("CREATE FUNCTION app.test_slow_announcement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.5); RETURN NEW; END $$");
    await admin.query(
      `CREATE TRIGGER test_slow_announcement BEFORE INSERT ON app.campaign_announcements FOR EACH ROW WHEN (NEW.cafe_id = '${cafeId}') EXECUTE FUNCTION app.test_slow_announcement()`,
    );
    const { boss, task } = jobQueue();
    await task.start();
    try {
      const silent = pino({ level: "silent" });
      const runs = Promise.all([announceCampaigns(boss, db.app.db, silent), announceCampaigns(boss, db.app.db, silent)]);
      // One announcer inserting, the other waiting for the café's row.
      await vi.waitFor(
        async () => {
          const { rows } = await admin.query<{ sleeping: number; waiting: number }>(
            `SELECT count(*) FILTER (WHERE wait_event = 'PgSleep')::int AS sleeping,
                    count(*) FILTER (WHERE wait_event_type = 'Lock' AND query ILIKE '%from "cafes"%')::int AS waiting
               FROM pg_stat_activity`,
          );
          expect(rows[0]).toEqual({ sleeping: 1, waiting: 1 });
        },
        { timeout: 10_000, interval: 50 },
      );
      // A stamp's audit row goes in meanwhile: its foreign key's lock does not wait on the announcer's.
      await withCafe(db.app.db, cafeId, async (trx) => {
        await sql`SET LOCAL lock_timeout = '500ms'`.execute(trx);
        await trx.insertInto("audit_log").values({ cafe_id: cafeId, actor_type: "system", actor_id: null, action: "card.stamps_set", entity_type: "card", entity_id: null }).execute();
      });
      await runs;
      // One after the other: the second sees the first's announcement, and the daily cap holds.
      expect(await announcements(cafeId)).toHaveLength(1);
    } finally {
      await task.stop();
      await admin.query("DROP TRIGGER test_slow_announcement ON app.campaign_announcements");
      await admin.query("DROP FUNCTION app.test_slow_announcement()");
    }
  });

  it("announces the other cafés when one café's announcement fails, then fails the run for a retry (AC 13)", async () => {
    const broken = await cafeAtDaytime();
    await campaign(broken.cafeId, "Morning", 0, 1440);
    await offerCard(broken.cafeId);
    // Made later, so listed after the broken café's.
    const working = await cafeAtDaytime();
    const running = await campaign(working.cafeId, "Afternoon", 0, 1440);
    const card = await offerCard(working.cafeId);
    await admin.query("CREATE FUNCTION app.test_refuse_announcement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused for the test'; END $$");
    await admin.query(
      `CREATE TRIGGER test_refuse_announcement BEFORE INSERT ON app.campaign_announcements FOR EACH ROW WHEN (NEW.cafe_id = '${broken.cafeId}') EXECUTE FUNCTION app.test_refuse_announcement()`,
    );
    const lines: Record<string, unknown>[] = [];
    const logger = pino({ level: "info" }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
    const { boss, task } = jobQueue();
    await task.start();
    try {
      await expect(announceCampaigns(boss, db.app.db, logger)).rejects.toBeInstanceOf(AggregateError);
      expect(await announcements(working.cafeId)).toEqual([`${card.cardId} ${running}`]);
      expect(await announcements(broken.cafeId)).toEqual([]);
      expect(lines).toContainEqual(expect.objectContaining({ msg: "campaign announcement failed", cafeId: broken.cafeId }));
      expect(lines.filter((line) => line.msg === "campaign announced" && line.cafeId === broken.cafeId)).toEqual([]);
    } finally {
      await task.stop();
      await admin.query("DROP TRIGGER test_refuse_announcement ON app.campaign_announcements");
      await admin.query("DROP FUNCTION app.test_refuse_announcement()");
    }
  });

  it("logs an offer notification lost to a failed write, and the retry shows the offer silently (AC 14, 42)", async () => {
    const { cafeId } = await cafeAtDaytime();
    const running = await campaign(cafeId, "Afternoon", 0, 1440);
    const card = await offerCard(cafeId, { passes: true, onDevice: false });
    await admin.query("UPDATE app.cards SET offers_opt_in_at = now() - interval '1 hour' WHERE id = $1", [card.cardId]);
    await admin.query("UPDATE app.google_passes SET created_at = now() - interval '1 hour' WHERE id = $1", [card.googlePassId]);
    await admin.query("INSERT INTO app.campaign_announcements (cafe_id, campaign_id, card_id) VALUES ($1, $2, $3)", [cafeId, running, card.cardId]);
    const wallet = new FakeGoogleWallet();
    wallet.answer = new DeliveryError("Google Wallet answered 503 to PUT loyaltyObject.", "google_503");
    const lines: Record<string, unknown>[] = [];
    const logger = pino({ level: "info" }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
    const job = { cafeId, passId: card.googlePassId };
    await expect(writeGooglePass(db.app.db, wallet, GOOGLE, logger, job)).rejects.toBeInstanceOf(DeliveryError);
    expect(wallet.saved[0]?.message).toMatchObject({ id: `offer-${running}` });
    expect(lines).toContainEqual(expect.objectContaining({ level: 40, msg: "google offer notification may not have been sent: the write failed", offer: `offer-${running}` }));
    // The retry: recorded as told already, so it writes the offer without the message.
    wallet.answer = "updated";
    expect(await writeGooglePass(db.app.db, wallet, GOOGLE, logger, job)).toEqual({ result: "updated" });
    expect(wallet.saved[1]?.object.textModulesData[0]).toMatchObject({ id: "offer" });
    expect(wallet.saved[1]?.message).toBeUndefined();
  });

  it("records each lapsed card once and gives the opted-in ones the win-back offer, under the cool-down and the daily cap (AC 14, 36)", async () => {
    const cafeId = await cafeAtHour(15);
    // Lapsed: 3 visits 10 days apart, the last 40 days ago (more than twice the median gap, and 14 days).
    const regular = await offerCard(cafeId, { passes: true, onDevice: false });
    const notOptedIn = await offerCard(cafeId, { optedIn: false });
    const toldToday = await offerCard(cafeId);
    const cooledDown = await offerCard(cafeId);
    // Not lapsed: two visits only; the last within twice the median gap; a slow regular within its own rhythm.
    const twoVisits = await offerCard(cafeId);
    const recent = await offerCard(cafeId);
    const slow = await offerCard(cafeId);
    const daily = await offerCard(cafeId);
    for (const card of [regular, notOptedIn, toldToday, cooledDown]) {
      await visited(cafeId, card.cardId, [60, 50, 40]);
    }
    await visited(cafeId, twoVisits.cardId, [90, 80]);
    // Gaps of 10 and 8 days: lapsed only after 18 days, and it has been 12.
    await visited(cafeId, recent.cardId, [30, 20, 12]);
    await visited(cafeId, slow.cardId, [120, 60, 30]);
    // A day apart, the last 10 days ago: twice the gap has passed, but not the 14 days.
    await visited(cafeId, daily.cardId, [12, 11, 10]);
    // Told of a campaign today; given an offer 10 days ago, at an earlier lapse.
    const campaignId = await campaign(cafeId, "Morning", 0, 1440);
    await admin.query("INSERT INTO app.campaign_announcements (cafe_id, campaign_id, card_id) VALUES ($1, $2, $3)", [cafeId, campaignId, toldToday.cardId]);
    await admin.query(
      `INSERT INTO app.card_lapses (cafe_id, card_id, last_visit_at, offered_at, discount_kind, discount_value, min_margin_percent, expires_at, closed_at)
       VALUES ($1, $2, now() - interval '70 days', now() - interval '10 days', 'percent', 20, 30, now() + interval '4 days', now() - interval '5 days')`,
      [cafeId, cooledDown.cardId],
    );
    // A café whose clock reads 03:00: its lapsed regular waits for its delivery hours.
    const asleep = await cafeAtHour(3);
    const sleeper = await offerCard(asleep);
    await visited(asleep, sleeper.cardId, [60, 50, 40]);
    const { boss, task, wallet } = jobQueue();
    const run = async () => {
      const id = (await boss.send(WIN_BACK_QUEUE)) ?? "";
      return (await finished(boss, WIN_BACK_QUEUE, id, "completed"))?.output;
    };
    await task.start();
    try {
      await run();
      // Each lapse is recorded; the card told of a campaign today gets its offer on a later run.
      expect(await lapses(cafeId)).toEqual(
        [`${regular.cardId} offered`, `${notOptedIn.cardId} none`, `${toldToday.cardId} none`, `${cooledDown.cardId} none`, `${cooledDown.cardId} offered`].sort(),
      );
      expect(await lapses(asleep)).toEqual([]);
      // The regular's Google pass shows the offer and is told of it once.
      await vi.waitFor(
        async () => {
          expect(await deliveryState("google_passes", regular.googlePassId)).toMatchObject({ delivered: true });
        },
        { timeout: 20_000, interval: 250 },
      );
      const [write] = wallet.saved.filter((save) => save.object.id.includes(regular.cardId));
      expect(write?.object.textModulesData[0]).toMatchObject({ id: "offer", header: "Welcome back · 20% off" });
      expect(write?.message).toMatchObject({ id: expect.stringMatching(/^winback-/) as unknown, messageType: "TEXT_AND_NOTIFY" });

      // Once per lapse: a second run records nothing new, and the campaign announcer leaves the regular alone today.
      await run();
      expect(await lapses(cafeId)).toHaveLength(5);
      await announceCampaigns(boss, db.app.db, pino({ level: "silent" }));
      expect((await announcements(cafeId)).join()).not.toContain(regular.cardId);
      // On a later day too, while the offer is open: a campaign announced over it would hide it.
      // Moved back as time would (the database keeps a given offer's terms, so its trigger is skipped for this).
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query("UPDATE app.card_lapses SET offered_at = offered_at - interval '2 days' WHERE card_id = $1", [regular.cardId]);
      } finally {
        await admin.query("SET session_replication_role = DEFAULT");
      }
      await announceCampaigns(boss, db.app.db, pino({ level: "silent" }));
      expect((await announcements(cafeId)).join()).not.toContain(regular.cardId);
      // The next day the card told of a campaign is given the offer.
      await admin.query("UPDATE app.campaign_announcements SET announced_at = announced_at - interval '2 days' WHERE cafe_id = $1", [cafeId]);
      await run();
      expect(await lapses(cafeId)).toContain(`${toldToday.cardId} offered`);
      expect(await lapses(cafeId)).toHaveLength(5);
    } finally {
      await task.stop();
    }
  });

  it("counts visit days, leaves held and discarded visits out, and takes the median of the gaps (AC 36)", async () => {
    const cafeId = await cafeAtHour(15);
    const card = () => offerCard(cafeId);
    // Three visits on one day are one visit day; with a third day they make a regular.
    const oneDay = await card();
    await visited(cafeId, oneDay.cardId, [40, 40, 40]);
    const threeDays = await card();
    await visited(cafeId, threeDays.cardId, [60, 60, 50, 40]);
    // A held visit is not a visit: two member days only. A discarded one does not count as coming back.
    const heldThird = await card();
    await visited(cafeId, heldThird.cardId, [60, 50]);
    await visited(cafeId, heldThird.cardId, [45], "held");
    const discardedReturn = await card();
    await visited(cafeId, discardedReturn.cardId, [60, 50, 40]);
    await visited(cafeId, discardedReturn.cardId, [5], "discarded");
    // Nor does a held one, and a discarded visit is no visit day either.
    const heldReturn = await card();
    await visited(cafeId, heldReturn.cardId, [60, 50, 40]);
    await visited(cafeId, heldReturn.cardId, [5], "held");
    const discardedThird = await card();
    await visited(cafeId, discardedThird.cardId, [60, 50]);
    await visited(cafeId, discardedThird.cardId, [45], "discarded");
    // Gaps of 10, 10 and 55 days: the median (10) says lapsed after 20 days; the mean (25) would wait 50.
    const medianNotMean = await card();
    await visited(cafeId, medianNotMean.cardId, [100, 90, 80, 25]);
    // Gaps of 5, 10, 15 and 20: the median is 12.5, so 25 days; the lower middle value (10) would say 20.
    const interpolated = await card();
    await visited(cafeId, interpolated.cardId, [73, 68, 58, 43, 23]);
    const { boss, task } = jobQueue();
    await task.start();
    try {
      await runWinBack(boss, db.app.db, pino({ level: "silent" }));
      expect((await lapses(cafeId)).map((entry) => entry.split(" ")[0])).toEqual([threeDays.cardId, discardedReturn.cardId, heldReturn.cardId, medianNotMean.cardId].sort());
    } finally {
      await task.stop();
    }
  });

  it("gives a recorded lapse the offer once the card becomes eligible, under the café's own cool-down, while it stays lapsed (AC 36)", async () => {
    const cafeId = await cafeAtHour(15, null);
    await admin.query("UPDATE app.cafes SET win_back_cooldown_days = 45 WHERE id = $1", [cafeId]);
    const early = await offerCard(cafeId);
    const optsInLater = await offerCard(cafeId, { optedIn: false });
    const offeredBefore = await offerCard(cafeId);
    const cameBack = await offerCard(cafeId);
    for (const card of [early, optsInLater, offeredBefore, cameBack]) {
      await visited(cafeId, card.cardId, [60, 50, 40]);
    }
    // Given an offer 35 days ago, at an earlier lapse: inside a 45-day cool-down, outside a 30-day one.
    await admin.query(
      `INSERT INTO app.card_lapses (cafe_id, card_id, last_visit_at, offered_at, discount_kind, discount_value, min_margin_percent, expires_at, closed_at)
       VALUES ($1, $2, now() - interval '80 days', now() - interval '35 days', 'percent', 20, 30, now() - interval '21 days', now() - interval '21 days')`,
      [cafeId, offeredBefore.cardId],
    );
    const { boss, task } = jobQueue();
    const silent = pino({ level: "silent" });
    await task.start();
    try {
      // The café has no offer yet: the lapses are recorded without one.
      await runWinBack(boss, db.app.db, silent);
      expect(await lapses(cafeId)).toEqual(
        [`${early.cardId} none`, `${optsInLater.cardId} none`, `${offeredBefore.cardId} none`, `${offeredBefore.cardId} offered`, `${cameBack.cardId} none`].sort(),
      );
      // The owner sets one; one card comes back meanwhile and needs no winning back.
      await admin.query("UPDATE app.cafes SET win_back_discount_kind = 'percent', win_back_discount_value = 15 WHERE id = $1", [cafeId]);
      await visited(cafeId, cameBack.cardId, [0]);
      await runWinBack(boss, db.app.db, silent);
      expect(await lapses(cafeId)).toEqual(
        [`${early.cardId} offered`, `${optsInLater.cardId} none`, `${offeredBefore.cardId} none`, `${offeredBefore.cardId} offered`, `${cameBack.cardId} none`].sort(),
      );
      // The card opts in, and the café shortens its cool-down to 30 days.
      await admin.query("UPDATE app.cards SET offers_opt_in_at = now() WHERE id = $1", [optsInLater.cardId]);
      await admin.query("UPDATE app.cafes SET win_back_cooldown_days = 30 WHERE id = $1", [cafeId]);
      await runWinBack(boss, db.app.db, silent);
      expect(await lapses(cafeId)).toEqual(
        [`${early.cardId} offered`, `${optsInLater.cardId} offered`, `${offeredBefore.cardId} offered`, `${offeredBefore.cardId} offered`, `${cameBack.cardId} none`].sort(),
      );
    } finally {
      await task.stop();
    }
  });

  it("counts a win-back offer given today against the campaign announcer's daily cap, even once it is closed (AC 14)", async () => {
    const { cafeId } = await cafeAtDaytime();
    await campaign(cafeId, "Morning", 0, 1440);
    const toldToday = await offerCard(cafeId);
    const other = await offerCard(cafeId);
    // Given this morning and already used up.
    await admin.query(
      `INSERT INTO app.card_lapses (cafe_id, card_id, last_visit_at, offered_at, discount_kind, discount_value, min_margin_percent, expires_at, closed_at)
       VALUES ($1, $2, now() - interval '40 days', now() - interval '1 minute', 'percent', 20, 30, now() + interval '14 days', now())`,
      [cafeId, toldToday.cardId],
    );
    const { boss, task } = jobQueue();
    await task.start();
    try {
      await announceCampaigns(boss, db.app.db, pino({ level: "silent" }));
      const told = await announcements(cafeId);
      expect(told.join()).toContain(other.cardId);
      expect(told.join()).not.toContain(toldToday.cardId);
    } finally {
      await task.stop();
    }
  });

  it("closes expired win-back offers at any hour, which leave the cards' passes (AC 36)", async () => {
    // 03:00 at the café: outside the delivery hours, but an expired offer still leaves the passes.
    const cafeId = await cafeAtHour(3);
    const card = await offerCard(cafeId, { passes: true, onDevice: false });
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO app.card_lapses (cafe_id, card_id, last_visit_at, offered_at, discount_kind, discount_value, min_margin_percent, expires_at)
       VALUES ($1, $2, now() - interval '60 days', now() - interval '15 days', 'percent', 20, 30, now() - interval '1 day') RETURNING id`,
      [cafeId, card.cardId],
    );
    const { boss, task } = jobQueue();
    await task.start();
    try {
      await runWinBack(boss, db.app.db, pino({ level: "silent" }));
      const closed = await admin.query<{ closed: boolean }>("SELECT closed_at IS NOT NULL AS closed FROM app.card_lapses WHERE id = $1", [rows[0]?.id]);
      expect(closed.rows).toEqual([{ closed: true }]);
      await vi.waitFor(
        async () => {
          expect(await deliveryState("google_passes", card.googlePassId)).toMatchObject({ delivered: true });
        },
        { timeout: 20_000, interval: 250 },
      );
      expect((await withCafe(db.app.db, cafeId, (trx) => loadCardOffer(trx, card.cardId))).offer).toBeUndefined();
    } finally {
      await task.stop();
    }
  });

  it("marks a card's current passes changed when it opts in or out of offers, and not on other card changes", async () => {
    const { cafeId } = await cafeAtDaytime();
    const card = await offerCard(cafeId, { optedIn: false, passes: true });
    await admin.query("UPDATE app.cards SET email = NULL WHERE id = $1", [card.cardId]);
    expect(await deliveryState("google_passes", card.googlePassId)).toMatchObject({ delivered: true });
    await admin.query("UPDATE app.cards SET offers_opt_in_at = now() WHERE id = $1", [card.cardId]);
    expect(await deliveryState("google_passes", card.googlePassId)).toMatchObject({ delivered: false });
    expect(await deliveryState("apple_passes", card.applePassId)).toMatchObject({ delivered: false });
  });

  it("leaves the app role nothing in pgboss that the owner role later runs", async () => {
    expect(await codeOf(sql`CREATE TABLE pgboss.intruder (id int)`.execute(db.app.db))).toBe("42501");
    // pg-boss's upgrade plans put queue table names unquoted into DDL: only pg-boss's own names are accepted.
    for (const planted of ["x; DROP SCHEMA app; --", `j${"a".repeat(56)}; DROP SCHEMA app; --`]) {
      expect(await codeOf(sql`UPDATE pgboss.queue SET table_name = ${planted} WHERE name = ${PURGE_QUEUE}`.execute(db.app.db))).toBe("23514");
    }
    expect(
      await codeOf(sql`INSERT INTO pgboss.bam (name, version, status, table_name, command) VALUES ('planted', 1, 'pending', 'job_common', 'SELECT 1')`.execute(db.app.db)),
    ).toBe("42501");
  });
});

describe("feedback requests", () => {
  const HOUR = 1 / 24;
  const requests = async (cafeId: string): Promise<{ id: string; card_id: string; visit_id: string }[]> =>
    (await admin.query<{ id: string; card_id: string; visit_id: string }>("SELECT id, card_id, visit_id FROM app.feedback_requests WHERE cafe_id = $1", [cafeId])).rows;
  const latestVisit = async (cardId: string): Promise<string | undefined> =>
    (await admin.query<{ id: string }>("SELECT id FROM app.visits WHERE card_id = $1 ORDER BY occurred_at DESC LIMIT 1", [cardId])).rows[0]?.id;

  it("asks about each card's latest visit 2 hours on, at most once a day, and puts the link on its passes silently (AC 37)", async () => {
    const cafeId = await cafeAtHour(15);
    const recent = await offerCard(cafeId, { passes: true });
    const twice = await offerCard(cafeId);
    const tooSoon = await offerCard(cafeId);
    const tooOld = await offerCard(cafeId);
    const held = await offerCard(cafeId);
    const askedToday = await offerCard(cafeId);
    await visited(cafeId, recent.cardId, [3 * HOUR]);
    // Two visits: the latest is asked about.
    await visited(cafeId, twice.cardId, [5 * HOUR, 3 * HOUR]);
    await visited(cafeId, tooSoon.cardId, [1 * HOUR]);
    await visited(cafeId, tooOld.cardId, [30 * HOUR]);
    await visited(cafeId, held.cardId, [3 * HOUR], "held");
    await visited(cafeId, held.cardId, [4 * HOUR], "discarded");
    // Asked 10 hours ago about an earlier visit: not again today.
    await visited(cafeId, askedToday.cardId, [12 * HOUR]);
    await admin.query("INSERT INTO app.feedback_requests (cafe_id, card_id, visit_id, created_at) VALUES ($1, $2, $3, now() - interval '10 hours')", [
      cafeId,
      askedToday.cardId,
      await latestVisit(askedToday.cardId),
    ]);
    await visited(cafeId, askedToday.cardId, [3 * HOUR]);
    const { boss, task, wallet, pusher } = jobQueue();
    const run = async () => {
      const id = (await boss.send(FEEDBACK_QUEUE)) ?? "";
      return (await finished(boss, FEEDBACK_QUEUE, id, "completed"))?.output;
    };
    await task.start();
    try {
      await run();
      const asked = await requests(cafeId);
      expect(asked.map((request) => request.card_id).sort()).toEqual([recent.cardId, twice.cardId, askedToday.cardId].sort());
      expect(asked.find((request) => request.card_id === twice.cardId)?.visit_id).toBe(await latestVisit(twice.cardId));
      // The passes show the link: Google's object links to the request's page; the Apple device is told to fetch it.
      await vi.waitFor(
        async () => {
          expect(await deliveryState("google_passes", recent.googlePassId)).toMatchObject({ delivered: true });
          expect(await deliveryState("apple_passes", recent.applePassId)).toMatchObject({ delivered: true });
        },
        { timeout: 20_000, interval: 250 },
      );
      expect(pusher.pushed).toContain(recent.token);
      const write = wallet.saved.find((save) => save.object.id.includes(recent.cardId));
      const uri = write?.object.state === "ACTIVE" ? write.object.linksModuleData?.uris[0]?.uri : undefined;
      expect(uri).toMatch(/^https:\/\/card\.example\.test\/f\//);
      const request = asked.find((entry) => entry.card_id === recent.cardId);
      expect(verifyFeedbackToken(GOOGLE, (uri ?? "").split("/f/")[1] ?? "")).toEqual({ cafeId, requestId: request?.id });
      // Silently (AC 14 keeps notifications for offers).
      expect(write?.message).toBeUndefined();

      // Once: a second run asks nothing more.
      await run();
      expect(await requests(cafeId)).toHaveLength(3);
    } finally {
      await task.stop();
    }
  });
});
