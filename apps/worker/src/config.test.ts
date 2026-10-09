import { generateKeyPairSync } from "node:crypto";
import { EnvError } from "@cafe-loyalty/shared";
import forge from "node-forge";
import { describe, expect, it } from "vitest";
import { loadWorkerConfig } from "./config.js";

const valid = { NODE_ENV: "test", LOG_LEVEL: "info", DATABASE_URL: "postgres://app:secret@127.0.0.1:5432/cafe_loyalty" };

/** A self-signed certificate and its key, base64-encoded PEM as the variables hold them. */
function selfSigned(): { certificate: string; privateKey: string; pem: { certificate: string; privateKey: string } } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ type: "spki", format: "pem" }).toString());
  certificate.serialNumber = "01";
  certificate.validity.notBefore = new Date();
  certificate.validity.notAfter = new Date(Date.now() + 3_600_000);
  certificate.setSubject([{ name: "commonName", value: "Pass Type ID: pass.example.test" }]);
  certificate.setIssuer([{ name: "commonName", value: "Pass Type ID: pass.example.test" }]);
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  certificate.sign(forge.pki.privateKeyFromPem(keyPem), forge.md.sha256.create());
  const certificatePem = forge.pki.certificateToPem(certificate);
  return {
    certificate: Buffer.from(certificatePem).toString("base64"),
    privateKey: Buffer.from(keyPem).toString("base64"),
    pem: { certificate: certificatePem, privateKey: keyPem },
  };
}

describe("loadWorkerConfig", () => {
  it("runs without Google Wallet, or with its settings, the card QR keys and the server's public address", () => {
    const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const key = Buffer.alloc(32, 1);
    const google = {
      GOOGLE_WALLET_ISSUER_ID: "3388000000012345678",
      GOOGLE_WALLET_SERVICE_ACCOUNT: Buffer.from(JSON.stringify({ client_email: "wallet@example.iam.gserviceaccount.com", private_key: pem })).toString("base64"),
      CARD_QR_KEYS: `q1:${key.toString("base64")}`,
      PUBLIC_URL: "https://card.example.com",
    };
    expect(loadWorkerConfig(valid).googlePasses).toBeUndefined();
    // The server's own variables, shared through one .env, leave Google Wallet off.
    expect(loadWorkerConfig({ ...valid, CARD_QR_KEYS: google.CARD_QR_KEYS, PUBLIC_URL: google.PUBLIC_URL }).googlePasses).toBeUndefined();
    expect(loadWorkerConfig({ ...valid, ...google }).googlePasses).toEqual({
      serviceAccount: { email: "wallet@example.iam.gserviceaccount.com", privateKey: pem },
      settings: { issuerId: "3388000000012345678", publicUrl: "https://card.example.com", cardQr: { keys: [{ id: "q1", key }] } },
    });
    expect(() => loadWorkerConfig({ ...valid, ...google, CARD_QR_KEYS: undefined })).toThrow(/CARD_QR_KEYS: Set it as the server has it/);
    expect(() => loadWorkerConfig({ ...valid, ...google, GOOGLE_WALLET_SERVICE_ACCOUNT: undefined })).toThrow(/GOOGLE_WALLET_SERVICE_ACCOUNT: Set both/);
    expect(() => loadWorkerConfig({ ...valid, ...google, CARD_QR_KEYS: "q1:short" })).toThrow(/CARD_QR_KEYS: Use comma-separated/);
  });

  it("runs without Apple Wallet, or with all of its settings for APNs", () => {
    const signer = selfSigned();
    expect(loadWorkerConfig(valid).applePasses).toBeUndefined();
    expect(
      loadWorkerConfig({ ...valid, APPLE_PASS_TYPE_ID: "pass.example.test", APPLE_PASS_CERTIFICATE: signer.certificate, APPLE_PASS_KEY: signer.privateKey }).applePasses,
    ).toEqual({ topic: "pass.example.test", certificate: signer.pem.certificate, privateKey: signer.pem.privateKey });
  });

  it("refuses half the Apple settings, a key of another certificate and a value that is not PEM, without echoing it", () => {
    const signer = selfSigned();
    const other = selfSigned();
    expect(() => loadWorkerConfig({ ...valid, APPLE_PASS_TYPE_ID: "pass.example.test" })).toThrow(/APPLE_PASS_CERTIFICATE/);
    expect(() =>
      loadWorkerConfig({ ...valid, APPLE_PASS_TYPE_ID: "pass.example.test", APPLE_PASS_CERTIFICATE: signer.certificate, APPLE_PASS_KEY: other.privateKey }),
    ).toThrow(/APPLE_PASS_KEY: Use the private key/);
    const garbage = Buffer.from("not a certificate").toString("base64");
    try {
      loadWorkerConfig({ ...valid, APPLE_PASS_TYPE_ID: "pass.example.test", APPLE_PASS_CERTIFICATE: garbage, APPLE_PASS_KEY: signer.privateKey });
      expect.unreachable();
    } catch (error) {
      expect((error as EnvError).message).toContain("APPLE_PASS_CERTIFICATE");
      expect((error as EnvError).message).not.toContain(garbage);
    }
  });
});
