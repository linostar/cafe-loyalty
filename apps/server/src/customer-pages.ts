import { createHmac } from "node:crypto";
import { setLookup, useCafe, withCafe, withLookup, type Database } from "@cafe-loyalty/db";
import { joinCodeSchema, linkTokenSchema, normalizePhoneInput, ownerEmailSchema } from "@cafe-loyalty/shared";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sql, type Kysely, type Transaction } from "kysely";
import { renderSVG } from "uqr";
import type { BackgroundTasks } from "./background.js";
import { hashToken, newToken } from "./credentials.js";
import { emailLookup, encryptPhone, phoneLookup, signCardQr, type CustomerSecrets } from "./customer-crypto.js";
import { CUSTOMER_CSP, count, html, page, pickLang, t, type Lang, type MessageKey, type SafeHtml } from "./customer-html.js";
import { audit, now, secondsFromNow } from "./db-helpers.js";
import type { EmailMessage, Mailer } from "./mailer.js";
import { RateLimiter, clientKey } from "./rate-limit.js";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
/** A recovery link works for this long (AC 8). */
export const RECOVERY_TOKEN_TTL_SECONDS = 30 * MINUTE;
/**
 * Every signup takes at least this long, so the reply's timing cannot tell whether the number already had a card
 * (AC 5): the work differs by a row or two, far less than this.
 */
export const MIN_SIGNUP_MS = 400;
/** Card deletion likewise takes at least this long, so linked and unlinked cards cannot be told apart by it. */
export const MIN_DELETE_MS = 300;

async function atLeast(started: number, ms: number): Promise<void> {
  const remaining = ms - (Date.now() - started);
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

/** A 256-bit secret in base64url, as card, recovery and form tokens are. */
const isToken = (value: string): boolean => linkTokenSchema.safeParse(value).success;
/** SQLSTATE of an ON DELETE RESTRICT foreign key refusing a delete. */
const RESTRICT_VIOLATION = "23001";

export interface CustomerPagesOptions {
  db: Kysely<Database>;
  mailer: Mailer;
  background: BackgroundTasks;
  /** This server's public address: recovery links point at it. */
  publicUrl: string;
  secrets: CustomerSecrets;
  /** Overrides for tests: signups per café per hour (default 1,000). */
  limits?: { signupPerCafe?: number };
}

/** A customer-facing failure, shown as a page in the visitor's language. */
class PageError extends Error {
  constructor(
    readonly status: number,
    readonly key: MessageKey,
    readonly values: Readonly<Record<string, string | number>> = {},
  ) {
    super(key);
    this.name = "PageError";
  }
}

type Form = Readonly<Record<string, string | undefined>>;

/** The submitted fields that are text; anything else (a JSON number or object) counts as missing. */
const formOf = (request: FastifyRequest): Form =>
  typeof request.body === "object" && request.body !== null
    ? Object.fromEntries(Object.entries(request.body).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : {};

const queryLang = (request: FastifyRequest): unknown => (request.query as { lang?: unknown } | undefined)?.lang;

const langOf = (request: FastifyRequest): Lang => pickLang(queryLang(request) ?? formOf(request).lang, request.headers["accept-language"]);

/** The current path with the other language, for the language switch; `saved` keeps a "Saved." notice. */
const otherLang = (path: string, lang: Lang, saved = false): string => `${path}?lang=${lang === "ar" ? "en" : "ar"}${saved ? "&saved=1" : ""}`;

const sendPage = (reply: FastifyReply, status: number, document: string) =>
  reply.code(status).header("content-type", "text/html; charset=utf-8").send(document);

const errorBlock = (message: string | undefined, id: string): SafeHtml | false =>
  message !== undefined && html`<p class="error" id="${id}" role="alert">${message}</p>`;

/** An error page: the message as its heading, and a language switch back to the same path. */
function errorPage(lang: Lang, message: string, url: string): string {
  return page(lang, t(lang, "siteTitle"), html`<h1 role="alert">${message}</h1>`, otherLang(url.split("?", 1)[0] ?? "/", lang));
}

export function recoveryEmail(to: string, link: string): EmailMessage {
  return {
    to,
    subject: "Restore your loyalty card / استعادة بطاقة الولاء",
    text: [
      "Someone asked to restore the loyalty cards that use this email.",
      `To restore them on this phone, open this link within 30 minutes: ${link}`,
      "If you asked more than once, only the link in the newest email works. If you did not ask, ignore this email.",
      "",
      "طلب أحدهم استعادة بطاقات الولاء التي تستخدم هذا البريد.",
      `لاستعادتها على هذا الهاتف، افتح هذا الرابط خلال 30 دقيقة: ${link}`,
      "إذا طلبت أكثر من مرة، فالرابط في أحدث رسالة هو الوحيد الذي يعمل. إذا لم تطلب ذلك، تجاهل هذه الرسالة.",
    ].join("\n"),
  };
}

/**
 * Deletes a card and, if that was its customer's last card anywhere, the customer (the phone number) too (AC 9).
 * The customer's ON DELETE RESTRICT foreign key decides "anywhere", since this café's view cannot see other cafés'
 * cards; its refusal (restrict_violation, 23001) is rolled back to a savepoint and leaves the customer for those cards.
 */
async function deleteCard(trx: Transaction<Database>, card: { id: string; cafe_id: string; customer_id: string | null }): Promise<void> {
  await audit(trx, { cafeId: card.cafe_id, actorType: "system", actorId: null, action: "card.deleted", entityType: "card", entityId: card.id, changes: { source: "customer" } });
  await trx.deleteFrom("cards").where("id", "=", card.id).execute();
  if (card.customer_id === null) {
    return;
  }
  await setLookup(trx, { customerId: card.customer_id });
  await sql`SAVEPOINT delete_customer`.execute(trx);
  try {
    await trx.deleteFrom("customers").where("id", "=", card.customer_id).execute();
    await sql`RELEASE SAVEPOINT delete_customer`.execute(trx);
  } catch (error) {
    if ((error as { code?: unknown }).code !== RESTRICT_VIOLATION) {
      throw error;
    }
    await sql`ROLLBACK TO SAVEPOINT delete_customer`.execute(trx);
    await sql`RELEASE SAVEPOINT delete_customer`.execute(trx);
  }
}

/**
 * The customer-facing pages, server-rendered in Arabic and English without any script: café signup from its counter
 * QR (AC 4, 5), the web card (AC 7, 10), recovery by email (AC 8) and deletion (AC 9). Register at the root, outside
 * /api: these are pages and HTML forms, not the JSON API.
 */
export function customerPages(app: FastifyInstance, options: CustomerPagesOptions, done: (error?: Error) => void): void {
  const { db, secrets } = options;
  const limits = {
    // Generous per address: a café's customers often share its Wi-Fi.
    signupPerIp: new RateLimiter(60, HOUR * 1000),
    // A backstop on cards created per café, counting valid signups only, so junk from a few addresses cannot
    // shut a café's signup page; the per-address limit is the main one.
    signupPerCafe: new RateLimiter(options.limits?.signupPerCafe ?? 1_000, HOUR * 1000),
    cardChangesPerCard: new RateLimiter(20, HOUR * 1000),
    recoverPerIp: new RateLimiter(5, HOUR * 1000),
    recoverPerEmail: new RateLimiter(3, HOUR * 1000),
    restorePerIp: new RateLimiter(10, 15 * MINUTE * 1000),
  };

  function enforce(limiter: RateLimiter, key: string): void {
    const wait = limiter.hit(key);
    if (wait > 0) {
      throw new PageError(429, "tooMany", { minutes: Math.ceil(wait / 60) });
    }
  }

  async function cafeByJoinCode(code: string): Promise<{ id: string; name: string } | undefined> {
    if (!joinCodeSchema.safeParse(code).success) {
      return undefined;
    }
    const codeHash = hashToken(code);
    return withLookup(db, { secretHash: codeHash }, (trx) => trx.selectFrom("cafes").select(["id", "name"]).where("join_code_hash", "=", codeHash).executeTakeFirst());
  }

  async function programOf(cafeId: string) {
    return withCafe(db, cafeId, (trx) => trx.selectFrom("loyalty_programs").select(["stamps_required", "reward_name_ar", "reward_name_en"]).executeTakeFirst());
  }

  async function findCard(secret: string) {
    if (!isToken(secret)) {
      return undefined;
    }
    const secretHash = hashToken(secret);
    return withLookup(db, { secretHash }, (trx) =>
      trx
        .selectFrom("cards")
        .select(["id", "cafe_id", "customer_id", "epoch", "stamps", "email", "offers_opt_in_at"])
        .where("web_secret_hash", "=", secretHash)
        .executeTakeFirst(),
    );
  }

  async function cardOrGone(secret: string) {
    const card = await findCard(secret);
    if (card === undefined) {
      throw new PageError(404, "cardGone");
    }
    return card;
  }

  function joinPage(lang: Lang, path: string, cafeName: string, program: Awaited<ReturnType<typeof programOf>>, values: Form, errors: { phone?: string; privacy?: string }): string {
    const reward = program === undefined ? undefined : lang === "ar" ? program.reward_name_ar : program.reward_name_en;
    return page(
      lang,
      t(lang, "joinTitle", { cafe: cafeName }),
      html`<h1>${t(lang, "joinTitle", { cafe: cafeName })}</h1>
${program === undefined || reward === undefined ? null : html`<p>${t(lang, "programSummary", { stamps: program.stamps_required, reward })}</p>`}
<form method="post" action="${path}" novalidate>
<input type="hidden" name="lang" value="${lang}">
<input type="hidden" name="form" value="${values.form !== undefined && isToken(values.form) ? values.form : newToken()}">
<label for="phone">${t(lang, "phoneLabel")}</label>
<input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" dir="ltr" required value="${values.phone ?? ""}" aria-describedby="phone-hint${errors.phone === undefined ? "" : " phone-error"}"${errors.phone === undefined ? "" : html` aria-invalid="true"`}>
<p id="phone-hint">${t(lang, "phoneHint")}</p>
${errorBlock(errors.phone, "phone-error")}
<div class="privacy" id="privacy-text"><strong>${t(lang, "privacyTitle")}</strong><p>${t(lang, "privacyText", { cafe: cafeName })}</p></div>
<label class="check"><input type="checkbox" name="privacy" value="yes" required aria-describedby="privacy-text${errors.privacy === undefined ? "" : " privacy-error"}"${errors.privacy === undefined ? "" : html` aria-invalid="true"`}${values.privacy === "yes" ? html` checked` : ""}> ${t(lang, "privacyAccept")}</label>
${errorBlock(errors.privacy, "privacy-error")}
<label class="check"><input type="checkbox" name="offers" value="yes"${values.offers === "yes" ? html` checked` : ""}> ${t(lang, "offersOptIn", { cafe: cafeName })}</label>
<button type="submit">${t(lang, "joinButton")}</button>
</form>
<p><a href="/recover?lang=${lang}">${t(lang, "lostCard")}</a></p>`,
      otherLang(path, lang),
    );
  }

  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 8 * 1024 }, (_request, body, next) => {
    next(null, Object.fromEntries(new URLSearchParams(typeof body === "string" ? body : body.toString("utf8"))));
  });

  // Card and recovery links carry secrets: never cached, never sent on as a referrer, never indexed, no scripts.
  app.addHook("onRequest", (_request, reply, next) => {
    void reply
      .header("cache-control", "no-store")
      .header("referrer-policy", "no-referrer")
      .header("x-robots-tag", "noindex, nofollow")
      .header("content-security-policy", CUSTOMER_CSP)
      .header("x-content-type-options", "nosniff");
    next();
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    const lang = langOf(request);
    if (error instanceof PageError) {
      if (error.status === 429) {
        void reply.header("retry-after", String((Number(error.values.minutes) || 1) * 60));
      }
      const values = error.key === "tooMany" ? { minutes: count(lang, "minutes", Number(error.values.minutes) || 1) } : error.values;
      return sendPage(reply, error.status, errorPage(lang, t(lang, error.key, values), request.url));
    }
    const status = typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: error }, "customer page failed");
    } else {
      request.log.info({ status }, "customer page request rejected");
    }
    const key: MessageKey = status >= 500 ? "failed" : status === 404 ? "notFound" : "badRequest";
    return sendPage(reply, status, errorPage(lang, t(lang, key), request.url));
  });

  // Bare or truncated paths get a page in the visitor's language rather than the API's JSON 404.
  for (const bare of ["/join", "/c", "/r"]) {
    app.get(bare, () => {
      throw new PageError(404, "notFound");
    });
  }

  /** The café's signup page, opened from its counter QR (AC 4). */
  app.get("/join/:code", async (request, reply) => {
    const { code } = request.params as { code: string };
    const lang = langOf(request);
    const cafe = await cafeByJoinCode(code);
    if (cafe === undefined) {
      throw new PageError(404, "joinGone");
    }
    return sendPage(reply, 200, joinPage(lang, `/join/${code}`, cafe.name, await programOf(cafe.id), {}, {}));
  });

  /**
   * Signup (AC 4, 5). A new number gets a card linked to it; a number already known gets a card linked to it at a
   * café where it has none, and an unlinked card (which works by QR, never by phone number) where it already has
   * one. Either way the reply is the same redirect to a fresh card, after the same minimum time, and never shows an
   * existing card.
   */
  app.post("/join/:code", async (request, reply) => {
    const started = Date.now();
    const { code } = request.params as { code: string };
    const lang = langOf(request);
    enforce(limits.signupPerIp, clientKey(request.ip));
    const cafe = await cafeByJoinCode(code);
    if (cafe === undefined) {
      throw new PageError(404, "joinGone");
    }
    const form = formOf(request);
    const phone = normalizePhoneInput(form.phone ?? "");
    const errors = {
      ...(phone === null ? { phone: t(lang, "phoneInvalid") } : {}),
      ...(form.privacy === "yes" ? {} : { privacy: t(lang, "privacyRequired") }),
    };
    if (phone === null || form.privacy !== "yes") {
      return sendPage(reply, 400, joinPage(lang, `/join/${code}`, cafe.name, await programOf(cafe.id), form, errors));
    }
    // Keyed by the café found, not the code sent, so random codes cannot fill the limiter and crowd a café out.
    enforce(limits.signupPerCafe, cafe.id);
    const lookup = phoneLookup(secrets, phone);
    // Encrypted whether or not it is stored, so a known number costs the same.
    const encrypted = encryptPhone(secrets, phone);
    // The card's secret comes from the form's one-time value, so sending the same form twice (a double tap, a retry
    // on a slow network) lands on the one card it created instead of making a second. Keyed with the pepper, so
    // knowing the form value alone gives no card.
    const formValue = form.form !== undefined && isToken(form.form) ? form.form : newToken();
    const webSecret = createHmac("sha256", secrets.phoneLookupPepper).update(`web-secret:${cafe.id}:${formValue}`).digest("base64url");
    const webSecretHash = hashToken(webSecret);
    await withCafe(db, cafe.id, async (trx) => {
      if ((await trx.selectFrom("cards").select("id").where("web_secret_hash", "=", webSecretHash).executeTakeFirst()) !== undefined) {
        return;
      }
      await setLookup(trx, { secretHash: lookup });
      const inserted = await trx
        .insertInto("customers")
        .values({ phone_lookup: lookup, phone_ciphertext: encrypted.ciphertext, phone_key_id: encrypted.keyId })
        .onConflict((conflict) => conflict.column("phone_lookup").doNothing())
        .returning("id")
        .executeTakeFirst();
      const customer = inserted ?? (await trx.selectFrom("customers").select("id").where("phone_lookup", "=", lookup).executeTakeFirstOrThrow());
      // Consent times from the database clock, like every other time.
      const card = { cafe_id: cafe.id, web_secret_hash: webSecretHash, privacy_accepted_at: now(), offers_opt_in_at: form.offers === "yes" ? now() : null };
      // DO NOTHING on any conflict: this café's linked card for the number, or the same form sent concurrently.
      const linked = await trx
        .insertInto("cards")
        .values({ ...card, customer_id: customer.id })
        .onConflict((conflict) => conflict.doNothing())
        .returning("id")
        .executeTakeFirst();
      const created =
        linked ?? (await trx.insertInto("cards").values({ ...card, customer_id: null }).onConflict((conflict) => conflict.doNothing()).returning("id").executeTakeFirst());
      if (created === undefined) {
        // The same form, sent at the same moment, created the card first.
        return;
      }
      if (linked === undefined) {
        // The number already has a card here, so one of the two may not be the number's owner: that card is never
        // stamped by number again (PHONE_DISPUTED), only by its QR. The minimum signup time hides this extra step (AC 5).
        await trx
          .updateTable("cards")
          .set({ phone_disputed_at: sql<Date>`coalesce(phone_disputed_at, ${now()})` })
          .where("customer_id", "=", customer.id)
          .execute();
      }
      await audit(trx, { cafeId: cafe.id, actorType: "system", actorId: null, action: "card.created", entityType: "card", entityId: created.id, changes: { source: "customer" } });
    });
    request.log.info({ cafeId: cafe.id }, "customer card created");
    await atLeast(started, MIN_SIGNUP_MS);
    return reply.code(303).header("location", `/c/${webSecret}?lang=${lang}`).send();
  });

  /** The web card (AC 7, 10): the signed QR, the stamps, and the card's own settings. */
  app.get("/c/:secret", async (request, reply) => {
    const { secret } = request.params as { secret: string };
    const lang = langOf(request);
    const card = await cardOrGone(secret);
    const { saved } = request.query as { saved?: string };
    return sendPage(reply, 200, await cardPage(lang, secret, card, saved === "1" ? t(lang, "saved") : undefined, {}));
  });

  async function cardPage(
    lang: Lang,
    secret: string,
    card: NonNullable<Awaited<ReturnType<typeof findCard>>>,
    notice: string | undefined,
    errors: { email?: string; delete?: string },
  ): Promise<string> {
    const { cafe, program } = await withCafe(db, card.cafe_id, async (trx) => ({
      cafe: await trx.selectFrom("cafes").select("name").where("id", "=", card.cafe_id).executeTakeFirstOrThrow(),
      program: await trx.selectFrom("loyalty_programs").select(["stamps_required", "reward_name_ar", "reward_name_en"]).executeTakeFirst(),
    }));
    const qr = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderSVG(signCardQr(secrets, { cardId: card.id, cafeId: card.cafe_id, epoch: card.epoch }), { border: 4 }))}`;
    const path = `/c/${secret}`;
    const reward = program === undefined ? undefined : lang === "ar" ? program.reward_name_ar : program.reward_name_en;
    return page(
      lang,
      t(lang, "cardTitle", { cafe: cafe.name }),
      html`<h1>${t(lang, "cardTitle", { cafe: cafe.name })}</h1>
${notice === undefined ? null : html`<p class="notice" role="status">${notice}</p>`}
<p class="stamps">${program === undefined ? count(lang, "stamps", card.stamps) : t(lang, "stampsProgress", { stamps: card.stamps, required: count(lang, "stamps", program.stamps_required) })}</p>
${reward === undefined || program === undefined ? null : html`<p>${t(lang, "programSummary", { stamps: program.stamps_required, reward })}</p>`}
<img class="qr" src="${qr}" alt="${t(lang, "qrAlt")}" width="288" height="288">
<p>${t(lang, "keepLink")}</p>
<section aria-labelledby="email-title">
<h2 id="email-title">${t(lang, "emailTitle")}</h2>
<p>${t(lang, "emailText")}</p>
<form method="post" action="${path}/email" novalidate>
<input type="hidden" name="lang" value="${lang}">
<label for="email">${t(lang, "emailLabel")}</label>
<input id="email" name="email" type="email" autocomplete="email" dir="ltr" value="${card.email ?? ""}" aria-describedby="email-hint${errors.email === undefined ? "" : " email-error"}"${errors.email === undefined ? "" : html` aria-invalid="true"`}>
<p id="email-hint">${t(lang, "emailRemoveHint")}</p>
${errorBlock(errors.email, "email-error")}
<button type="submit">${t(lang, "emailSave")}</button>
</form>
</section>
<section aria-labelledby="offers-title">
<h2 id="offers-title">${t(lang, "offersTitle")}</h2>
<form method="post" action="${path}/offers">
<input type="hidden" name="lang" value="${lang}">
<label class="check"><input type="checkbox" name="offers" value="yes"${card.offers_opt_in_at === null ? "" : html` checked`}> ${t(lang, "offersLabel", { cafe: cafe.name })}</label>
<button type="submit">${t(lang, "offersSave")}</button>
</form>
</section>
<section aria-labelledby="delete-title">
<h2 id="delete-title">${t(lang, "deleteTitle")}</h2>
<p id="delete-text">${t(lang, "deleteText")}</p>
<form method="post" action="${path}/delete" novalidate>
<input type="hidden" name="lang" value="${lang}">
<label class="check"><input type="checkbox" name="confirm" value="yes" aria-describedby="delete-text${errors.delete === undefined ? "" : " delete-error"}"> ${t(lang, "deleteConfirm")}</label>
${errorBlock(errors.delete, "delete-error")}
<button type="submit" class="danger">${t(lang, "deleteButton")}</button>
</form>
</section>`,
      otherLang(path, lang, notice !== undefined),
    );
  }

  /** Sets or removes the card's recovery email (AC 8). */
  app.post("/c/:secret/email", async (request, reply) => {
    const { secret } = request.params as { secret: string };
    const lang = langOf(request);
    const card = await cardOrGone(secret);
    enforce(limits.cardChangesPerCard, card.id);
    const raw = formOf(request).email?.trim() ?? "";
    const parsed = raw === "" ? null : ownerEmailSchema.safeParse(raw);
    if (parsed !== null && !parsed.success) {
      return sendPage(reply, 400, await cardPage(lang, secret, card, undefined, { email: t(lang, "emailInvalid") }));
    }
    const email = parsed === null ? null : parsed.data;
    await withCafe(db, card.cafe_id, async (trx) => {
      await trx
        .updateTable("cards")
        .set({ email, email_lookup: email === null ? null : emailLookup(secrets, email) })
        .where("id", "=", card.id)
        .execute();
      await audit(trx, { cafeId: card.cafe_id, actorType: "system", actorId: null, action: email === null ? "card.email_removed" : "card.email_set", entityType: "card", entityId: card.id, changes: { source: "customer" } });
    });
    request.log.info({ cafeId: card.cafe_id }, "card recovery email changed");
    return reply.code(303).header("location", `/c/${secret}?lang=${lang}&saved=1`).send();
  });

  /** Opts in to or out of offers, recording when (AC 4). */
  app.post("/c/:secret/offers", async (request, reply) => {
    const { secret } = request.params as { secret: string };
    const lang = langOf(request);
    const card = await cardOrGone(secret);
    enforce(limits.cardChangesPerCard, card.id);
    const optIn = formOf(request).offers === "yes";
    await withCafe(db, card.cafe_id, async (trx) => {
      // Opting in again keeps the first consent time; opting out clears it.
      await trx
        .updateTable("cards")
        .set({ offers_opt_in_at: optIn ? sql<Date>`coalesce(offers_opt_in_at, now())` : null })
        .where("id", "=", card.id)
        .execute();
      await audit(trx, { cafeId: card.cafe_id, actorType: "system", actorId: null, action: optIn ? "card.offers_opted_in" : "card.offers_opted_out", entityType: "card", entityId: card.id, changes: { source: "customer" } });
    });
    return reply.code(303).header("location", `/c/${secret}?lang=${lang}&saved=1`).send();
  });

  /** Deletes the card, and the phone number with it if no café has another card for it (AC 9). */
  app.post("/c/:secret/delete", async (request, reply) => {
    const started = Date.now();
    const { secret } = request.params as { secret: string };
    const lang = langOf(request);
    const card = await cardOrGone(secret);
    if (formOf(request).confirm !== "yes") {
      return sendPage(reply, 400, await cardPage(lang, secret, card, undefined, { delete: t(lang, "deleteConfirmRequired") }));
    }
    await withCafe(db, card.cafe_id, (trx) => deleteCard(trx, card));
    request.log.info({ cafeId: card.cafe_id }, "customer card deleted");
    await atLeast(started, MIN_DELETE_MS);
    return sendPage(reply, 200, page(lang, t(lang, "deletedTitle"), html`<h1>${t(lang, "deletedTitle")}</h1><p role="status">${t(lang, "deletedText")}</p>`, otherLang("/recover", lang)));
  });

  function recoverPage(lang: Lang, sent: boolean, error?: string): string {
    return page(
      lang,
      t(lang, "recoverTitle"),
      html`<h1>${t(lang, "recoverTitle")}</h1>
${sent ? html`<p class="notice" role="status">${t(lang, "recoverSent")}</p>` : null}
<p>${t(lang, "recoverText")}</p>
<form method="post" action="/recover" novalidate>
<input type="hidden" name="lang" value="${lang}">
<label for="email">${t(lang, "emailLabel")}</label>
<input id="email" name="email" type="email" autocomplete="email" dir="ltr" required${error === undefined ? "" : html` aria-invalid="true" aria-describedby="email-error"`}>
${errorBlock(error, "email-error")}
<button type="submit">${t(lang, "recoverButton")}</button>
</form>`,
      otherLang("/recover", lang),
    );
  }

  app.get("/recover", async (request, reply) => sendPage(reply, 200, recoverPage(langOf(request), false)));

  async function sendRecovery(email: string, log: FastifyBaseLogger): Promise<void> {
    const lookup = emailLookup(secrets, email);
    const cards = await withLookup(db, { secretHash: lookup }, (trx) => trx.selectFrom("cards").select("cafe_id").where("email_lookup", "=", lookup).execute());
    if (cards.length === 0) {
      log.info("card recovery requested for an email no card uses");
      return;
    }
    const token = newToken();
    await withLookup(
      db,
      { secretHash: lookup },
      async (trx) => {
        // One row per email: a new link replaces the old one, even when two requests race.
        const values = { token_hash: hashToken(token), expires_at: secondsFromNow(RECOVERY_TOKEN_TTL_SECONDS) };
        await trx
          .insertInto("customer_recovery_tokens")
          .values({ email_lookup: lookup, ...values })
          .onConflict((conflict) => conflict.column("email_lookup").doUpdateSet(values))
          .execute();
      },
      "read write",
    );
    try {
      await options.mailer.send(recoveryEmail(email, new URL(`/r/${token}`, options.publicUrl).toString()));
    } catch (error) {
      log.error({ err: error, cafeIds: cards.map((card) => card.cafe_id) }, "card recovery email failed");
      return;
    }
    log.info({ cafeIds: cards.map((card) => card.cafe_id) }, "card recovery email sent");
  }

  /**
   * Starts a recovery. The reply is the same whether or not a card uses the email, and it is sent before any lookup
   * (AC 8, like AC 16 for owners); the lookup and the email run afterwards.
   */
  app.post("/recover", async (request, reply) => {
    const lang = langOf(request);
    enforce(limits.recoverPerIp, clientKey(request.ip));
    const parsed = ownerEmailSchema.safeParse(formOf(request).email ?? "");
    if (!parsed.success) {
      return sendPage(reply, 400, recoverPage(lang, false, t(lang, "emailInvalid")));
    }
    const log = request.log;
    // Over the per-email limit the reply stays the same and nothing is sent, so nobody can lock a victim out of
    // recovery by asking for their email three times.
    if (limits.recoverPerEmail.hit(parsed.data) > 0) {
      log.info("card recovery email skipped: per-email limit reached");
    } else {
      options.background.run("card-recovery-email", () => sendRecovery(parsed.data, log));
    }
    return sendPage(reply, 200, recoverPage(lang, true));
  });

  async function liveRecovery(token: string): Promise<boolean> {
    if (!isToken(token)) {
      return false;
    }
    const tokenHash = hashToken(token);
    const found = await withLookup(db, { secretHash: tokenHash }, (trx) =>
      trx.selectFrom("customer_recovery_tokens").select("id").where("token_hash", "=", tokenHash).where("expires_at", ">", now()).executeTakeFirst(),
    );
    return found !== undefined;
  }

  /** The recovery link opens a page with buttons, so a mail scanner fetching the link cannot use it up. */
  app.get("/r/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    const lang = langOf(request);
    if (!(await liveRecovery(token))) {
      throw new PageError(410, "linkExpired");
    }
    const path = `/r/${token}`;
    return sendPage(
      reply,
      200,
      page(
        lang,
        t(lang, "restoreTitle"),
        html`<h1>${t(lang, "restoreTitle")}</h1>
<p>${t(lang, "restoreText")}</p>
<form method="post" action="${path}"><input type="hidden" name="lang" value="${lang}"><input type="hidden" name="action" value="restore"><button type="submit">${t(lang, "restoreButton")}</button></form>
<p>${t(lang, "restoreDeleteText")}</p>
<form method="post" action="${path}"><input type="hidden" name="lang" value="${lang}"><input type="hidden" name="action" value="delete"><button type="submit" class="danger">${t(lang, "restoreDeleteButton")}</button></form>`,
        otherLang(path, lang),
      ),
    );
  });

  /**
   * Uses a recovery link once: restore gives every card with that email a new epoch and a new web link, so the old
   * QR codes and links stop working (AC 8); delete removes those cards and any phone number left without a card
   * (AC 9). All in one transaction across the customer's cafés.
   */
  app.post("/r/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    const lang = langOf(request);
    enforce(limits.restorePerIp, clientKey(request.ip));
    const action = formOf(request).action === "delete" ? "delete" : "restore";
    if (!isToken(token)) {
      throw new PageError(410, "linkExpired");
    }
    const tokenHash = hashToken(token);
    const restored = await withLookup(
      db,
      { secretHash: tokenHash },
      async (trx) => {
        const used = await trx
          .deleteFrom("customer_recovery_tokens")
          .where("token_hash", "=", tokenHash)
          .where("expires_at", ">", now())
          .returning("email_lookup")
          .executeTakeFirst();
        if (used === undefined) {
          throw new PageError(410, "linkExpired");
        }
        await setLookup(trx, { secretHash: used.email_lookup });
        const cards = await trx.selectFrom("cards").select(["id", "cafe_id", "customer_id"]).where("email_lookup", "=", used.email_lookup).execute();
        if (cards.length === 0) {
          // The email was removed or its cards deleted since the link was sent; rolling back keeps nothing used.
          throw new PageError(410, "linkExpired");
        }
        const results: { cafeName: string; secret: string; cafeId: string }[] = [];
        for (const card of cards) {
          // The café ids come from the customer's own cards, reached through the link they just proved.
          await useCafe(trx, card.cafe_id);
          if (action === "delete") {
            await deleteCard(trx, card);
            continue;
          }
          const secret = newToken();
          await trx
            .updateTable("cards")
            .set({ epoch: sql<number>`epoch + 1`, web_secret_hash: hashToken(secret) })
            .where("id", "=", card.id)
            .execute();
          await audit(trx, { cafeId: card.cafe_id, actorType: "system", actorId: null, action: "card.restored", entityType: "card", entityId: card.id, changes: { source: "customer" } });
          const cafe = await trx.selectFrom("cafes").select("name").where("id", "=", card.cafe_id).executeTakeFirstOrThrow();
          results.push({ cafeName: cafe.name, secret, cafeId: card.cafe_id });
        }
        return { cafeIds: cards.map((card) => card.cafe_id), results };
      },
      "read write",
    );
    request.log.info({ cafeIds: restored.cafeIds, action }, action === "delete" ? "customer cards deleted by recovery link" : "customer cards restored");
    if (action === "delete") {
      return sendPage(reply, 200, page(lang, t(lang, "deletedTitle"), html`<h1>${t(lang, "deletedTitle")}</h1><p role="status">${t(lang, "deletedText")}</p>`, otherLang("/recover", lang)));
    }
    const [only] = restored.results;
    if (restored.results.length === 1 && only !== undefined) {
      // One card: straight to it, so the new link is what the browser keeps.
      return reply.code(303).header("location", `/c/${only.secret}?lang=${lang}`).send();
    }
    // This page is the only place the new links appear and cannot be loaded again, so it has no language switch.
    // Two cards at one café (a phone-linked and an unlinked one) get numbered names.
    const seen = new Map<string, number>();
    const labelled = restored.results.map((result) => {
      const index = (seen.get(result.cafeName) ?? 0) + 1;
      seen.set(result.cafeName, index);
      return { ...result, label: index === 1 ? result.cafeName : `${result.cafeName} (${String(index)})` };
    });
    return sendPage(
      reply,
      200,
      page(
        lang,
        t(lang, "restoredTitle"),
        html`<h1>${t(lang, "restoredTitle")}</h1>
<p>${t(lang, "restoredText")}</p>
<ul>${labelled.map((result) => html`<li><a href="/c/${result.secret}?lang=${lang}"><bdi>${result.label}</bdi></a></li>`)}</ul>`,
        null,
      ),
    );
  });

  done();
}
