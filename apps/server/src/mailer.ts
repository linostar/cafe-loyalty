import nodemailer from "nodemailer";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: EmailMessage): Promise<void>;
  close(): void;
}

export interface SmtpSettings {
  host: string;
  port: number;
  /** true for implicit TLS (port 465); false sends over STARTTLS, which is then required. */
  secure: boolean;
  user: string;
  password: string;
  from: string;
}

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

export function createSmtpMailer(settings: SmtpSettings): Mailer {
  const transport = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    requireTLS: !settings.secure,
    auth: { user: settings.user, pass: settings.password },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    async send(message) {
      try {
        await transport.sendMail({ from: settings.from, ...message });
      } catch (error) {
        throw new EmailDeliveryError(error);
      }
    },
    close() {
      transport.close();
    },
  };
}
