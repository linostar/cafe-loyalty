import { createServer, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { EmailDeliveryError, createSmtpMailer } from "./mailer.js";

describe("EmailDeliveryError", () => {
  it("keeps the SMTP codes and drops the text, which can quote the recipient", () => {
    const cause = Object.assign(new Error("Can't send mail - all recipients were rejected: 550 rana@example.com"), {
      code: "EENVELOPE",
      responseCode: 550,
    });
    const error = new EmailDeliveryError(cause);
    expect(error).toMatchObject({ smtpCode: "EENVELOPE", responseCode: 550 });
    expect(error.message).toBe("Sending an email failed (EENVELOPE, SMTP 550).");
    expect(JSON.stringify(error)).not.toContain("rana@example.com");
  });

  it("copes with a cause that has no codes", () => {
    expect(new EmailDeliveryError(undefined).message).toBe("Sending an email failed (no code, SMTP no response).");
  });
});

describe("createSmtpMailer", () => {
  it("gives up on a send that takes longer than its overall timeout", async () => {
    // An SMTP server that accepts the connection and never says a word.
    const sockets: Socket[] = [];
    const server = createServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const mailer = createSmtpMailer({ host: "127.0.0.1", port, secure: false, auth: undefined, from: "no-reply@example.com" }, 200);
    try {
      const started = Date.now();
      await expect(mailer.send({ to: "rana@example.com", subject: "s", text: "t" })).rejects.toMatchObject({ smtpCode: "ESENDTIMEOUT" });
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      mailer.close();
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
