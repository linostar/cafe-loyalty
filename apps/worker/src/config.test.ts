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
