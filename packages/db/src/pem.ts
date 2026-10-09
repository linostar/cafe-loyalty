import { X509Certificate, createPrivateKey } from "node:crypto";
import { z } from "zod";

/**
 * A setting holding a PEM certificate or private key base64-encoded on one line (base64 -w0), as the server's and the
 * worker's Apple Wallet settings do. Parses to the PEM; the error never echoes the value.
 */
export const base64PemSchema = (kind: "certificate" | "private key") =>
  z.string().transform((value, context) => {
    const pem = Buffer.from(value, "base64").toString("utf8");
    try {
      if (kind === "certificate") {
        new X509Certificate(pem);
      } else {
        createPrivateKey(pem);
      }
    } catch {
      context.addIssue({ code: "custom", message: `Use the ${kind} as PEM, base64-encoded on one line (base64 -w0).` });
      return z.NEVER;
    }
    return pem;
  });

/** Whether a PEM private key is the one of a PEM certificate. */
export const keyFitsCertificate = (certificate: string, privateKey: string): boolean =>
  new X509Certificate(certificate).checkPrivateKey(createPrivateKey(privateKey));
