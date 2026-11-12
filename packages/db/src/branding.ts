import type { CardColors, StampShape } from "@cafe-loyalty/shared";
import type { Transaction } from "kysely";
import type { Database } from "./schema.js";

/**
 * What every card of a café shows of it: its name, its card colours, its logo's hash (null: the product's logo), the
 * shape its stamps are drawn in and its Google review link (null: none), on every pass whatever the visit.
 */
export interface CafeBranding {
  id: string;
  name: string;
  colors: CardColors;
  logoHash: Buffer | null;
  stampShape: StampShape;
  reviewUrl: string | null;
}

/** A café's logo in the sizes its cards use, with the SHA-256 of the square PNG and its silhouette for "From logo" stamps. */
export interface CafeLogoImages {
  hash: Buffer;
  square: Buffer;
  apple1x: Buffer;
  apple2x: Buffer;
  apple3x: Buffer;
  stampMask: Buffer;
}

/** A café's branding, read inside its withCafe. */
export async function loadCafeBranding(trx: Transaction<Database>, cafeId: string): Promise<CafeBranding> {
  const cafe = await trx
    .selectFrom("cafes")
    .leftJoin("cafe_logos", "cafe_logos.cafe_id", "cafes.id")
    .select(["cafes.id", "cafes.name", "cafes.card_background", "cafes.card_foreground", "cafes.card_label", "cafes.stamp_shape", "cafes.google_review_url", "cafe_logos.hash"])
    .where("cafes.id", "=", cafeId)
    .executeTakeFirstOrThrow();
  return {
    id: cafe.id,
    name: cafe.name,
    colors: { background: cafe.card_background, foreground: cafe.card_foreground, label: cafe.card_label },
    logoHash: cafe.hash,
    stampShape: cafe.stamp_shape,
    reviewUrl: cafe.google_review_url,
  };
}

/**
 * What a picture of a card's stamps shows: the shape (for "From logo", the hash of the logo it is cut from), the card's
 * background and text colours, and its count.
 */
export interface StampPicture {
  shape: StampShape;
  /** The logo's hash, for the 'logo' shape (its address names it); no other shape has one. */
  logoHash?: Buffer;
  background: string;
  foreground: string;
  stamps: number;
  required: number;
}

/**
 * Where a picture of a card's stamps is served, publicly (Google fetches it for the pass's hero image): built only from
 * what it shows, so it names no card, café or customer, and a new count or look is a new address. A card past full
 * (stamps keep counting) shows every stamp full. `v3` is the layout (rows of at most 5, full stamps as big as empty ones): a new layout is a new address,
 * or Google keeps showing the picture it cached.
 */
export const stampPicturePath = (picture: StampPicture): string =>
  `/stamps/v3/${picture.shape === "logo" && picture.logoHash !== undefined ? `logo.${picture.logoHash.toString("hex")}` : picture.shape}-${picture.background.slice(1)}-${picture.foreground.slice(1)}-${String(Math.min(picture.stamps, picture.required))}-${String(picture.required)}.png`;

/** The Apple logo.png images of a café's logo, or undefined without one (the pass then has the product's). */
export async function loadAppleLogo(trx: Transaction<Database>, cafeId: string): Promise<{ apple1x: Buffer; apple2x: Buffer; apple3x: Buffer } | undefined> {
  const logo = await trx.selectFrom("cafe_logos").select(["apple_1x", "apple_2x", "apple_3x"]).where("cafe_id", "=", cafeId).executeTakeFirst();
  // A removed logo leaves its row, with no images.
  return logo?.apple_1x == null || logo.apple_2x === null || logo.apple_3x === null
    ? undefined
    : { apple1x: logo.apple_1x, apple2x: logo.apple_2x, apple3x: logo.apple_3x };
}

/**
 * Sets or replaces a café's logo, inside its withCafe; its triggers mark the café's passes changed and keep the logo it
 * replaces served until the next change (migration 0024).
 */
export async function saveCafeLogo(trx: Transaction<Database>, cafeId: string, images: CafeLogoImages): Promise<void> {
  const values = { hash: images.hash, square: images.square, apple_1x: images.apple1x, apple_2x: images.apple2x, apple_3x: images.apple3x, stamp_mask: images.stampMask };
  await trx
    .insertInto("cafe_logos")
    .values({ cafe_id: cafeId, ...values })
    .onConflict((conflict) => conflict.column("cafe_id").doUpdateSet(values))
    .execute();
}

/**
 * Removes a café's logo (its cards go back to the product's), still served as the previous one until the next change;
 * the removed logo's hash, or undefined when it had none.
 */
export async function removeCafeLogo(trx: Transaction<Database>, cafeId: string): Promise<Buffer | undefined> {
  const removed = await trx
    .updateTable("cafe_logos")
    // Without its silhouette a café on "From logo" goes back to the circle (trigger, migration 0037).
    .set({ hash: null, square: null, apple_1x: null, apple_2x: null, apple_3x: null, stamp_mask: null })
    .where("cafe_id", "=", cafeId)
    .where("hash", "is not", null)
    // The row as keep_previous_logo left it: the removed logo is now the previous one.
    .returning("previous_hash")
    .executeTakeFirst();
  return removed?.previous_hash ?? undefined;
}

/** The silhouette of a café's current logo, for its "From logo" stamps, or undefined (no logo, or one from before 0037). */
export async function loadStampMask(trx: Transaction<Database>, cafeId: string): Promise<Buffer | undefined> {
  const logo = await trx.selectFrom("cafe_logos").select("stamp_mask").where("cafe_id", "=", cafeId).executeTakeFirst();
  return logo?.stamp_mask ?? undefined;
}

/** Where a café's logo's silhouette is served, publicly (the web card's "From logo" stamps), by the logo's hash. */
export const stampMaskPath = (hash: Buffer): string => `/logos/${hash.toString("hex")}-stamp.png`;

/** Where a café's logo is served, publicly (Google fetches it, the web card shows it): by its hash, naming no café. */
export const cafeLogoPath = (hash: Buffer): string => `/logos/${hash.toString("hex")}.png`;
