import { createHmac } from "node:crypto";
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
    expect(String(arabic.headers["content-security-policy"])).toMatch(/^default-src 'none'; style-src 'sha256-[A-Za-z0-9+/=]+'; img-src data:;/);
    expect(arabic.body).not.toContain("<script");
    const english = await app.inject({ method: "GET", url: `/join/${code}?lang=en`, headers: { "accept-language": "ar" } });
    expect(english.body).toContain('<html lang="en" dir="ltr">');
    expect(english.body).toContain("Get your loyalty card at Café Test");
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

  it("is rate-limited per address and per café code", async () => {
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

describe("web card", () => {
  it("shows the café, the stamps and the QR, with no script and a strict policy (AC 7)", async () => {
    const { app, code } = await cafeWithJoinCode();
    const secret = secretOf(await join(app, code, "70 123 456"));
    const card = await app.inject({ method: "GET", url: `/c/${secret}?lang=en` });
    expect(card.statusCode).toBe(200);
    expect(card.body).toContain("Your card at Café Test");
    expect(card.body).toContain("0 stamps");
    expect(card.body).toMatch(/<img class="qr" src="data:image\/svg\+xml;charset=utf-8,[^"]+" alt="Your card's QR code/);
    expect(card.body).not.toContain("<script");
    expect(card.headers).toMatchObject({ "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" });
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
    const here = secretOf(await join(first.app, first.code, "70 555 666"));
    const there = secretOf(await join(second.app, second.code, "70 555 666"));
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
  async function withEmailCards() {
    const first = await cafeWithJoinCode();
    const second = await cafeWithJoinCode();
    const secrets = [secretOf(await join(first.app, first.code, "70 777 888")), secretOf(await join(second.app, second.code, "70 777 888"))];
    for (const [app, secret] of [
      [first.app, secrets[0]],
      [second.app, secrets[1]],
    ] as const) {
      await app.inject({ method: "POST", url: `/c/${secret ?? ""}/email`, ...formBody({ email: "rana@example.com" }) });
    }
    return { first, secrets };
  }

  async function requestLink(h: Harness, email: string): Promise<LightMyRequestResponse> {
    const response = await h.app.inject({ method: "POST", url: "/recover", ...formBody({ email, lang: "en" }) });
    await h.background.drain();
    return response;
  }

  const tokenOf = (h: Harness, index = 0): string => new RegExp(`${PUBLIC_URL}/r/([A-Za-z0-9_-]{43})`).exec(h.mailer.sent[index]?.text ?? "")?.[1] ?? "missing";

  it("answers known and unknown emails the same way and emails only a known one", async () => {
    const { first } = await withEmailCards();
    const known = await requestLink(first, "rana@example.com");
    const unknown = await requestLink(first, "nobody@example.com");
    expect(known.statusCode).toBe(200);
    expect(known.body).toBe(unknown.body);
    expect(first.mailer.sent).toHaveLength(1);
    expect(first.mailer.sent[0]?.to).toBe("rana@example.com");
  });

  it("restores every card with that email on a new epoch, once, and the old links and QR codes stop working (AC 8)", async () => {
    const { first, secrets } = await withEmailCards();
    await requestLink(first, "rana@example.com");
    const token = tokenOf(first);
    const before = await Promise.all(secrets.map((secret) => cardRow(secret)));
    // Opening the link does not use it.
    for (let view = 0; view < 2; view += 1) {
      expect((await first.app.inject({ method: "GET", url: `/r/${token}?lang=en` })).body).toContain("Restore my cards");
    }
    const restored = await first.app.inject({ method: "POST", url: `/r/${token}`, ...formBody({ action: "restore", lang: "en" }) });
    expect(restored.statusCode).toBe(200);
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
    const { first, secrets } = await withEmailCards();
    const customerId = (await cardRow(secrets[0] ?? ""))?.customer_id;
    await requestLink(first, "rana@example.com");
    const deleted = await first.app.inject({ method: "POST", url: `/r/${tokenOf(first)}`, ...formBody({ action: "delete", lang: "en" }) });
    expect(deleted.body).toContain("Your card and its data are deleted.");
    for (const secret of secrets) {
      expect(await cardRow(secret)).toBeUndefined();
    }
    expect((await context.admin.query("SELECT 1 FROM app.customers WHERE id = $1", [customerId])).rowCount).toBe(0);
  });

  it("keeps one live link per email even when requests race", async () => {
    const { first } = await withEmailCards();
    await Promise.all([1, 2, 3].map(() => first.app.inject({ method: "POST", url: "/recover", remoteAddress: "198.51.100.30", ...formBody({ email: "rana@example.com" }) })));
    await first.background.drain();
    const { rows } = await context.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM app.customer_recovery_tokens");
    expect(rows[0]?.n).toBe(1);
  });

  it("refuses an expired link and keeps only the newest", async () => {
    const { first } = await withEmailCards();
    await requestLink(first, "rana@example.com");
    await requestLink(first, "rana@example.com");
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
