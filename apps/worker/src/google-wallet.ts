import { signJwt, type GoogleLoyaltyClass, type GoogleLoyaltyObject, type GoogleOfferMessage } from "@cafe-loyalty/db";
import { DeliveryError } from "./delivery.js";

/** "missing": Google has no such object and none was to be created (an INACTIVE object nobody saved). */
export type SaveResult = "updated" | "created" | "missing";

/** Writes loyalty objects to Google Wallet. */
export interface GoogleWallet {
  /**
   * Replaces the object with `object`. When Google has none, `create` makes it (with its class, if that is missing
   * too); otherwise nothing is written. With `message`, an updated object then gets it (addMessage), which notifies;
   * an object just made is on no phone yet, so it gets none.
   */
  save(loyaltyClass: GoogleLoyaltyClass, object: GoogleLoyaltyObject, create: boolean, message?: GoogleOfferMessage): Promise<SaveResult>;
}

export interface GoogleWalletOptions {
  serviceAccount: { email: string; privateKey: string };
  /** Defaults to Google's; tests point them at a local server. */
  apiOrigin?: string;
  tokenUrl?: string;
  timeoutMs?: number;
}

const SCOPE = "https://www.googleapis.com/auth/wallet_object.issuer";
/** A token is renewed this long before it expires. */
const TOKEN_MARGIN_MS = 60_000;

/**
 * A Google Wallet API client signed in as the service account (an OAuth token from a signed JWT, kept until shortly
 * before it expires). Every request has a timeout (AC 43). Errors carry the status and Google's error status only,
 * never a response body, which could echo the object's QR token into the logs.
 */
export function createGoogleWallet(options: GoogleWalletOptions): GoogleWallet {
  const api = `${options.apiOrigin ?? "https://walletobjects.googleapis.com"}/walletobjects/v1`;
  const tokenUrl = options.tokenUrl ?? "https://oauth2.googleapis.com/token";
  const timeoutMs = options.timeoutMs ?? 10_000;
  let token: { value: string; expiresAt: number } | undefined;

  async function accessToken(): Promise<string> {
    if (token !== undefined && token.expiresAt - TOKEN_MARGIN_MS > Date.now()) {
      return token.value;
    }
    const issuedAt = Math.floor(Date.now() / 1000);
    const assertion = signJwt({ iss: options.serviceAccount.email, scope: SCOPE, aud: tokenUrl, iat: issuedAt, exp: issuedAt + 3_600 }, options.serviceAccount.privateKey);
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await response.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown };
    if (!response.ok || typeof body.access_token !== "string") {
      throw new DeliveryError(`Google sign-in answered ${String(response.status)}.`, `google_auth_${String(response.status)}`);
    }
    token = { value: body.access_token, expiresAt: Date.now() + (typeof body.expires_in === "number" ? body.expires_in : 3_600) * 1000 };
    return token.value;
  }

  async function call(method: "POST" | "PUT", path: string, body: object): Promise<number> {
    const response = await fetch(`${api}${path}`, {
      method,
      headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const answer = (await response.json().catch(() => ({}))) as { error?: { status?: unknown } };
    if (response.status === 401) {
      // A revoked or expired token: sign in afresh on the retry.
      token = undefined;
    }
    if (response.ok || response.status === 404 || response.status === 409) {
      return response.status;
    }
    const status = typeof answer.error?.status === "string" && /^[A-Z_]{1,40}$/.test(answer.error.status) ? `_${answer.error.status}` : "";
    throw new DeliveryError(`Google Wallet answered ${String(response.status)} to ${method} ${path.split("/")[1] ?? ""}.`, `google_${String(response.status)}${status}`);
  }

  const failed = (status: number, what: string) => new DeliveryError(`Google Wallet answered ${String(status)} to ${what}.`, `google_${String(status)}`);

  async function addMessage(path: string, message: GoogleOfferMessage | undefined): Promise<"updated"> {
    if (message !== undefined) {
      const status = await call("POST", `${path}/addMessage`, { message });
      // 409: an earlier attempt added it.
      if (status !== 200 && status !== 409) {
        throw failed(status, "a message");
      }
    }
    return "updated";
  }

  return {
    async save(loyaltyClass, object, create, message) {
      const path = `/loyaltyObject/${encodeURIComponent(object.id)}`;
      const status = await call("PUT", path, object);
      if (status === 200) {
        return addMessage(path, message);
      }
      if (status !== 404) {
        throw failed(status, "an object update");
      }
      // Not saved yet, nor written by an earlier job.
      if (!create) {
        return "missing";
      }
      const classStatus = await call("POST", "/loyaltyClass", loyaltyClass);
      if (classStatus !== 200 && classStatus !== 409) {
        throw failed(classStatus, "a class insert");
      }
      const inserted = await call("POST", "/loyaltyObject", object);
      if (inserted === 200) {
        return "created";
      }
      // 409: the customer saved it in the meantime.
      const updated = await call("PUT", path, object);
      if (updated !== 200) {
        throw failed(updated, "an object update");
      }
      return addMessage(path, message);
    },
  };
}
