import { createHmac, randomInt, randomUUID } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { hashToken } from "./credentials.js";
import { decryptPhone } from "./customer-crypto.js";
import { MIN_SIGNUP_MS } from "./customer-pages.js";
import { PUBLIC_URL, TEST_SECRETS, useApiHarness, withCookie, type Harness, type SignedUpOwner } from "./testing/api-harness.js";

const context = useApiHarness();
const { harness, signUp, auditActions } = context;

const formBody = (fields: Record<string, string>) => ({
  headers: { "content-type": "application/x-www-form-urlencoded" },
  payload: new URLSearchParams(fields).toString(),
});

async function cafeWithJoinCode(): Promise<Harness & { owner: SignedUpOwner; code: string }> {
  const h = await harness();
  const owner = await signUp(h.app);
  const join = await h.app.inject({ method: "GET", url: "/api/cafe/join", headers: withCookie(owner.session) });
  const code = /\/join\/([0-9a-f]{32})$/.exec(join.json<{ joinUrl: string }>().joinUrl)?.[1] ?? "missing";
  return { ...h, owner, code };
}

async function join(app: FastifyInstance, code: string, phone: string, extra: Record<string, string> = {}): Promise<LightMyRequestResponse> {
  return app.inject({ method: "POST", url: `/join/${code}`, ...formBody({ phone, privacy: "yes", lang: "en", ...extra }) });
}

const secretOf = (response: LightMyRequestResponse): string => /^\/c\/([A-Za-z0-9_-]{43})\?/.exec(String(response.headers.location))?.[1] ?? "missing";

async function cardRow(secret: string) {
  const { rows } = await context.admin.query<{ id: string; cafe_id: string; customer_id: string | null; epoch: number; email: string | null; offers_opt_in_at: Date | null; privacy_accepted_at: Date }>(
    "SELECT id, cafe_id, customer_id, epoch, email, offers_opt_in_at, privacy_accepted_at FROM app.cards WHERE web_secret_hash = $1",
    [hashToken(secret)],
  );
  return rows[0];
}

/** A number no other test uses, so the customer row's lifecycle belongs to this test alone. */
const uniquePhone = (): string => `70 ${String(randomInt(100_000, 999_999))}`.replace(/^70 (\d{3})(\d{3})$/, "70 $1 $2");

const phoneLookupOf = (e164: string) => createHmac("sha256", TEST_SECRETS.phoneLookupPepper).update(`phone:${e164}`).digest();

describe("signup page", () => {
  it("serves an Arabic form by default and English on request, with the card-page protections", async () => {
    const { app, code } = await cafeWithJoinCode();
    const arabic = await app.inject({ method: "GET", url: `/join/${code}` });
    expect(arabic.statusCode).toBe(200);
    expect(arabic.body).toContain('<html lang="ar" dir="rtl">');
    expect(arabic.headers).toMatchObject({
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
      "x-content-type-options": "nosniff",
    });
    expect(String(arabic.headers["content-security-policy"])).toMatch(/^default-src 'none'; style-src 'sha256-[A-Za-z0-9+/=]+'; img-src 'self' data:; font-src 'self';/);
    expect(arabic.body).not.toContain("<script");
    const english = await app.inject({ method: "GET", url: `/join/${code}?lang=en`, headers: { "accept-language": "ar" } });
    expect(english.body).toContain('<html lang="en" dir="ltr">');
    expect(english.body).toContain("Get your loyalty card at \u2068Café Test\u2069");
    expect(english.body).toContain("I have read the privacy notice");
  });

  it("answers an unknown or malformed code with a not-found page", async () => {
    const { app } = await harness();
    for (const code of ["0".repeat(32), "nope"]) {
      const response = await app.inject({ method: "GET", url: `/join/${code}?lang=en` });
      expect(response.statusCode).toBe(404);
      expect(response.body).toContain("This signup code is no longer valid.");
    }
  });
});

describe("signup", () => {
  it("creates a card linked to the number, which is stored only as a hash and ciphertext (AC 4, 6)", async () => {
    const { app, code, owner } = await cafeWithJoinCode();
    const response = await join(app, code, "٧٠ ١٢٣ ٤٥٦", { offers: "yes" });
    expect(response.statusCode).toBe(303);
    const card = await cardRow(secretOf(response));
    expect(card).toMatchObject({ cafe_id: owner.cafeId, epoch: 1, email: null });
    expect(card?.offers_opt_in_at).toBeInstanceOf(Date);
    expect(card?.privacy_accepted_at).toBeInstanceOf(Date);
    const { rows } = await context.admin.query<{ phone_lookup: Buffer; phone_ciphertext: Buffer; phone_key_id: string }>(
      "SELECT phone_lookup, phone_ciphertext, phone_key_id FROM app.customers WHERE id = $1",
      [card?.customer_id],
    );
    expect(rows[0]?.phone_lookup.equals(phoneLookupOf("+96170123456"))).toBe(true);
    expect(rows[0]?.phone_ciphertext.toString("latin1")).not.toContain("70123456");
    expect(decryptPhone(TEST_SECRETS, rows[0]?.phone_key_id ?? "", rows[0]?.phone_ciphertext ?? Buffer.alloc(0))).toBe("+96170123456");
    expect(await auditActions(owner.cafeId)).toContain("card.created");
  });

  it("answers a new number, a number known elsewhere and a number already here the same way, never with the existing card (AC 5)", async () => {
    const first = await cafeWithJoinCode();
    const second = await cafeWithJoinCode();
    const original = await join(first.app, first.code, "70 111 222");
    const replies: { response: LightMyRequestResponse; ms: number }[] = [];
    for (const [app, code, phone] of [
      [first.app, first.code, "70 333 444"],
      [second.app, second.code, "70 111 222"],
      [first.app, first.code, "70 111 222"],
    ] as const) {
      const started = Date.now();
      replies.push({ response: await join(app, code, phone), ms: Date.now() - started });
    }
    for (const { response, ms } of replies) {
      expect(response.statusCode).toBe(303);
      expect(response.body).toBe("");
      expect(Object.keys(response.headers).sort()).toEqual(Object.keys(original.headers).sort());
      expect(ms).toBeGreaterThanOrEqual(MIN_SIGNUP_MS - 5);
    }
    const [newNumber, knownElsewhere, alreadyHere] = await Promise.all(replies.map(({ response }) => cardRow(secretOf(response))));
    const originalCard = await cardRow(secretOf(original));
    expect(newNumber?.customer_id).not.toBeNull();
    // Known elsewhere: a card at the second café, linked to the same number.
    expect(knownElsewhere?.customer_id).toBe(originalCard?.customer_id);
    // Already here: a different, unlinked card; the existing card is untouched.
    expect(alreadyHere?.id).not.toBe(originalCard?.id);
    expect(alreadyHere?.customer_id).toBeNull();
    expect(await cardRow(secretOf(original))).toMatchObject({ id: originalCard?.id, epoch: 1 });
  });

  it("explains a bad number or a missing consent", async () => {
    const { app, code } = await cafeWithJoinCode();
    const badPhone = await join(app, code, "12");
    expect(badPhone.statusCode).toBe(400);
    expect(badPhone.body).toContain("Enter a mobile number, such as 70 123 456");
    expect(badPhone.body).toContain('aria-invalid="true"');
    const noConsent = await app.inject({ method: "POST", url: `/join/${code}`, ...formBody({ phone: "70 123 456", lang: "en" }) });
    expect(noConsent.statusCode).toBe(400);
    expect(noConsent.body).toContain("Tick the box to accept the privacy notice.");
  });

  it("is rate-limited per address", async () => {
    const { app, code } = await cafeWithJoinCode();
    for (let attempt = 1; attempt <= 60; attempt += 1) {
      expect((await join(app, code, "bad", { lang: "en" })).statusCode).toBe(400);
    }
    const blocked = await join(app, code, "70 123 456");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect(blocked.body).toContain("Too many attempts.");
    // Other addresses are not blocked by this one.
    const other = await app.inject({ method: "POST", url: `/join/${code}`, remoteAddress: "198.51.100.77", ...formBody({ phone: "bad", privacy: "yes" }) });
    expect(other.statusCode).toBe(400);
  });

  it("caps the cards a café can hand out per hour, from any address", async () => {
    const h = await harness({ customerLimits: { signupPerCafe: 2 } });
    const owner = await signUp(h.app);
    const join = await h.app.inject({ method: "GET", url: "/api/cafe/join", headers: withCookie(owner.session) });
    const code = /\/join\/([0-9a-f]{32})$/.exec(join.json<{ joinUrl: string }>().joinUrl)?.[1] ?? "missing";
    const signup = (address: string) =>
      h.app.inject({ method: "POST", url: `/join/${code}`, remoteAddress: address, ...formBody({ phone: uniquePhone(), privacy: "yes", lang: "en" }) });
    expect((await signup("198.51.100.1")).statusCode).toBe(303);
    expect((await signup("198.51.100.2")).statusCode).toBe(303);
    const blocked = await signup("198.51.100.3");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.body).toContain("Too many attempts. Wait \u206860 minutes\u2069 and try again.");
  });

  it("lands a form sent twice on the one card it created", async () => {
    const { app, code } = await cafeWithJoinCode();
    const form = /name="form" value="([A-Za-z0-9_-]{43})"/.exec((await app.inject({ method: "GET", url: `/join/${code}` })).body)?.[1] ?? "missing";
    const phone = uniquePhone();
    const first = await join(app, code, phone, { form });
    const second = await join(app, code, phone, { form });
    expect(second.headers.location).toBe(first.headers.location);
    const card = await cardRow(secretOf(first));
    expect(card?.customer_id).not.toBeNull();
    const { rows } = await context.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM app.cards WHERE customer_id = $1", [card?.customer_id]);
    expect(rows[0]?.n).toBe(1);
  });

  it("does not let invalid submissions use up a café's signups", async () => {
    const { app, code } = await cafeWithJoinCode();
    for (let attempt = 0; attempt < 1_100; attempt += 1) {
      const response = await app.inject({ method: "POST", url: `/join/${code}`, remoteAddress: `198.51.100.${String(attempt % 50)}`, ...formBody({ phone: "bad" }) });
      expect(response.statusCode).toBe(400);
    }
    expect((await join(app, code, "70 123 456")).statusCode).toBe(303);
  });

  it("treats a field that is not text as missing", async () => {
    const { app, code } = await cafeWithJoinCode();
    const response = await app.inject({ method: "POST", url: `/join/${code}?lang=en`, payload: { phone: 70123456, privacy: ["yes"] } });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("Enter a mobile number");
  });

  it("explains an unreadable form", async () => {
    const { app, code } = await cafeWithJoinCode();
    const response = await app.inject({ method: "POST", url: `/join/${code}?lang=en`, headers: { "content-type": "text/plain" }, payload: "phone=70123456" });
    expect(response.statusCode).toBe(415);
    expect(response.body).toContain("This form could not be read.");
  });
});

describe("fonts and logo", () => {
  it("serves the stylesheet's fonts and the logo, cached, and nothing else from there", async () => {
    const { app } = await harness();
    const font = await app.inject({ method: "GET", url: "/assets/fonts/ibm-plex-sans-arabic-latin-400-normal.woff2" });
    expect(font.statusCode).toBe(200);
    expect(font.headers).toMatchObject({ "content-type": "font/woff2", "cache-control": "public, max-age=604800" });
    expect(font.rawPayload.subarray(0, 4).toString("latin1")).toBe("wOF2");
    const logo = await app.inject({ method: "GET", url: "/assets/logo.svg" });
    expect(logo.headers).toMatchObject({ "content-type": "image/svg+xml", "cache-control": "public, max-age=604800" });
    expect(logo.body).toMatch(/^<svg /);
    for (const url of ["/assets/fonts/unknown.woff2", "/assets/fonts/..%2F..%2Fpackage.json"]) {
      const missing = await app.inject({ method: "GET", url });
      expect(missing.statusCode).toBe(404);
      expect(missing.headers["cache-control"]).toBe("no-store");
    }
  });
});

describe("web card", () => {
  it("shows the café, the stamps and the QR, with no script and a strict policy (AC 7)", async () => {
    const { app, code } = await cafeWithJoinCode();
    const secret = secretOf(await join(app, code, "70 123 456"));
    const card = await app.inject({ method: "GET", url: `/c/${secret}?lang=en` });
    expect(card.statusCode).toBe(200);
    expect(card.body).toContain("Your card at \u2068Café Test\u2069");
    expect(card.body).toContain("0 stamps");
    // The apostrophe is escaped in the attribute.
    expect(card.body).toMatch(/<img class="qr" src="data:image\/svg\+xml;charset=utf-8,[^"]+" alt="Your card&#39;s QR code/);
    expect(card.body).not.toContain("<script");
    expect(card.headers).toMatchObject({ "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" });
  });

  it("shows the program's stamps as a grid with the stamps left, and the offer the card holds (AC 14)", async () => {
    const { app, code, owner } = await cafeWithJoinCode();
    const as = (method: "POST" | "PUT", url: string, payload: Record<string, unknown>) => app.inject({ method, url, headers: withCookie(owner.session), payload });
    await as("PUT", "/api/cafe/program", { stampsRequired: 9, rewardNameAr: "قهوة مجانية", rewardNameEn: "Free coffee" });
    const coffee =
      (await as("POST", "/api/cafe/order-types", { nameAr: "قهوة", nameEn: "Coffee", priceCents: 300, costCents: 90, stampsEarned: 1, active: true })).json<{ orderTypes: { id: string }[] }>()
        .orderTypes[0]?.id ?? "missing";
    const secret = secretOf(await join(app, code, uniquePhone(), { offers: "yes" }));
    const card = await cardRow(secret);
    await context.admin.query("UPDATE app.cards SET stamps = 3 WHERE id = $1", [card?.id]);
    const page = (await app.inject({ method: "GET", url: `/c/${secret}?lang=en` })).body;
    expect(page).toContain("\u20683\u2069 of \u20689 stamps\u2069");
    expect(page.match(/<li class="stamp is-filled">/g)).toHaveLength(3);
    expect(page.match(/<li class="stamp"><\/li>/g)).toHaveLength(6);
    expect(page).toContain("\u20686 stamps\u2069 to go for \u2068Free coffee\u2069.");
    expect(page).not.toContain('class="offer"');

    const created = await as("POST", "/api/campaigns", {
      nameAr: "عصرية",
      nameEn: "Afternoon",
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      startsMinute: 0,
      endsMinute: 1440,
      discount: { kind: "percent", value: 20 },
      orderTypeIds: [coffee],
    });
    const campaignId = created.json<{ running: { id: string }[] }>().running[0]?.id;
    // As the worker announces it (announceCampaigns).
    await context.admin.query("INSERT INTO app.campaign_announcements (cafe_id, campaign_id, card_id) VALUES ($1, $2, $3)", [owner.cafeId, campaignId, card?.id]);
    const withOffer = (await app.inject({ method: "GET", url: `/c/${secret}?lang=en` })).body;
    expect(withOffer).toContain('<section class="offer" aria-labelledby="offer-title">');
    expect(withOffer).toContain("Afternoon · 20% off");
    expect(withOffer).toContain("Every day, all day, on Coffee.");
  });

  it("sets and removes a recovery email, and opts in and out of offers", async () => {
    const { app, code } = await cafeWithJoinCode();
    const secret = secretOf(await join(app, code, "70 123 456"));
    const saved = await app.inject({ method: "POST", url: `/c/${secret}/email`, ...formBody({ email: " Rana@Example.com ", lang: "en" }) });
    expect(saved.statusCode).toBe(303);
    expect(saved.headers.location).toBe(`/c/${secret}?lang=en&saved=1`);
    expect((await cardRow(secret))?.email).toBe("rana@example.com");
    expect((await app.inject({ method: "POST", url: `/c/${secret}/email`, ...formBody({ email: "nope", lang: "en" }) })).statusCode).toBe(400);
    await app.inject({ method: "POST", url: `/c/${secret}/email`, ...formBody({ email: "", lang: "en" }) });
    expect((await cardRow(secret))?.email).toBeNull();

    await app.inject({ method: "POST", url: `/c/${secret}/offers`, ...formBody({ offers: "yes" }) });
    const optedIn = (await cardRow(secret))?.offers_opt_in_at;
    expect(optedIn).toBeInstanceOf(Date);
    await app.inject({ method: "POST", url: `/c/${secret}/offers`, ...formBody({ offers: "yes" }) });
    expect((await cardRow(secret))?.offers_opt_in_at?.getTime()).toBe(optedIn?.getTime());
    await app.inject({ method: "POST", url: `/c/${secret}/offers`, ...formBody({}) });
    expect((await cardRow(secret))?.offers_opt_in_at).toBeNull();
  });

  it("deletes the card after confirmation, and the number with it when no café has another card (AC 9)", async () => {
    const first = await cafeWithJoinCode();
    const second = await cafeWithJoinCode();
    const phone = uniquePhone();
    const here = secretOf(await join(first.app, first.code, phone));
    const there = secretOf(await join(second.app, second.code, phone));
    const customerId = (await cardRow(here))?.customer_id;
    const customerCount = async () => (await context.admin.query("SELECT 1 FROM app.customers WHERE id = $1", [customerId])).rowCount;

    expect((await first.app.inject({ method: "POST", url: `/c/${here}/delete`, ...formBody({ lang: "en" }) })).statusCode).toBe(400);
    const deleted = await first.app.inject({ method: "POST", url: `/c/${here}/delete`, ...formBody({ confirm: "yes", lang: "en" }) });
    expect(deleted.body).toContain("Your card and its data are deleted.");
    expect(await cardRow(here)).toBeUndefined();
    expect(await customerCount()).toBe(1);
    expect((await first.app.inject({ method: "GET", url: `/c/${here}?lang=en` })).statusCode).toBe(404);

    await second.app.inject({ method: "POST", url: `/c/${there}/delete`, ...formBody({ confirm: "yes" }) });
    expect(await customerCount()).toBe(0);
    expect(await auditActions(first.owner.cafeId)).toContain("card.deleted");
  });

  it("keeps the saved notice when switching language", async () => {
    const { app, code } = await cafeWithJoinCode();
    const secret = secretOf(await join(app, code, uniquePhone()));
    const saved = await app.inject({ method: "GET", url: `/c/${secret}?lang=en&saved=1` });
    expect(saved.body).toContain(`href="/c/${secret}?lang=ar&amp;saved=1"`);
  });

  it("answers a trailing slash and a bare path with pages, not the API's JSON", async () => {
    const { app } = await harness();
    const recover = await app.inject({ method: "GET", url: "/recover/?lang=en" });
    expect(recover.statusCode).toBe(200);
    for (const path of ["/join/?lang=en", "/c?lang=en", "/r/?lang=en"]) {
      const response = await app.inject({ method: "GET", url: path });
      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.body).toContain('<h1 role="alert">No such page.');
    }
  });

  it("answers an unknown link with a not-found page", async () => {
    const { app } = await harness();
    for (const secret of ["A".repeat(43), "short"]) {
      const response = await app.inject({ method: "GET", url: `/c/${secret}?lang=en` });
      expect(response.statusCode).toBe(404);
      expect(response.body).toContain("This card link no longer works.");
    }
  });
});

describe("recovery", () => {
  /** Two cards at two cafés with one number and one email that no other test uses. */
  async function withEmailCards() {
    const first = await cafeWithJoinCode();
    const second = await cafeWithJoinCode();
    const phone = uniquePhone();
    const email = `rana-${randomUUID()}@example.com`;
    const secrets = [secretOf(await join(first.app, first.code, phone)), secretOf(await join(second.app, second.code, phone))];
    for (const [app, secret] of [
      [first.app, secrets[0]],
      [second.app, secrets[1]],
    ] as const) {
      await app.inject({ method: "POST", url: `/c/${secret ?? ""}/email`, ...formBody({ email }) });
    }
    return { first, secrets, email };
  }

  async function requestLink(h: Harness, email: string): Promise<LightMyRequestResponse> {
    const response = await h.app.inject({ method: "POST", url: "/recover", ...formBody({ email, lang: "en" }) });
    await h.background.drain();
    return response;
  }

  const tokenOf = (h: Harness, index = 0): string => new RegExp(`${PUBLIC_URL}/r/([A-Za-z0-9_-]{43})`).exec(h.mailer.sent[index]?.text ?? "")?.[1] ?? "missing";

  it("answers known and unknown emails the same way and emails only a known one", async () => {
    const { first, email } = await withEmailCards();
    const known = await requestLink(first, email);
    const unknown = await requestLink(first, "nobody@example.com");
    expect(known.statusCode).toBe(200);
    expect(known.body).toBe(unknown.body);
    expect(first.mailer.sent).toHaveLength(1);
    expect(first.mailer.sent[0]?.to).toBe(email);
  });

  it("restores every card with that email on a new epoch, once, and the old links stop working (AC 8)", async () => {
    const { first, secrets, email } = await withEmailCards();
    await requestLink(first, email);
    const token = tokenOf(first);
    const before = await Promise.all(secrets.map((secret) => cardRow(secret)));
    // Opening the link does not use it.
    for (let view = 0; view < 2; view += 1) {
      expect((await first.app.inject({ method: "GET", url: `/r/${token}?lang=en` })).body).toContain("Restore my cards");
    }
    const restored = await first.app.inject({ method: "POST", url: `/r/${token}`, ...formBody({ action: "restore", lang: "en" }) });
    expect(restored.statusCode).toBe(200);
    // The only place the new links appear, and it cannot be loaded again: no language switch leading away from it.
    expect(restored.body).not.toContain('class="lang"');
    const links = [...restored.body.matchAll(/href="\/c\/([A-Za-z0-9_-]{43})\?lang=en"/g)].map((match) => match[1] ?? "");
    expect(links).toHaveLength(2);
    for (const secret of secrets) {
      expect((await first.app.inject({ method: "GET", url: `/c/${secret}` })).statusCode).toBe(404);
    }
    const after = await Promise.all(links.map((secret) => cardRow(secret)));
    expect(after.map((card) => card?.epoch).sort()).toEqual(before.map((card) => (card?.epoch ?? 0) + 1).sort());
    expect((await first.app.inject({ method: "POST", url: `/r/${token}`, ...formBody({ action: "restore", lang: "en" }) })).statusCode).toBe(410);
  });

  it("deletes every card with that email, and the number with them (AC 9)", async () => {
    const { first, secrets, email } = await withEmailCards();
    const customerId = (await cardRow(secrets[0] ?? ""))?.customer_id;
    await requestLink(first, email);
    const deleted = await first.app.inject({ method: "POST", url: `/r/${tokenOf(first)}`, ...formBody({ action: "delete", lang: "en" }) });
    expect(deleted.body).toContain("Your card and its data are deleted.");
    for (const secret of secrets) {
      expect(await cardRow(secret)).toBeUndefined();
    }
    expect((await context.admin.query("SELECT 1 FROM app.customers WHERE id = $1", [customerId])).rowCount).toBe(0);
  });

  it("goes straight to the card when the email has only one", async () => {
    const h = await cafeWithJoinCode();
    const secret = secretOf(await join(h.app, h.code, uniquePhone()));
    const email = `sami-${randomUUID()}@example.com`;
    await h.app.inject({ method: "POST", url: `/c/${secret}/email`, ...formBody({ email }) });
    await requestLink(h, email);
    const restored = await h.app.inject({ method: "POST", url: `/r/${tokenOf(h)}`, ...formBody({ action: "restore", lang: "en" }) });
    expect(restored.statusCode).toBe(303);
    const newSecret = secretOf(restored);
    expect(newSecret).not.toBe(secret);
    expect((await h.app.inject({ method: "GET", url: `/c/${newSecret}` })).statusCode).toBe(200);
  });

  it("treats a link whose cards are gone as expired, without using it up", async () => {
    const { first, secrets, email } = await withEmailCards();
    await requestLink(first, email);
    for (const secret of secrets) {
      await first.app.inject({ method: "POST", url: `/c/${secret}/email`, ...formBody({ email: "" }) });
    }
    const response = await first.app.inject({ method: "POST", url: `/r/${tokenOf(first)}`, ...formBody({ action: "restore", lang: "en" }) });
    expect(response.statusCode).toBe(410);
    expect(response.body).toContain("This link has expired");
  });

  it("answers the same way past the per-email limit, sending nothing more", async () => {
    const { first, email } = await withEmailCards();
    const replies = [];
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      replies.push(await first.app.inject({ method: "POST", url: "/recover", remoteAddress: `198.51.100.${String(60 + attempt)}`, ...formBody({ email, lang: "en" }) }));
    }
    await first.background.drain();
    expect(replies.map((reply) => reply.statusCode)).toEqual([200, 200, 200, 200]);
    expect(new Set(replies.map((reply) => reply.body)).size).toBe(1);
    expect(first.mailer.sent).toHaveLength(3);
  });

  it("keeps one live link per email even when requests race", async () => {
    const { first, email } = await withEmailCards();
    await Promise.all([1, 2, 3].map(() => first.app.inject({ method: "POST", url: "/recover", remoteAddress: "198.51.100.30", ...formBody({ email }) })));
    await first.background.drain();
    const lookup = createHmac("sha256", TEST_SECRETS.phoneLookupPepper).update(`email:${email}`).digest();
    const { rows } = await context.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM app.customer_recovery_tokens WHERE email_lookup = $1", [lookup]);
    expect(rows[0]?.n).toBe(1);
  });

  it("refuses an expired link and keeps only the newest", async () => {
    const { first, email } = await withEmailCards();
    await requestLink(first, email);
    await requestLink(first, email);
    expect((await first.app.inject({ method: "GET", url: `/r/${tokenOf(first, 0)}?lang=en` })).statusCode).toBe(410);
    await context.admin.query("UPDATE app.customer_recovery_tokens SET expires_at = now() - interval '1 second'");
    const expired = await first.app.inject({ method: "POST", url: `/r/${tokenOf(first, 1)}`, ...formBody({ action: "restore", lang: "en" }) });
    expect(expired.statusCode).toBe(410);
    expect(expired.body).toContain("This link has expired, was already used, or was replaced by a newer one.");
  });
});

describe("café signup code", () => {
  it("is shown to the owner and can be replaced, retiring the old code", async () => {
    const { app, owner, code } = await cafeWithJoinCode();
    const rotated = await app.inject({ method: "POST", url: "/api/cafe/join/rotate", headers: withCookie(owner.session), payload: {} });
    const newCode = /\/join\/([0-9a-f]{32})$/.exec(rotated.json<{ joinUrl: string }>().joinUrl)?.[1] ?? "missing";
    expect(newCode).not.toBe(code);
    expect((await app.inject({ method: "GET", url: `/join/${code}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/join/${newCode}` })).statusCode).toBe(200);
    expect(await auditActions(owner.cafeId)).toContain("cafe.join_code_rotated");
  });
});

describe("logs", () => {
  it("never contain phone numbers, emails or card secrets", async () => {
    const { app, code, logs, mailer, background } = await cafeWithJoinCode();
    const secret = secretOf(await join(app, code, "70 123 456"));
    await app.inject({ method: "POST", url: `/c/${secret}/email`, ...formBody({ email: "rana@example.com" }) });
    await app.inject({ method: "POST", url: "/recover", ...formBody({ email: "rana@example.com" }) });
    await background.drain();
    const token = /\/r\/([A-Za-z0-9_-]{43})/.exec(mailer.sent[0]?.text ?? "")?.[1] ?? "missing";
    await app.inject({ method: "POST", url: `/r/${token}`, ...formBody({ action: "restore" }) });
    const output = logs.join("");
    expect(output).toContain("customer card created");
    for (const leaked of ["70123456", "70 123 456", "rana@example.com", secret, token, code]) {
      expect(output).not.toContain(leaked);
    }
  });
});
