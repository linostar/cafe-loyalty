import { createHmac, randomInt, randomUUID } from "node:crypto";
import { signEmailUndoToken, signFeedbackToken } from "@cafe-loyalty/db";
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
      "referrer-policy": "same-origin",
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
    const response = await join(app, code, "٧٠ ١٢٣ ٤٥٦");
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

  it("turns offers on for every new card without asking, whatever an older form sends", async () => {
    const { app, code, owner } = await cafeWithJoinCode();
    const page = await app.inject({ method: "GET", url: `/join/${code}?lang=en` });
    expect(page.body).not.toContain('name="offers"');
    expect(page.body).not.toContain("Send offers");
    expect((await app.inject({ method: "GET", url: `/join/${code}?lang=ar` })).body).not.toContain('name="offers"');
    for (const extra of [{}, { offers: "yes" }, { offers: "no" }]) {
      const card = await cardRow(secretOf(await join(app, code, uniquePhone(), extra)));
      // On, as the offer jobs read it (cards.offers_opt_in_at IS NOT NULL: worker offers.ts and win-back.ts).
      expect(card?.offers_opt_in_at).toBeInstanceOf(Date);
    }
    const { rows } = await context.admin.query<{ changes: unknown }>("SELECT changes FROM app.audit_log WHERE cafe_id = $1 AND action = 'card.created' ORDER BY id", [owner.cafeId]);
    expect(rows.map((row) => row.changes)).toEqual(Array.from({ length: 3 }, () => ({ source: "customer", offers: "on_by_default" })));
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

  it("never opens a card someone else signed up with when the same form is sent with another number", async () => {
    const { app, code } = await cafeWithJoinCode();
    const form = /name="form" value="([A-Za-z0-9_-]{43})"/.exec((await app.inject({ method: "GET", url: `/join/${code}` })).body)?.[1] ?? "missing";
    // The first customer signs up; the next sends the same page again (after Back, on a shared tablet) with their own number.
    const otherPhone = uniquePhone();
    const first = await join(app, code, uniquePhone(), { form });
    const second = await join(app, code, otherPhone, { form });
    expect([first.statusCode, second.statusCode]).toEqual([303, 303]);
    expect(secretOf(second)).not.toBe(secretOf(first));
    const [mine, theirs] = [await cardRow(secretOf(first)), await cardRow(secretOf(second))];
    expect(mine?.id).not.toBe(theirs?.id);
    expect(theirs?.customer_id).not.toBeNull();
    expect(theirs?.customer_id).not.toBe(mine?.customer_id);
    // And the second one's retry lands on their own card, not the first.
    expect((await join(app, code, otherPhone, { form })).headers.location).toBe(second.headers.location);
  });

  it("lands the same form sent twice with a number already here on the one unlinked card it made", async () => {
    const { app, code } = await cafeWithJoinCode();
    const phone = uniquePhone();
    const linked = await cardRow(secretOf(await join(app, code, phone)));
    const form = /name="form" value="([A-Za-z0-9_-]{43})"/.exec((await app.inject({ method: "GET", url: `/join/${code}` })).body)?.[1] ?? "missing";
    const [first, again] = [await join(app, code, phone, { form }), await join(app, code, phone, { form })];
    expect(again.headers.location).toBe(first.headers.location);
    const unlinked = await cardRow(secretOf(first));
    expect(unlinked?.customer_id).toBeNull();
    expect(unlinked?.id).not.toBe(linked?.id);
    const { rows } = await context.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM app.cards WHERE cafe_id = $1 AND customer_id IS NULL", [unlinked?.cafe_id]);
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

describe("cross-site form posts", () => {
  const crossSite = { "sec-fetch-site": "cross-site" };
  const routes = (code: string, secret: string) => [
    `/join/${code}`,
    `/c/${secret}/email`,
    `/c/${secret}/offers`,
    `/c/${secret}/delete`,
    "/recover",
    `/r/${secret}`,
    `/f/${secret}`,
    `/u/${secret}`,
  ];

  it("refuses every customer form posted from another site, in the visitor's language, before reading it", async () => {
    const { app, code } = await cafeWithJoinCode();
    const secret = secretOf(await join(app, code, uniquePhone()));
    const cafeId = (await cardRow(secret))?.cafe_id;
    const cardsOfCafe = async () => (await context.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM app.cards WHERE cafe_id = $1", [cafeId])).rows[0]?.n;
    const before = await cardsOfCafe();
    for (const url of routes(code, secret)) {
      for (const headers of [crossSite, { "sec-fetch-site": "same-site" }, { "sec-fetch-site": "none" }, { origin: "https://evil.example.com" }, { origin: "null" }]) {
        const refused = await app.inject({ method: "POST", url: `${url}?lang=en`, headers: { ...headers, "content-type": "application/x-www-form-urlencoded" }, payload: `phone=${encodeURIComponent(uniquePhone())}&privacy=yes&email=someone%40example.com&confirm=yes&message=Hi` });
        expect({ url, headers, status: refused.statusCode }).toEqual({ url, headers, status: 403 });
        expect(refused.body).toContain("This form can only be sent from its own page.");
        expect(refused.headers["content-security-policy"]).toBeDefined();
        expect(refused.headers["cache-control"]).toBe("no-store");
        expect(refused.headers["referrer-policy"]).toBe("same-origin");
      }
    }
    // Refused before the body is read: an unreadable one gets the same answer.
    expect((await app.inject({ method: "POST", url: `/join/${code}`, headers: { ...crossSite, "content-type": "application/json" }, payload: "{" })).statusCode).toBe(403);
    const arabic = await app.inject({ method: "POST", url: `/recover?lang=ar`, headers: { ...crossSite, "content-type": "application/x-www-form-urlencoded" }, payload: "email=someone%40example.com" });
    expect(arabic.body).toContain("لا يمكن إرسال هذا النموذج إلا من صفحته.");
    // Nothing was made or changed: the refused signups (a fresh number each time) left the café's cards as they were.
    expect(await cardsOfCafe()).toBe(before);
    expect((await cardRow(secret))?.email).toBeNull();
  });

  it("accepts a form posted from its own page, from a browser that says nothing, or with its own Origin", async () => {
    const { app, code } = await cafeWithJoinCode();
    for (const headers of [{ "sec-fetch-site": "same-origin" }, {}, { origin: new URL(PUBLIC_URL).origin }]) {
      const body = formBody({ phone: uniquePhone(), privacy: "yes", lang: "en" });
      const response = await app.inject({ method: "POST", url: `/join/${code}`, headers: { ...headers, ...body.headers }, payload: body.payload });
      expect({ headers, status: response.statusCode }).toEqual({ headers, status: 303 });
    }
  });

  it("leaves pages opened from other sites and the PassKit web service alone", async () => {
    const { app, code } = await cafeWithJoinCode();
    expect((await app.inject({ method: "GET", url: `/join/${code}`, headers: crossSite })).statusCode).toBe(200);
    const passkit = await app.inject({ method: "POST", url: "/passkit/v1/log", headers: { ...crossSite, "content-type": "application/json" }, payload: { logs: ["test"] } });
    expect(passkit.statusCode).not.toBe(403);
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
    expect(card.headers).toMatchObject({ "cache-control": "no-store", "referrer-policy": "same-origin", "x-robots-tag": "noindex, nofollow" });
    // The page itself says the same, so a meta tag never takes the real Origin off its own form posts.
    expect(card.body).toContain('<meta name="referrer" content="same-origin">');
  });

  it("shows the program's stamps as a grid with the stamps left or the reward ready, and the offer the card holds (AC 14)", async () => {
    const { app, code, owner } = await cafeWithJoinCode();
    const as = (method: "POST" | "PUT", url: string, payload: Record<string, unknown>) => app.inject({ method, url, headers: withCookie(owner.session), payload });
    await as("PUT", "/api/cafe/program", { stampsRequired: 9, rewardNameAr: "قهوة مجانية", rewardNameEn: "Free coffee" });
    const coffee =
      (await as("POST", "/api/cafe/order-types", { nameAr: "قهوة", nameEn: "Coffee", priceCents: 300, costCents: 90, stampsEarned: 1, active: true })).json<{ orderTypes: { id: string }[] }>()
        .orderTypes[0]?.id ?? "missing";
    const secret = secretOf(await join(app, code, uniquePhone()));
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

    // A full card, and one past full (stamps keep counting): every slot filled and the reward ready, no stamps to go.
    for (const stamps of [9, 10]) {
      await context.admin.query("UPDATE app.cards SET stamps = $2 WHERE id = $1", [card?.id, stamps]);
      const full = (await app.inject({ method: "GET", url: `/c/${secret}?lang=en` })).body;
      expect(full.match(/<li class="stamp is-filled">/g)).toHaveLength(9);
      expect(full).not.toContain('<li class="stamp"></li>');
      expect(full).toContain("Your reward is ready: \u2068Free coffee\u2069. Show this card to the barista.");
      expect(full).not.toContain("to go for");
    }
  });

  it("sets and removes a recovery email, and opts in and out of offers", async () => {
    const { app, code } = await cafeWithJoinCode();
    const secret = secretOf(await join(app, code, "70 123 456"));
    const saved = await app.inject({ method: "POST", url: `/c/${secret}/email`, ...formBody({ email: " Rana@Example.com ", lang: "en" }) });
    expect(saved.statusCode).toBe(303);
    // The forms live on the card's settings page (Step 8), so a save lands back there.
    expect(saved.headers.location).toBe(`/c/${secret}/settings?lang=en&saved=1`);
    expect((await cardRow(secret))?.email).toBe("rana@example.com");
    expect((await app.inject({ method: "POST", url: `/c/${secret}/email`, ...formBody({ email: "nope", lang: "en" }) })).statusCode).toBe(400);
    // An empty Save is refused, never a removal: the field starts empty. Removing takes its own button.
    expect((await app.inject({ method: "POST", url: `/c/${secret}/email`, ...formBody({ email: "", lang: "en" }) })).statusCode).toBe(400);
    expect((await cardRow(secret))?.email).toBe("rana@example.com");
    await app.inject({ method: "POST", url: `/c/${secret}/email`, ...formBody({ email: "", remove: "yes", lang: "en" }) });
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
    // On the settings page, where the forms that set it now are (Step 8).
    const saved = await app.inject({ method: "GET", url: `/c/${secret}/settings?lang=en&saved=1` });
    expect(saved.body).toContain('<p class="notice" role="status">Saved.</p>');
    expect(saved.body).toContain(`href="/c/${secret}/settings?lang=ar&amp;saved=1"`);
  });

  it("links the card to its settings page, which holds the email, offers and delete forms and leads back (AC 11)", async () => {
    const { app, code } = await cafeWithJoinCode();
    const secret = secretOf(await join(app, code, uniquePhone()));
    const card = (await app.inject({ method: "GET", url: `/c/${secret}?lang=en` })).body;
    expect(card).toContain(`<a class="link-button next" href="/c/${secret}/settings?lang=en"><span>Card settings: email, offers, delete</span>`);
    expect(card).not.toContain("<form");

    for (const lang of ["en", "ar"] as const) {
      const settings = await app.inject({ method: "GET", url: `/c/${secret}/settings?lang=${lang}` });
      expect(settings.statusCode).toBe(200);
      expect(settings.headers).toMatchObject({ "cache-control": "no-store", "referrer-policy": "same-origin", "x-robots-tag": "noindex, nofollow" });
      expect(settings.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(settings.body).not.toContain("<script");
      expect(settings.body).toContain(`<html lang="${lang}" dir="${lang === "ar" ? "rtl" : "ltr"}">`);
      expect(settings.body).toContain(`href="/c/${secret}?lang=${lang}"`);
      expect(settings.body).toContain(`href="/c/${secret}/settings?lang=${lang === "ar" ? "en" : "ar"}"`);
      for (const form of ["email", "offers", "delete"]) {
        expect(settings.body).toContain(`<form method="post" action="/c/${secret}/${form}"`);
      }
      expect(settings.body).toContain('<section aria-labelledby="delete-title" class="card danger-zone">');
    }
    const arabic = (await app.inject({ method: "GET", url: `/c/${secret}/settings?lang=ar` })).body;
    expect(arabic).toContain("<h1>إعدادات البطاقة</h1>");
    expect(arabic).toContain("العودة إلى بطاقتك");
  });

  it("answers a bad email or an unconfirmed delete on the settings page, and an unknown card's settings with not found", async () => {
    const { app, code } = await cafeWithJoinCode();
    const secret = secretOf(await join(app, code, uniquePhone()));
    const badEmail = await app.inject({ method: "POST", url: `/c/${secret}/email`, ...formBody({ email: "nope", lang: "en" }) });
    expect(badEmail.statusCode).toBe(400);
    expect(badEmail.body).toContain("<h1>Card settings</h1>");
    expect(badEmail.body).toContain('<p class="field-error" id="email-error" role="alert">Enter an email address');
    const unconfirmed = await app.inject({ method: "POST", url: `/c/${secret}/delete`, ...formBody({ lang: "en" }) });
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.body).toContain("<h1>Card settings</h1>");
    expect(unconfirmed.body).toContain('id="delete-error" role="alert">Tick the box to confirm.');
    expect((await cardRow(secret))?.email).toBeNull();

    const offers = await app.inject({ method: "POST", url: `/c/${secret}/offers`, ...formBody({ lang: "en" }) });
    expect(offers.statusCode).toBe(303);
    expect(offers.headers.location).toBe(`/c/${secret}/settings?lang=en&saved=1`);
    expect((await app.inject({ method: "GET", url: String(offers.headers.location) })).body).not.toContain('name="offers" value="yes" checked');

    for (const unknown of ["A".repeat(43), "short"]) {
      const response = await app.inject({ method: "GET", url: `/c/${unknown}/settings?lang=en` });
      expect(response.statusCode).toBe(404);
      expect(response.body).toContain("This card link no longer works.");
    }
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
      await first.app.inject({ method: "POST", url: `/c/${secret}/email`, ...formBody({ remove: "yes" }) });
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

describe("email change undo", () => {
  const undoPathOf = (h: Harness, index: number): string => new RegExp(`${PUBLIC_URL}(/u/[A-Za-z0-9._-]+)`).exec(h.mailer.sent[index]?.text ?? "")?.[1] ?? "missing";
  // An empty email presses Remove email, the only way to remove one.
  const setEmail = async (h: Harness, secret: string, email: string) => {
    const response = await h.app.inject({ method: "POST", url: `/c/${secret}/email`, ...formBody(email === "" ? { remove: "yes", lang: "en" } : { email, lang: "en" }) });
    await h.background.drain();
    return response;
  };

  it("shows the stored email masked, never in full", async () => {
    const h = await cafeWithJoinCode();
    const secret = secretOf(await join(h.app, h.code, uniquePhone()));
    // With none stored: no hint about replacing or removing one, nor a Remove button.
    const empty = (await h.app.inject({ method: "GET", url: `/c/${secret}/settings?lang=en` })).body;
    expect(empty).not.toContain("replace it");
    expect(empty).not.toContain('id="email-hint"');
    expect(empty).not.toMatch(/<input id="email"[^>]*aria-describedby/);
    expect(empty).not.toContain('name="remove"');
    await setEmail(h, secret, "rana@example.com");
    for (const lang of ["en", "ar"] as const) {
      const body = (await h.app.inject({ method: "GET", url: `/c/${secret}/settings?lang=${lang}` })).body;
      expect(body).toContain("r•••@example.com");
      expect(body).not.toContain("rana@");
      expect(body).not.toMatch(/name="email"[^>]* value=/);
      // The field is described by the stored address and the hint; Remove is the form's quiet second button.
      expect(body).toMatch(/<input id="email"[^>]* aria-describedby="email-current email-hint"/);
      expect(body).toContain('<button type="submit" class="quiet" name="remove" value="yes" formnovalidate>');
    }
    // Saving a new one still works.
    await setEmail(h, secret, "sami@example.com");
    expect((await cardRow(secret))?.email).toBe("sami@example.com");
  });

  it("tells the old address only on a real change, in both languages", async () => {
    const h = await cafeWithJoinCode();
    const secret = secretOf(await join(h.app, h.code, uniquePhone()));
    await setEmail(h, secret, "rana@example.com");
    await setEmail(h, secret, " RANA@example.com ");
    expect(h.mailer.sent).toHaveLength(0);
    await setEmail(h, secret, "attacker@example.com");
    expect(h.mailer.sent.map((mail) => mail.to)).toEqual(["rana@example.com"]);
    const [notice] = h.mailer.sent;
    expect(notice?.text).not.toContain("attacker");
    expect(notice?.text).toContain("Café Test");
    expect(notice?.text).toContain("تم تغيير بريد الاستعادة");
    expect(undoPathOf(h, 0)).toMatch(/^\/u\/[A-Za-z0-9_-]{22}\./);
    // Removing it tells the address removed.
    await setEmail(h, secret, "");
    expect(h.mailer.sent.map((mail) => mail.to)).toEqual(["rana@example.com", "attacker@example.com"]);
    const page = await h.app.inject({ method: "GET", url: `${undoPathOf(h, 0)}?lang=ar` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("أعد بريد الاستعادة");
    expect(page.body).not.toContain("<script");
    expect(page.headers).toMatchObject({ "cache-control": "no-store", "referrer-policy": "same-origin" });
  });

  it("gives the card back to its old address after a leaked link was used to take it by recovery", async () => {
    const h = await cafeWithJoinCode();
    const victim = secretOf(await join(h.app, h.code, uniquePhone()));
    const card = await cardRow(victim);
    const old = `rana-${randomUUID()}@example.com`;
    await setEmail(h, victim, old);
    // The attacker, holding the leaked link, sets their own address and restores the card with it.
    const attackerEmail = `mallory-${randomUUID()}@example.com`;
    await setEmail(h, victim, attackerEmail);
    const undoPath = undoPathOf(h, 0);
    await h.app.inject({ method: "POST", url: "/recover", ...formBody({ email: attackerEmail, lang: "en" }) });
    await h.background.drain();
    const recovery = /\/r\/([A-Za-z0-9_-]{43})/.exec(h.mailer.sent[1]?.text ?? "")?.[1] ?? "missing";
    const attacker = secretOf(await h.app.inject({ method: "POST", url: `/r/${recovery}`, ...formBody({ action: "restore", lang: "en" }) }));
    expect((await h.app.inject({ method: "GET", url: `/c/${victim}` })).statusCode).toBe(404);
    expect((await h.app.inject({ method: "GET", url: `/c/${attacker}` })).statusCode).toBe(200);
    // A pass on the attacker's phone, which the undo must void.
    expect((await h.app.inject({ method: "GET", url: `/c/${attacker}/apple-pass` })).statusCode).toBe(200);
    await context.admin.query("DELETE FROM pgboss.job WHERE data->>'cafeId' = $1", [h.owner.cafeId]);

    const wrong = await h.app.inject({ method: "POST", url: undoPath, ...formBody({ email: attackerEmail, lang: "en" }) });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.body).toContain("This is not the address this link was sent to.");
    const arabicWrong = await h.app.inject({ method: "POST", url: undoPath, ...formBody({ email: "other@example.com", lang: "ar" }) });
    expect(arabicWrong.body).toContain("هذا ليس العنوان الذي أُرسل إليه هذا الرابط.");

    const undone = await h.app.inject({ method: "POST", url: undoPath, ...formBody({ email: old.toUpperCase(), lang: "en" }) });
    expect(undone.statusCode).toBe(303);
    const restored = secretOf(undone);
    expect((await h.app.inject({ method: "GET", url: `/c/${restored}` })).statusCode).toBe(200);
    expect((await h.app.inject({ method: "GET", url: `/c/${attacker}` })).statusCode).toBe(404);
    const after = await cardRow(restored);
    expect(after).toMatchObject({ id: card?.id, email: old, epoch: (card?.epoch ?? 0) + 2 });
    expect((await context.admin.query("SELECT 1 FROM pgboss.job WHERE data->>'cafeId' = $1", [h.owner.cafeId])).rowCount).toBeGreaterThan(0);
    expect(await auditActions(h.owner.cafeId)).toContain("card.email_change_undone");
    const { rows } = await context.admin.query<{ changes: unknown }>("SELECT changes FROM app.audit_log WHERE action = 'card.email_change_undone' AND cafe_id = $1", [h.owner.cafeId]);
    expect(rows).toEqual([{ changes: { source: "customer" } }]);
    // Used again it still works for the old address (a new link once more, as /recover would give it), so nobody can
    // make it look used by setting the old address back.
    expect((await h.app.inject({ method: "GET", url: `${undoPath}?lang=en` })).statusCode).toBe(200);
    const again = await h.app.inject({ method: "POST", url: undoPath, ...formBody({ email: old, lang: "en" }) });
    expect(again.statusCode).toBe(303);
    expect((await h.app.inject({ method: "GET", url: `/c/${restored}` })).statusCode).toBe(404);
    expect((await h.app.inject({ method: "GET", url: `/c/${secretOf(again)}` })).statusCode).toBe(200);
  });

  it("still works when whoever took the card sets the old address back", async () => {
    const h = await cafeWithJoinCode();
    const victim = secretOf(await join(h.app, h.code, uniquePhone()));
    const old = `rana-${randomUUID()}@example.com`;
    await setEmail(h, victim, old);
    await setEmail(h, victim, `mallory-${randomUUID()}@example.com`);
    const undoPath = undoPathOf(h, 0);
    await setEmail(h, victim, old);
    const undone = await h.app.inject({ method: "POST", url: undoPath, ...formBody({ email: old, lang: "en" }) });
    expect(undone.statusCode).toBe(303);
    expect((await h.app.inject({ method: "GET", url: `/c/${victim}` })).statusCode).toBe(404);
    expect((await cardRow(secretOf(undone)))?.email).toBe(old);
  });

  it("never lets the link sent to an address set later take the card back after the first address's undo, in either order", async () => {
    for (const attackerFirst of [false, true]) {
      const h = await cafeWithJoinCode();
      const victim = secretOf(await join(h.app, h.code, uniquePhone()));
      const old = `rana-${randomUUID()}@example.com`;
      const own = `mallory-${randomUUID()}@example.com`;
      await setEmail(h, victim, old);
      // With the leaked link: their own address, then away from it again, so it gets an undo link of its own.
      await setEmail(h, victim, own);
      await setEmail(h, victim, `other-${randomUUID()}@example.com`);
      expect(h.mailer.sent.map((mail) => mail.to)).toEqual([old, own]);
      const [victimUndo, attackerUndo] = [undoPathOf(h, 0), undoPathOf(h, 1)];
      if (attackerFirst) {
        expect((await h.app.inject({ method: "POST", url: attackerUndo, ...formBody({ email: own, lang: "en" }) })).statusCode).toBe(303);
      }
      const undone = await h.app.inject({ method: "POST", url: victimUndo, ...formBody({ email: old, lang: "en" }) });
      expect({ attackerFirst, status: undone.statusCode }).toEqual({ attackerFirst, status: 303 });
      for (const method of ["GET", "POST"] as const) {
        const refused = await h.app.inject({ method, url: `${attackerUndo}?lang=en`, ...formBody({ email: own, lang: "en" }) });
        expect({ attackerFirst, method, status: refused.statusCode }).toEqual({ attackerFirst, method, status: 410 });
      }
      const card = await cardRow(secretOf(undone));
      expect(card?.email).toBe(old);
      expect((await h.app.inject({ method: "GET", url: `/c/${secretOf(undone)}` })).statusCode).toBe(200);
      // The first address's link still works, and a later change sends a working link again.
      expect((await h.app.inject({ method: "GET", url: `${victimUndo}?lang=en` })).statusCode).toBe(200);
      await setEmail(h, secretOf(undone), `new-${randomUUID()}@example.com`);
      expect((await h.app.inject({ method: "GET", url: `${undoPathOf(h, 2)}?lang=en` })).statusCode).toBe(200);
    }
  });

  it("keeps a voided link voided when the holder undoes a later change of their own", async () => {
    const h = await cafeWithJoinCode();
    const victim = secretOf(await join(h.app, h.code, uniquePhone()));
    const old = `rana-${randomUUID()}@example.com`;
    const own = `mallory-${randomUUID()}@example.com`;
    await setEmail(h, victim, old);
    await setEmail(h, victim, own);
    await setEmail(h, victim, `other-${randomUUID()}@example.com`);
    const attackerUndo = undoPathOf(h, 1);
    const back = secretOf(await h.app.inject({ method: "POST", url: undoPathOf(h, 0), ...formBody({ email: old, lang: "en" }) }));
    // The holder then changes to a mistyped address and undoes that too.
    await setEmail(h, back, `rana-typo-${randomUUID()}@example.com`);
    const again = secretOf(await h.app.inject({ method: "POST", url: undoPathOf(h, 2), ...formBody({ email: old, lang: "en" }) }));
    expect((await h.app.inject({ method: "POST", url: attackerUndo, ...formBody({ email: own, lang: "en" }) })).statusCode).toBe(410);
    expect((await h.app.inject({ method: "GET", url: `/c/${again}` })).statusCode).toBe(200);
  });

  it("keeps an earlier undo's range from voiding the owner's link in a later takeover", async () => {
    const h = await cafeWithJoinCode();
    const first = secretOf(await join(h.app, h.code, uniquePhone()));
    const old = `rana-${randomUUID()}@example.com`;
    const own = `mallory-${randomUUID()}@example.com`;
    await setEmail(h, first, old);
    // The holder's own slip, undone: an undo with nothing in between.
    await setEmail(h, first, `rana-typo-${randomUUID()}@example.com`);
    const card = secretOf(await h.app.inject({ method: "POST", url: undoPathOf(h, 0), ...formBody({ email: old, lang: "en" }) }));
    // Later the card link leaks: their own address, then away from it, and their own link used first.
    await setEmail(h, card, own);
    await setEmail(h, card, `other-${randomUUID()}@example.com`);
    const [ownerUndo, attackerUndo] = [undoPathOf(h, 1), undoPathOf(h, 2)];
    expect((await h.app.inject({ method: "POST", url: attackerUndo, ...formBody({ email: own, lang: "en" }) })).statusCode).toBe(303);
    const back = await h.app.inject({ method: "POST", url: ownerUndo, ...formBody({ email: old, lang: "en" }) });
    expect(back.statusCode).toBe(303);
    expect((await cardRow(secretOf(back)))?.email).toBe(old);
    expect((await h.app.inject({ method: "POST", url: attackerUndo, ...formBody({ email: own, lang: "en" }) })).statusCode).toBe(410);
  });

  it("never applies an email change that waited on the card while an undo or restore re-keyed it", async () => {
    const h = await cafeWithJoinCode();
    const secret = secretOf(await join(h.app, h.code, uniquePhone()));
    const card = await cardRow(secret);
    await context.admin.query("BEGIN");
    await context.admin.query("SELECT 1 FROM app.cards WHERE id = $1 FOR UPDATE", [card?.id]);
    const change = h.app.inject({ method: "POST", url: `/c/${secret}/email`, ...formBody({ email: "mallory@example.com", lang: "en" }) });
    // Waits until the change is blocked on the card's row lock, then re-keys the card as an undo would.
    for (let tries = 0; tries < 100; tries += 1) {
      const { rows } = await context.admin.query<{ waiting: number }>("SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted");
      if ((rows[0]?.waiting ?? 0) > 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await context.admin.query("UPDATE app.cards SET web_secret_hash = $1, epoch = epoch + 1 WHERE id = $2", [hashToken(randomUUID()), card?.id]);
    await context.admin.query("COMMIT");
    const response = await change;
    expect(response.statusCode).toBe(404);
    const { rows } = await context.admin.query<{ email: string | null }>("SELECT email FROM app.cards WHERE id = $1", [card?.id]);
    expect(rows[0]?.email).toBeNull();
  });

  it("sends at most 3 change notices an hour per card to one address, whatever other cards send it", async () => {
    const h = await cafeWithJoinCode();
    const [first, second] = [secretOf(await join(h.app, h.code, uniquePhone())), secretOf(await join(h.app, h.code, uniquePhone()))];
    for (let round = 0; round < 4; round += 1) {
      await setEmail(h, first, "rana@example.com");
      await setEmail(h, first, "");
    }
    expect(h.mailer.sent.map((mail) => mail.to)).toEqual(["rana@example.com", "rana@example.com", "rana@example.com"]);
    expect((await cardRow(first))?.email).toBeNull();
    // The first card used up its own, not the second card's: a change there still tells the address.
    await setEmail(h, second, "rana@example.com");
    await setEmail(h, second, "");
    expect(h.mailer.sent).toHaveLength(4);
  });

  it("refuses an expired, tampered or unknown card's link", async () => {
    const h = await cafeWithJoinCode();
    const secret = secretOf(await join(h.app, h.code, uniquePhone()));
    const card = await cardRow(secret);
    await setEmail(h, secret, "rana@example.com");
    await setEmail(h, secret, "other@example.com");
    const valid = undoPathOf(h, 0).slice(3);
    const emailLookup = createHmac("sha256", TEST_SECRETS.phoneLookupPepper).update("email:rana@example.com").digest();
    const expired = signEmailUndoToken(TEST_SECRETS, { cafeId: h.owner.cafeId, cardId: card?.id ?? "", seq: 2, emailLookup }, Date.now() - 7 * 24 * 60 * 60 * 1000 - 1000);
    const unknown = signEmailUndoToken(TEST_SECRETS, { cafeId: h.owner.cafeId, cardId: randomUUID(), seq: 1, emailLookup });
    const tampered = valid.replace(/.$/, (last) => (last === "A" ? "B" : "A"));
    for (const token of [expired, tampered]) {
      expect((await h.app.inject({ method: "GET", url: `/u/${token}?lang=en` })).statusCode).toBe(410);
      expect((await h.app.inject({ method: "POST", url: `/u/${token}`, ...formBody({ email: "rana@example.com", lang: "en" }) })).statusCode).toBe(410);
    }
    expect((await h.app.inject({ method: "POST", url: `/u/${unknown}`, ...formBody({ email: "rana@example.com", lang: "en" }) })).statusCode).toBe(410);
    expect((await cardRow(secret))?.email).toBe("other@example.com");
  });

  it("limits wrong addresses per IP", async () => {
    const h = await cafeWithJoinCode();
    const secret = secretOf(await join(h.app, h.code, uniquePhone()));
    await setEmail(h, secret, "rana@example.com");
    await setEmail(h, secret, "other@example.com");
    const path = undoPathOf(h, 0);
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      expect((await h.app.inject({ method: "POST", url: path, ...formBody({ email: `guess${String(attempt)}@example.com`, lang: "en" }) })).statusCode).toBe(400);
    }
    const blocked = await h.app.inject({ method: "POST", url: path, ...formBody({ email: "rana@example.com", lang: "en" }) });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.body).toContain("Too many attempts.");
  });
});

describe("per-card limits", () => {
  it("allow 20 Apple pass downloads per card an hour", async () => {
    const h = await cafeWithJoinCode();
    const secret = secretOf(await join(h.app, h.code, uniquePhone()));
    const url = `/c/${secret}/apple-pass?lang=en`;
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      expect((await h.app.inject({ method: "GET", url, remoteAddress: `198.51.100.${String(attempt)}` })).statusCode).not.toBe(429);
    }
    const blocked = await h.app.inject({ method: "GET", url, remoteAddress: "198.51.100.99" });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.body).toContain("Too many attempts.");
  });

  it("never let other card changes use up deleting the card", async () => {
    const h = await cafeWithJoinCode();
    const secret = secretOf(await join(h.app, h.code, uniquePhone()));
    for (let attempt = 1; attempt <= 21; attempt += 1) {
      await h.app.inject({ method: "POST", url: `/c/${secret}/offers`, ...formBody({ offers: "yes", lang: "en" }) });
      await h.app.inject({ method: "POST", url: `/c/${secret}/delete`, ...formBody({ lang: "en" }) });
    }
    expect((await h.app.inject({ method: "POST", url: `/c/${secret}/offers`, ...formBody({ offers: "yes", lang: "en" }) })).statusCode).toBe(429);
    const deleted = await h.app.inject({ method: "POST", url: `/c/${secret}/delete`, ...formBody({ confirm: "yes", lang: "en" }) });
    expect(deleted.statusCode).not.toBe(429);
    expect(await cardRow(secret)).toBeUndefined();
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

describe("feedback", () => {
  /** A card of a new café with a visit 3 hours ago and its feedback request, as the worker gives it; returns its page. */
  async function askedCard() {
    const h = await cafeWithJoinCode();
    const secret = secretOf(await join(h.app, h.code, uniquePhone(), { lang: "en" }));
    const card = await cardRow(secret);
    // A bare visit row (no device, staff or signed event behind it), as the worker's tests make them.
    await context.admin.query("SET session_replication_role = replica");
    let visitId: string | undefined;
    try {
      visitId = (
        await context.admin.query<{ id: string }>(
          `INSERT INTO app.visits (cafe_id, sync_event_id, card_id, identified_by, device_id, staff_id, occurred_at, total_cents, stamps_earned, stamps_added, outcome)
           VALUES ($1, gen_random_uuid(), $2, 'qr', gen_random_uuid(), gen_random_uuid(), now() - interval '3 hours', 300, 1, 1, 'stamped') RETURNING id`,
          [h.owner.cafeId, card?.id],
        )
      ).rows[0]?.id;
    } finally {
      await context.admin.query("SET session_replication_role = DEFAULT");
    }
    const requestId =
      (await context.admin.query<{ id: string }>("INSERT INTO app.feedback_requests (cafe_id, card_id, visit_id) VALUES ($1, $2, $3) RETURNING id", [h.owner.cafeId, card?.id, visitId]))
        .rows[0]?.id ?? "missing";
    const path = `/f/${signFeedbackToken(TEST_SECRETS, { cafeId: h.owner.cafeId, requestId })}`;
    const as = (method: "GET" | "POST" | "PATCH", url: string, payload: Record<string, unknown> = {}) =>
      h.app.inject({ method, url, headers: withCookie(h.owner.session), ...(method === "GET" ? {} : { payload }) });
    return { ...h, secret, card, path, as };
  }

  it("offers every customer a private message and the café's Google review link, with no rating asked (AC 37)", async () => {
    const { app, path, as, secret } = await askedCard();
    // Without a review link: the message form only.
    const plain = await app.inject({ method: "GET", url: `${path}?lang=en` });
    expect(plain.statusCode).toBe(200);
    expect(plain.headers).toMatchObject({ "cache-control": "no-store", "referrer-policy": "same-origin", "x-robots-tag": "noindex, nofollow" });
    expect(plain.body).toContain("How was your visit to \u2068Café Test\u2069?");
    expect(plain.body).toContain('<textarea id="message" name="message"');
    expect(plain.body).not.toContain("Write a Google review");
    // No review gating: the form asks for nothing but the message (no rating or score decides who sees the review link).
    expect([...(/<form[\s\S]*<\/form>/.exec(plain.body)?.[0] ?? "").matchAll(/ name="([^"]+)"/g)].map((match) => match[1])).toEqual(["lang", "message"]);
    // The owner sets a link; it must be a Google one.
    expect((await as("PATCH", "/api/cafe", { googleReviewUrl: "https://example.com/review" })).statusCode).toBe(400);
    const saved = await as("PATCH", "/api/cafe", { googleReviewUrl: " https://g.page/r/FakeReviewLink/review " });
    expect(saved.json<{ cafe: { googleReviewUrl: string | null } }>().cafe.googleReviewUrl).toBe("https://g.page/r/FakeReviewLink/review");
    const withLink = await app.inject({ method: "GET", url: `${path}?lang=en` });
    expect(withLink.body).toContain('<a class="wallet" href="https://g.page/r/FakeReviewLink/review" rel="noreferrer">Write a Google review</a>');
    expect(withLink.body).toContain('<textarea id="message"');
    // Arabic too.
    expect((await app.inject({ method: "GET", url: path, headers: { "accept-language": "ar" } })).body).toContain("اكتب تقييماً على Google");
    // The web card links to the latest visit's page (a button-shaped link since Step 8; same text and target).
    expect((await app.inject({ method: "GET", url: `/c/${secret}?lang=en` })).body).toContain(`<a class="link-button" href="${path}?lang=en">Tell the café</a>`);
    // Emptied: no link again.
    expect((await as("PATCH", "/api/cafe", { googleReviewUrl: "" })).json<{ cafe: { googleReviewUrl: string | null } }>().cafe.googleReviewUrl).toBeNull();
  });

  it("sends one private message per visit to the owner's inbox, which marks it read (AC 37)", async () => {
    const { app, path, as } = await askedCard();
    const send = (message: string) => app.inject({ method: "POST", url: path, ...formBody({ message, lang: "en" }) });
    const empty = await send("   ");
    expect(empty.statusCode).toBe(400);
    expect(empty.body).toContain("Write a message before you send it.");
    const tooLong = await send("a".repeat(2001));
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.body).toContain("Keep your message to 2,000 characters.");
    // Kept as written, the text escaped on the page it is shown on.
    expect(tooLong.body).toContain(`>${"a".repeat(2001)}</textarea>`);

    const sent = await send("The croissant was cold.\r\nThe latte was great <3");
    expect(sent.statusCode).toBe(303);
    expect(sent.headers.location).toBe(`${path}?lang=en&sent=1`);
    expect((await app.inject({ method: "GET", url: String(sent.headers.location) })).body).toContain("Thank you. Your message is with the café.");
    // Once per visit: a second message is not taken.
    const again = await send("Another one");
    expect(again.statusCode).toBe(200);
    expect(again.body).toContain("You already sent a message about this visit.");

    const inbox = await as("GET", "/api/feedback");
    expect(inbox.statusCode).toBe(200);
    const body = inbox.json<{ items: { id: string; message: string; read: boolean; visitedAt: string }[]; unread: number; more: boolean }>();
    expect(body).toMatchObject({ unread: 1, more: false, items: [{ message: "The croissant was cold.\nThe latte was great <3", read: false }] });
    const [item] = body.items;
    expect(new Date(item?.visitedAt ?? 0).getTime()).toBeLessThan(Date.now() - 2 * 60 * 60 * 1000);
    // The visit's hour only, so the message cannot be matched to who came in when.
    expect(item?.visitedAt).toMatch(/T\d{2}:00:00\.000Z$/);
    expect((await as("POST", `/api/feedback/${item?.id ?? ""}/read`)).json()).toEqual({ read: true });
    expect((await as("GET", "/api/feedback")).json<{ unread: number; items: { read: boolean }[] }>()).toMatchObject({ unread: 0, items: [{ read: true }] });
    expect((await as("POST", `/api/feedback/${randomUUID()}/read`)).statusCode).toBe(404);
  });

  it("is rate-limited per address", async () => {
    const { app, path } = await askedCard();
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      expect((await app.inject({ method: "POST", url: path, ...formBody({ message: "", lang: "en" }) })).statusCode).toBe(400);
    }
    const blocked = await app.inject({ method: "POST", url: path, ...formBody({ message: "Fake feedback", lang: "en" }) });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect(blocked.body).toContain("Too many attempts.");
    // Other addresses are not blocked by this one.
    expect((await app.inject({ method: "POST", url: path, remoteAddress: "198.51.100.77", ...formBody({ message: "Fake feedback", lang: "en" }) })).statusCode).toBe(303);
  });

  it("takes a message of the longest length in Arabic", async () => {
    const { app, path, as } = await askedCard();
    const sent = await app.inject({ method: "POST", url: path, ...formBody({ message: "ق".repeat(2000), lang: "ar" }) });
    expect(sent.statusCode).toBe(303);
    expect((await as("GET", "/api/feedback")).json<{ items: { message: string }[] }>().items[0]?.message).toHaveLength(2000);
  });

  it("tells a message that lost the race to another for the same visit that one was already sent, never thanks it", async () => {
    const { app, path, as, card } = await askedCard();
    // Another message for this visit, not yet committed: the post below passes its check, then waits on it as it inserts.
    await context.admin.query("BEGIN");
    await context.admin.query("INSERT INTO app.feedback (cafe_id, request_id, message) SELECT cafe_id, id, 'Fake first message' FROM app.feedback_requests WHERE card_id = $1", [card?.id]);
    const second = app.inject({ method: "POST", url: path, ...formBody({ message: "Fake second message", lang: "en" }) });
    for (let tries = 0; tries < 100; tries += 1) {
      const { rows } = await context.admin.query<{ waiting: number }>("SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted");
      if ((rows[0]?.waiting ?? 0) > 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await context.admin.query("COMMIT");
    const response = await second;
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("You already sent a message about this visit.");
    expect((await as("GET", "/api/feedback")).json<{ items: { message: string }[] }>().items).toMatchObject([{ message: "Fake first message" }]);
  });

  it("closes a visit's link 30 days after it, so an old pass cannot fill the inbox", async () => {
    const { app, path, as, card } = await askedCard();
    const age = (days: number) => context.admin.query("UPDATE app.feedback_requests SET created_at = now() - make_interval(days => $1) WHERE card_id = $2", [days, card?.id]);
    const send = () => app.inject({ method: "POST", url: path, ...formBody({ message: "Fake feedback", lang: "en" }) });
    await age(31);
    const page = await app.inject({ method: "GET", url: `${path}?lang=en` });
    expect(page.statusCode).toBe(410);
    expect(page.body).toContain("more than 30 days ago");
    expect(page.body).not.toContain("<textarea");
    expect((await app.inject({ method: "GET", url: path, headers: { "accept-language": "ar" } })).body).toContain("أكثر من 30 يوماً");
    expect((await send()).statusCode).toBe(410);
    expect((await as("GET", "/api/feedback")).json<{ items: unknown[] }>().items).toEqual([]);
    await age(29);
    expect((await app.inject({ method: "GET", url: `${path}?lang=en` })).body).toContain("<textarea");
    expect((await send()).statusCode).toBe(303);
    // Answered, then closed: still thanks, not "closed".
    await age(31);
    expect((await app.inject({ method: "GET", url: `${path}?lang=en` })).body).toContain("You already sent a message about this visit.");
  });

  it("refuses a link that does not verify or another café's request, and deletes feedback with the card (AC 9)", async () => {
    const first = await askedCard();
    const second = await askedCard();
    const [cafe = "", request = "", keyId = "", mac = ""] = first.path.slice(3).split(".");
    // Another café's id with this request's signature, a changed signature, nonsense.
    for (const token of [`${second.path.slice(3).split(".")[0] ?? ""}.${request}.${keyId}.${mac}`, `${cafe}.${request}.${keyId}.${"A".repeat(22)}`, "nope"]) {
      const response = await first.app.inject({ method: "GET", url: `/f/${token}?lang=en` });
      expect(response.statusCode).toBe(404);
    }
    // The second café's owner sees none of the first café's messages, which its own owner sees.
    expect((await first.app.inject({ method: "POST", url: first.path, ...formBody({ message: "Fake feedback", lang: "en" }) })).statusCode).toBe(303);
    expect((await first.as("GET", "/api/feedback")).json<{ items: unknown[] }>().items).toMatchObject([{ message: "Fake feedback" }]);
    expect((await second.as("GET", "/api/feedback")).json<{ items: unknown[] }>().items).toEqual([]);
    expect((await context.admin.query("SELECT 1 FROM app.feedback WHERE cafe_id = $1", [first.owner.cafeId])).rowCount).toBe(1);
    // Deleting the card deletes its request and message; the link then finds nothing.
    await first.app.inject({ method: "POST", url: `/c/${first.secret}/delete`, ...formBody({ confirm: "yes", lang: "en" }) });
    const left = await context.admin.query("SELECT 1 FROM app.feedback_requests WHERE card_id = $1 UNION ALL SELECT 1 FROM app.feedback WHERE cafe_id = $2", [first.card?.id, first.owner.cafeId]);
    expect(left.rowCount).toBe(0);
    expect((await first.app.inject({ method: "GET", url: `${first.path}?lang=en` })).statusCode).toBe(404);
    expect((await first.as("GET", "/api/feedback")).json<{ items: unknown[] }>().items).toEqual([]);
  });
});
