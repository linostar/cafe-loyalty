import { connect, constants, type ClientHttp2Session } from "node:http2";

/** "unregistered": APNs says the device no longer takes this pass's pushes, so its registration can go (AC 12). */
export type PushResult = "sent" | "unregistered";

/** Sends Wallet's update notification to a device, which then fetches its changed passes from the web service. */
export interface PassPusher {
  push(pushToken: string): Promise<PushResult>;
  close(): void;
}

export interface ApnsOptions {
  /** The pass type certificate and its private key (PEM): APNs takes Wallet pushes over TLS client auth only. */
  certificate: string;
  privateKey: string;
  /** The pass type identifier, which is the notification's topic. */
  topic: string;
  /** Defaults to Apple's production service; Wallet has no sandbox. */
  origin?: string;
  /** Trusted roots for the origin, for tests; defaults to the system's. */
  ca?: string;
  timeoutMs?: number;
}

/**
 * APNs's 400 for a token that will never work. Not DeviceTokenNotForTopic: that one also answers a worker whose pass
 * type id differs from the server's, and must fail loudly rather than delete every registration.
 */
const DEAD_TOKEN_REASONS = new Set(["BadDeviceToken"]);

/**
 * An APNs client over one HTTP/2 connection, opened on the first push and again after it closes. Each push has a
 * timeout (AC 43). Errors never carry the push token, which must not reach the logs.
 */
export function createApnsPusher(options: ApnsOptions): PassPusher {
  const origin = options.origin ?? "https://api.push.apple.com";
  const timeoutMs = options.timeoutMs ?? 10_000;
  let session: ClientHttp2Session | undefined;

  const open = (): ClientHttp2Session => {
    if (session === undefined || session.closed || session.destroyed) {
      const opened = connect(origin, { cert: options.certificate, key: options.privateKey, ...(options.ca === undefined ? {} : { ca: options.ca }) });
      // A failed connection fails the pushes on it (each request reports its own error); the next push reconnects.
      opened.on("error", () => {
        opened.destroy();
      });
      session = opened;
    }
    return session;
  };

  return {
    push(pushToken) {
      return new Promise<PushResult>((resolve, reject) => {
        const request = open().request({
          ":method": "POST",
          ":path": `/3/device/${pushToken}`,
          "apns-topic": options.topic,
          "content-type": "application/json",
        });
        let status = 0;
        let body = "";
        request.setTimeout(timeoutMs, () => {
          request.close(constants.NGHTTP2_CANCEL);
          reject(new Error(`APNs did not answer within ${String(timeoutMs)} ms.`));
        });
        request.on("response", (headers) => {
          status = Number(headers[":status"]);
        });
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("end", () => {
          let reason = "";
          try {
            const parsed = (JSON.parse(body) as { reason?: unknown }).reason;
            reason = typeof parsed === "string" ? parsed : "";
          } catch {
            // No JSON body: a 200, or a proxy's page.
          }
          if (status === 200) {
            resolve("sent");
          } else if (status === 410 || (status === 400 && DEAD_TOKEN_REASONS.has(reason))) {
            resolve("unregistered");
          } else {
            reject(new Error(`APNs answered ${String(status)}${reason === "" ? "" : ` (${reason})`}.`));
          }
        });
        request.on("error", reject);
        // Wallet's notification is an empty dictionary: the device asks the web service what changed.
        request.end("{}");
      });
    },
    close() {
      session?.close();
    },
  };
}
