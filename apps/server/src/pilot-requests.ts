import { normalizePhoneInput, ownerEmailSchema, parseHolderName, PRODUCT_NAME } from "@cafe-loyalty/shared";
import type { FastifyBaseLogger, FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { BackgroundTasks } from "./background.js";
import type { EmailMessage, Mailer } from "./mailer.js";
import { clientKey, RateLimiter } from "./rate-limit.js";

const HOUR_MS = 60 * 60 * 1000;

export interface PilotRequestOptions {
  mailer: Mailer;
  background: BackgroundTasks;
  /** The landing page's origin (LANDING_URL): the only page that may post the form, and where its answers are. */
  landingUrl: string;
  /** Who reads the requests (PILOT_REQUEST_EMAIL). */
  recipient: string;
}

/** A request as sent on: every field one line of plain text (the message keeps its line breaks), checked for length. */
export interface PilotRequest {
  lang: "ar" | "en";
  cafe: string;
  name: string;
  /** E.164. */
  phone: string;
  email: string | null;
  city: string | null;
  message: string | null;
}

/** One line: control, format and separator characters out, spaces collapsed. */
const oneLine = (value: string): string =>
  value
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

const within = (value: string, max: number): boolean => Array.from(value).length <= max;

/**
 * The form as a request, or null when a required field is missing or any field is too long or malformed. The
 * landing page checks the same in the browser (required, maxlength, type), so null means a browser that skipped
 * those checks or a hand-made post.
 */
export function parsePilotRequest(form: Readonly<Record<string, string>>): PilotRequest | null {
  const cafe = oneLine(form.cafe ?? "");
  const name = parseHolderName(form.name ?? "");
  const phone = normalizePhoneInput(form.phone ?? "");
  const emailText = (form.email ?? "").trim();
  const email = emailText === "" ? undefined : ownerEmailSchema.safeParse(emailText);
  const city = oneLine(form.city ?? "");
  const message = (form.message ?? "")
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\p{Cf}\p{Zl}\p{Zp}]|[^\P{Cc}\n]/gu, " ")
    .trim();
  if (cafe === "" || !within(cafe, 120) || name === null || phone === null || !within(city, 60) || !within(message, 1000)) {
    return null;
  }
  if (email !== undefined && !email.success) {
    return null;
  }
  return {
    lang: form.lang === "ar" ? "ar" : "en",
    cafe,
    name,
    phone,
    email: email === undefined ? null : email.data,
    city: city === "" ? null : city,
    message: message === "" ? null : message,
  };
}

/** The email to the operator: plain text, so nothing in the form is ever markup. */
export function pilotRequestEmail(to: string, request: PilotRequest): EmailMessage {
  const lines = [
    `A café asked to join the ${PRODUCT_NAME} pilot from the landing page.`,
    "",
    `Café: ${request.cafe}`,
    `Name: ${request.name}`,
    `Mobile (WhatsApp): ${request.phone}`,
    `Email: ${request.email ?? "(not given)"}`,
    `City or area: ${request.city ?? "(not given)"}`,
    `Page language: ${request.lang === "ar" ? "Arabic" : "English"}`,
    "",
    request.message === null ? "No message." : `Message:\n${request.message}`,
  ];
  return { to, subject: `Pilot request: ${request.cafe}`, text: lines.join("\n") };
}

/**
 * `POST /pilot-request`: the landing page's "Request a pilot" form (a plain HTML form on another site, so no
 * script and no CORS). Only a post whose Origin is the landing page's is taken. A valid request is emailed to the
 * operator in the background and never stored or logged; the reply is a 303 back to the landing page's thanks or
 * sorry page in the form's language. Registered on its own, outside the customer pages, whose posts must be
 * same-origin. A filled-in hidden field (bots) gets the thanks page and sends nothing.
 */
export const pilotRequests: FastifyPluginCallback<PilotRequestOptions> = (app, options, done) => {
  // ponytail: in-memory limits, like the customer pages'; enough to keep one sender, or a burst, out of the inbox.
  const perAddress = new RateLimiter(5, HOUR_MS);
  const overall = new RateLimiter(60, HOUR_MS);
  const landing = new URL(options.landingUrl).origin;
  const answer = (reply: FastifyReply, lang: "ar" | "en", page: "thanks" | "sorry") =>
    reply
      .code(303)
      .header("cache-control", "no-store")
      .header("location", `${landing}/${lang === "ar" ? "ar/" : ""}${page}.html`)
      .send();

  // 16 KB: a 1,000-character Arabic message takes about 6 KB once percent-encoded.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 16 * 1024 }, (_request, body, next) => {
    next(null, Object.fromEntries(new URLSearchParams(typeof body === "string" ? body : body.toString("utf8"))));
  });

  async function send(request: PilotRequest, log: FastifyBaseLogger): Promise<void> {
    try {
      await options.mailer.send(pilotRequestEmail(options.recipient, request));
    } catch (error) {
      log.error({ err: error }, "pilot request email failed");
      return;
    }
    log.info("pilot request email sent");
  }

  app.post("/pilot-request", (request: FastifyRequest, reply) => {
    const form: Record<string, string> =
      typeof request.body === "object" && request.body !== null
        ? Object.fromEntries(Object.entries(request.body).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
        : {};
    const lang = form.lang === "ar" ? "ar" : "en";
    if (request.headers.origin !== landing) {
      return reply.code(403).header("cache-control", "no-store").type("text/plain; charset=utf-8").send("Send this form from the landing page.");
    }
    if ((form.website ?? "") !== "") {
      request.log.info("pilot request dropped: hidden field filled in");
      return answer(reply, lang, "thanks");
    }
    const parsed = parsePilotRequest(form);
    if (parsed === null) {
      return answer(reply, lang, "sorry");
    }
    if (perAddress.hit(clientKey(request.ip)) > 0 || overall.hit("all") > 0) {
      request.log.info("pilot request refused: rate limit reached");
      return answer(reply, lang, "sorry");
    }
    options.background.run("pilot-request-email", () => send(parsed, request.log));
    return answer(reply, lang, "thanks");
  });
  done();
};
