import nodemailer from "nodemailer";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: EmailMessage): Promise<void>;
  /** Checks that the SMTP server accepts a connection (and the login, if any). */
  verify(): Promise<void>;
  close(): void;
}

export interface SmtpSettings {
  host: string;
  port: number;
  /** true for implicit TLS (port 465); false sends over STARTTLS, which is then required whenever there is a login. */
  secure: boolean;
  /** Login, or undefined for a local mail catcher without one (development only; config enforces that). */
  auth: { user: string; password: string } | undefined;
  from: string;
}

/**
 * The longest one email may take end to end, below the server's default shutdown timeout (10 s), so shutdown never
 * abandons a send halfway. The transport's own timeouts each cover only one phase.
 */
export const EMAIL_SEND_TIMEOUT_MS = 8_000;

/** Raised for a failed send. It carries only SMTP codes, because SMTP error text often quotes the recipient. */
export class EmailDeliveryError extends Error {
  readonly smtpCode: string | undefined;
  readonly responseCode: number | undefined;

  constructor(cause: unknown) {
    const { code, responseCode } = (cause ?? {}) as { code?: unknown; responseCode?: unknown };
    const smtpCode = typeof code === "string" ? code : undefined;
    const response = typeof responseCode === "number" ? responseCode : undefined;
    super(`Sending an email failed (${smtpCode ?? "no code"}, SMTP ${response === undefined ? "no response" : String(response)}).`);
    this.name = "EmailDeliveryError";
    this.smtpCode = smtpCode;
    this.responseCode = response;
  }
}

export function createSmtpMailer(settings: SmtpSettings, sendTimeoutMs = EMAIL_SEND_TIMEOUT_MS): Mailer {
  const transport = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    // Never send a login (or a reset link) in clear text: STARTTLS is required whenever there is a login.
    requireTLS: !settings.secure && settings.auth !== undefined,
    ...(settings.auth === undefined ? {} : { auth: { user: settings.auth.user, pass: settings.auth.password } }),
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 7_000,
  });
  return {
    async send(message) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new EmailDeliveryError({ code: "ESENDTIMEOUT" }));
        }, sendTimeoutMs);
      });
      try {
        await Promise.race([transport.sendMail({ from: settings.from, ...message }), timeout]);
      } catch (error) {
        throw error instanceof EmailDeliveryError ? error : new EmailDeliveryError(error);
      } finally {
        clearTimeout(timer);
      }
    },
    async verify() {
      try {
        await transport.verify();
      } catch (error) {
        throw new EmailDeliveryError(error);
      }
    },
    close() {
      transport.close();
    },
  };
}
