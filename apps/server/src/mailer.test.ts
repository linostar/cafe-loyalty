import { describe, expect, it } from "vitest";
import { EmailDeliveryError } from "./mailer.js";

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
