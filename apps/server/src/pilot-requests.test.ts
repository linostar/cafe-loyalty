import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { BackgroundTasks } from "./background.js";
import type { EmailMessage, Mailer } from "./mailer.js";
import { parsePilotRequest, pilotRequestEmail, pilotRequests } from "./pilot-requests.js";

const LANDING = "https://landing.example.test";
const FORM = { lang: "en", cafe: "Café Test", name: "Test Owner", phone: "70 123 456", email: "", city: "Tripoli", message: "", website: "" };

class FakeMailer implements Mailer {
  readonly sent: EmailMessage[] = [];
  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
  verify(): Promise<void> {
    return Promise.resolve();
  }
  close(): void {
    // Nothing to release.
  }
}

const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function pilotApp() {
  const logs: string[] = [];
  const app = buildApp({ logLevel: "info", logDestination: { write: (chunk) => logs.push(chunk) } });
  const mailer = new FakeMailer();
  const background = new BackgroundTasks(app.log);
  await app.register(pilotRequests, { mailer, background, landingUrl: LANDING, recipient: "pilots@example.test" });
  apps.push(app);
  // `origin` null: a post without an Origin header.
  const post = (form: Record<string, string>, origin: string | null = LANDING) =>
    app.inject({
      method: "POST",
      url: "/pilot-request",
      headers: { "content-type": "application/x-www-form-urlencoded", ...(origin === null ? {} : { origin }) },
      payload: new URLSearchParams(form).toString(),
    });
  return { post, mailer, background, logs };
}

describe("parsePilotRequest", () => {
  it("takes a request in either language, with its mobile number as E.164 and its fields on one line", () => {
    expect(parsePilotRequest({ ...FORM, lang: "ar", cafe: " مقهى​  التجربة\n", email: " Owner@Example.test ", message: "Two\r\nlines" })).toEqual({
      lang: "ar",
      cafe: "مقهى التجربة",
      name: "Test Owner",
      phone: "+96170123456",
      email: "owner@example.test",
      city: "Tripoli",
      message: "Two\nlines",
    });
    expect(parsePilotRequest({ ...FORM, city: "  " })).toMatchObject({ email: null, city: null, message: null });
  });

  it("refuses a missing or malformed field and anything too long", () => {
    for (const change of [{ cafe: " " }, { name: "" }, { phone: "12" }, { email: "not an email" }, { cafe: "x".repeat(121) }, { city: "x".repeat(61) }, { message: "x".repeat(1001) }]) {
      expect(parsePilotRequest({ ...FORM, ...change }), JSON.stringify(change)).toBeNull();
    }
  });

  it("emails plain text, its subject on one line", () => {
    const email = pilotRequestEmail("pilots@example.test", { lang: "en", cafe: "Café Test", name: "Test Owner", phone: "+96170123456", email: null, city: null, message: "Hi" });
    expect(email).toMatchObject({ to: "pilots@example.test", subject: "Pilot request: Café Test" });
    expect(email.text).toContain("Mobile (WhatsApp): +96170123456");
    expect(email.text).toContain("Message:\nHi");
  });
});

describe("POST /pilot-request", () => {
  it("emails a valid request in the background and sends the browser to the thanks page in its language, logging none of it", async () => {
    const { post, mailer, background, logs } = await pilotApp();
    const english = await post(FORM);
    expect(english.statusCode).toBe(303);
    expect(english.headers.location).toBe(`${LANDING}/thanks.html`);
    expect((await post({ ...FORM, lang: "ar" })).headers.location).toBe(`${LANDING}/ar/thanks.html`);
    await background.drain();
    expect(mailer.sent.map((message) => message.to)).toEqual(["pilots@example.test", "pilots@example.test"]);
    for (const secret of ["Test Owner", "70123456", "Tripoli"]) {
      expect(logs.join("")).not.toContain(secret);
    }
  });

  it("sends a malformed request to the sorry page without an email", async () => {
    const { post, mailer, background } = await pilotApp();
    const response = await post({ ...FORM, lang: "ar", phone: "" });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(`${LANDING}/ar/sorry.html`);
    await background.drain();
    expect(mailer.sent).toEqual([]);
  });

  it("thanks a bot that filled in the hidden field, and sends nothing", async () => {
    const { post, mailer, background } = await pilotApp();
    expect((await post({ ...FORM, website: "https://spam.example.test" })).headers.location).toBe(`${LANDING}/thanks.html`);
    await background.drain();
    expect(mailer.sent).toEqual([]);
  });

  it("takes posts only from the landing page", async () => {
    const { post, mailer, background } = await pilotApp();
    for (const origin of [null, "null", "https://evil.example.test", "http://landing.example.test"]) {
      expect((await post(FORM, origin)).statusCode, String(origin)).toBe(403);
    }
    await background.drain();
    expect(mailer.sent).toEqual([]);
  });

  it("takes at most 5 requests an hour from one address", async () => {
    const { post, mailer, background } = await pilotApp();
    for (let sent = 0; sent < 5; sent += 1) {
      expect((await post(FORM)).headers.location).toBe(`${LANDING}/thanks.html`);
    }
    expect((await post(FORM)).headers.location).toBe(`${LANDING}/sorry.html`);
    await background.drain();
    expect(mailer.sent).toHaveLength(5);
  });
});
