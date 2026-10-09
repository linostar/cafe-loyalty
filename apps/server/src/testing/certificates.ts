import { generateKeyPairSync } from "node:crypto";
import forge from "node-forge";
import type { ApplePassConfig } from "../apple-pass.js";

/** A self-signed certificate for `commonName` and its private key, as PEM: fake credentials for tests only. */
export function selfSigned(commonName: string): { certificate: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ type: "spki", format: "pem" }).toString());
  certificate.serialNumber = "01";
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = new Date(Date.now() + 3_600_000);
  certificate.setSubject([{ name: "commonName", value: commonName }]);
  certificate.setIssuer([{ name: "commonName", value: commonName }]);
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  certificate.sign(forge.pki.privateKeyFromPem(pem), forge.md.sha256.create());
  return { certificate: forge.pki.certificateToPem(certificate), privateKey: pem };
}

/** Apple Wallet settings with self-signed stand-ins for the pass type and WWDR certificates. */
export function testApplePasses(): ApplePassConfig {
  const signer = selfSigned("Pass Type ID: pass.example.test");
  return {
    passTypeId: "pass.example.test",
    teamId: "TEAMID1234",
    certificates: { signerCert: signer.certificate, signerKey: signer.privateKey, wwdr: selfSigned("Test WWDR").certificate },
  };
}

/** The files of a .pkpass: a zip of stored (uncompressed) entries, as passkit-generator writes it. */
export function unzipPass(zip: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  // Local file headers until the central directory.
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const method = zip.readUInt16LE(offset + 8);
    const size = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    if (method !== 0) {
      throw new Error("Expected stored zip entries.");
    }
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const start = offset + 30 + nameLength + extraLength;
    files.set(name, zip.subarray(start, start + size));
    offset = start + size;
  }
  return files;
}
