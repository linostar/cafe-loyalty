import { z } from "zod";

/**
 * A card's QR token: `v1.<cardId>.<cafeId>.<epoch>.<keyId>.<mac>`, where mac is a base64url HMAC-SHA256 over
 * cardQrSigningPayload (AC 7). Counters read the café id to refuse another café's card offline; only the server holds
 * the keys, so only the server verifies the mac.
 */
export const CARD_QR_VERSION = "v1";
export const CARD_QR_SIGNING_PREFIX = "cafe-loyalty/card-qr/v1\n";

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CARD_QR_FORMAT = new RegExp(`^v1\\.(${uuid})\\.(${uuid})\\.([1-9]\\d{0,8})\\.([a-z0-9]{1,16})\\.([A-Za-z0-9_-]{43})$`);

export interface CardQrFields {
  cardId: string;
  cafeId: string;
  epoch: number;
  keyId: string;
}

export const cardQrSigningPayload = (fields: CardQrFields): string =>
  `${CARD_QR_SIGNING_PREFIX}${fields.cardId}\n${fields.cafeId}\n${String(fields.epoch)}\n${fields.keyId}`;

export const formatCardQr = (fields: CardQrFields, mac: string): string =>
  [CARD_QR_VERSION, fields.cardId, fields.cafeId, String(fields.epoch), fields.keyId, mac].join(".");

/** The fields and mac of a card QR token, or null if it is not one. Does not check the mac. */
export function parseCardQr(token: string): (CardQrFields & { mac: string }) | null {
  const match = CARD_QR_FORMAT.exec(token);
  if (match === null) {
    return null;
  }
  const [, cardId = "", cafeId = "", epoch = "", keyId = "", mac = ""] = match;
  return { cardId, cafeId, epoch: Number(epoch), keyId, mac };
}

/** The café's signup link code, from its printed QR. */
export const joinCodeSchema = z.string().regex(/^[0-9a-f]{32}$/, "This signup link is incomplete. Scan the café's code again.");

/** The owner dashboard's view of the café's signup QR. */
export const joinLinkSchema = z.object({ joinUrl: z.url() });
