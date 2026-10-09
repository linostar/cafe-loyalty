import { generateKeyPairSync } from "node:crypto";
import { createSecureServer, type Http2SecureServer, type Http2ServerRequest, type Http2ServerResponse } from "node:http2";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";
import forge from "node-forge";
import { afterEach, describe, expect, it } from "vitest";
import { createApnsPusher, type PassPusher } from "./apns.js";

/** A self-signed certificate for `commonName` (also valid for localhost) and its key, as PEM. */
function selfSigned(commonName: string): { certificate: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ type: "spki", format: "pem" }).toString());
  certificate.serialNumber = "01";
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = new Date(Date.now() + 3_600_000);
  certificate.setSubject([{ name: "commonName", value: commonName }]);
  certificate.setIssuer([{ name: "commonName", value: commonName }]);
  certificate.setExtensions([{ name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] }]);
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  certificate.sign(forge.pki.privateKeyFromPem(pem), forge.md.sha256.create());
  return { certificate: forge.pki.certificateToPem(certificate), privateKey: pem };
}

const apns = selfSigned("APNs test");
const passType = selfSigned("Pass Type ID: pass.example.test");
const TOKEN = "ab".repeat(32);

interface Received {
  path: string;
  topic: string | undefined;
  body: string;
  /** The common name of the client certificate the connection presented. */
  client: string;
}

let server: Http2SecureServer | undefined;
let pusher: PassPusher | undefined;

/** A local APNs (on `port`, or any free one) that answers each request with `answer` and records what it received. */
async function fakeApns(answer: (response: Http2ServerResponse) => void, port = 0): Promise<{ origin: string; received: Received[] }> {
  const received: Received[] = [];
  server = createSecureServer({ cert: apns.certificate, key: apns.privateKey, ca: passType.certificate, requestCert: true, rejectUnauthorized: true });
  server.on("request", (request: Http2ServerRequest, response: Http2ServerResponse) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      const peer = (request.socket as TLSSocket).getPeerCertificate();
      received.push({ path: request.url, topic: request.headers["apns-topic"] as string | undefined, body, client: String(peer.subject.CN) });
      answer(response);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(port, "127.0.0.1", resolve);
  });
  return { origin: `https://localhost:${String((server.address() as AddressInfo).port)}`, received };
}

function client(origin: string, timeoutMs = 2_000): PassPusher {
  pusher = createApnsPusher({ ...passType, topic: "pass.example.test", origin, ca: apns.certificate, timeoutMs });
  return pusher;
}

const reply = (status: number, body?: object) => (response: Http2ServerResponse) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body === undefined ? "" : JSON.stringify(body));
};

afterEach(async () => {
  pusher?.close();
  pusher = undefined;
  await new Promise((resolve) => {
    if (server === undefined) {
      resolve(undefined);
      return;
    }
    server.close(resolve);
  });
  server = undefined;
});

describe("APNs pusher", () => {
  it("sends Wallet's empty notification for the pass type topic, signed in with the pass type certificate", async () => {
    const { origin, received } = await fakeApns(reply(200));
    const apnsClient = client(origin);
    expect(await apnsClient.push(TOKEN)).toBe("sent");
    // A second push reuses the connection.
    expect(await apnsClient.push(TOKEN)).toBe("sent");
    expect(received).toEqual([
      { path: `/3/device/${TOKEN}`, topic: "pass.example.test", body: "{}", client: "Pass Type ID: pass.example.test" },
      { path: `/3/device/${TOKEN}`, topic: "pass.example.test", body: "{}", client: "Pass Type ID: pass.example.test" },
    ]);
  });

  it("reports a device APNs says is gone (410) or whose token can never work", async () => {
    const answers = [reply(410, { reason: "Unregistered" }), reply(400, { reason: "BadDeviceToken" })];
    const { origin } = await fakeApns((response) => {
      answers.shift()?.(response);
    });
    const apnsClient = client(origin);
    expect(await apnsClient.push(TOKEN)).toBe("unregistered");
    expect(await apnsClient.push(TOKEN)).toBe("unregistered");
  });

  it("fails a token for another topic, which a worker with the wrong pass type id gets for every device", async () => {
    const { origin } = await fakeApns(reply(400, { reason: "DeviceTokenNotForTopic" }));
    await expect(client(origin).push(TOKEN)).rejects.toThrow("APNs answered 400 (DeviceTokenNotForTopic).");
  });

  it("fails any other answer, naming the status and reason but never the token", async () => {
    const { origin } = await fakeApns(reply(429, { reason: "TooManyRequests" }));
    const failure = await client(origin)
      .push(TOKEN)
      .then(
        () => undefined,
        (error: unknown) => error as Error,
      );
    expect(failure?.message).toBe("APNs answered 429 (TooManyRequests).");
    expect(failure?.message).not.toContain(TOKEN);
  });

  it("gives up on a push APNs does not answer in time", async () => {
    const { origin } = await fakeApns(() => undefined);
    await expect(client(origin, 300).push(TOKEN)).rejects.toThrow("APNs did not answer within 300 ms.");
  });

  it("fails a push when APNs cannot be reached, then connects again for the next one", async () => {
    const { origin } = await fakeApns(reply(200));
    const port = new URL(origin).port;
    await new Promise((resolve) => server?.close(resolve));
    server = undefined;
    const apnsClient = client(origin);
    await expect(apnsClient.push(TOKEN)).rejects.toThrow();
    // The same address, listening again.
    await fakeApns(reply(200), Number(port));
    expect(await apnsClient.push(TOKEN)).toBe("sent");
  });
});
