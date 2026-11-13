import { isSilhouetteShape, type CardColors, type SilhouetteStampShape, type StampShape } from "@cafe-loyalty/shared";
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
  /**
   * The SHA-256 of the silhouette its stamps are drawn from, or null without one: the picture's for "From picture", else
   * the logo's ("From logo"). Its address and its stamp pictures'.
   */
  stampMaskHash: Buffer | null;
}

/** A café's "From picture" picture: the upload as a square PNG and the silhouette cut from it (cafe_pictures). */
export interface CafePictureImages {
  square: Buffer;
  stampMask: Buffer;
  stampMaskHash: Buffer;
  stampMaskVersion: number;
}

/** A café's logo in the sizes its cards use, with the SHA-256 of the square PNG and its silhouette for "From logo" stamps. */
export interface CafeLogoImages {
  hash: Buffer;
  square: Buffer;
  apple1x: Buffer;
  apple2x: Buffer;
  apple3x: Buffer;
  stampMask: Buffer;
  /** The silhouette's SHA-256 and the version of the cut that made it (cafe_logos.stamp_mask_hash, stamp_mask_version). */
  stampMaskHash: Buffer;
  stampMaskVersion: number;
}

/** A café's branding, read inside its withCafe. */
export async function loadCafeBranding(trx: Transaction<Database>, cafeId: string): Promise<CafeBranding> {
  const cafe = await trx
    .selectFrom("cafes")
    .leftJoin("cafe_logos", "cafe_logos.cafe_id", "cafes.id")
    .leftJoin("cafe_pictures", "cafe_pictures.cafe_id", "cafes.id")
    .select([
      "cafes.id",
      "cafes.name",
      "cafes.card_background",
      "cafes.card_foreground",
      "cafes.card_label",
      "cafes.stamp_shape",
      "cafes.google_review_url",
      "cafe_logos.hash",
      "cafe_logos.stamp_mask_hash",
      "cafe_pictures.stamp_mask_hash as picture_mask_hash",
    ])
    .where("cafes.id", "=", cafeId)
    .executeTakeFirstOrThrow();
  return {
    id: cafe.id,
    name: cafe.name,
    colors: { background: cafe.card_background, foreground: cafe.card_foreground, label: cafe.card_label },
    logoHash: cafe.hash,
    stampShape: cafe.stamp_shape,
    reviewUrl: cafe.google_review_url,
    stampMaskHash: cafe.stamp_shape === "picture" ? cafe.picture_mask_hash : cafe.stamp_mask_hash,
  };
}

/**
 * What a picture of a card's stamps shows: the shape (for "From logo", the hash of the silhouette it is drawn from), the
 * card's background and text colours, and its count.
 */
export interface StampPicture {
  shape: StampShape;
  /**
   * The silhouette's hash, for the 'logo' and 'picture' shapes (its address names it, as `logo.<hash>`: both are drawn
   * the same from it); no other shape has one.
   */
  maskHash?: Buffer;
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
  `/stamps/v3/${isSilhouetteShape(picture.shape) && picture.maskHash !== undefined ? `logo.${picture.maskHash.toString("hex")}` : picture.shape}-${picture.background.slice(1)}-${picture.foreground.slice(1)}-${String(Math.min(picture.stamps, picture.required))}-${String(picture.required)}.png`;

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
  const values = { hash: images.hash, square: images.square, apple_1x: images.apple1x, apple_2x: images.apple2x, apple_3x: images.apple3x, stamp_mask: images.stampMask, stamp_mask_for: images.hash, stamp_mask_hash: images.stampMaskHash, stamp_mask_version: images.stampMaskVersion };
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
    .set({ hash: null, square: null, apple_1x: null, apple_2x: null, apple_3x: null, stamp_mask: null, stamp_mask_for: null, stamp_mask_hash: null, stamp_mask_version: null })
    .where("cafe_id", "=", cafeId)
    .where("hash", "is not", null)
    // The row as keep_previous_logo left it: the removed logo is now the previous one.
    .returning("previous_hash")
    .executeTakeFirst();
  return removed?.previous_hash ?? undefined;
}

/**
 * The silhouette a café's stamps of this shape are drawn from, or undefined: its current logo's for "From logo" (none
 * without a logo, or for one from before 0037), its picture's for "From picture" (none without a picture).
 */
export async function loadStampMask(trx: Transaction<Database>, cafeId: string, shape: SilhouetteStampShape = "logo"): Promise<Buffer | undefined> {
  const found = await trx
    .selectFrom(shape === "picture" ? "cafe_pictures" : "cafe_logos")
    .select("stamp_mask")
    .where("cafe_id", "=", cafeId)
    .executeTakeFirst();
  return found?.stamp_mask ?? undefined;
}

/** Sets or replaces a café's "From picture" picture, inside its withCafe (a replacement of a café on it marks its passes, 0040). */
export async function saveCafePicture(trx: Transaction<Database>, cafeId: string, picture: CafePictureImages): Promise<void> {
  const values = { square: picture.square, stamp_mask: picture.stampMask, stamp_mask_hash: picture.stampMaskHash, stamp_mask_version: picture.stampMaskVersion };
  await trx
    .insertInto("cafe_pictures")
    .values({ cafe_id: cafeId, ...values })
    .onConflict((conflict) => conflict.column("cafe_id").doUpdateSet(values))
    .execute();
}

/**
 * Removes a café's "From picture" picture (a café on it goes back to the circle, trigger, migration 0040); the removed
 * silhouette's hash, or undefined when there was none.
 */
export async function removeCafePicture(trx: Transaction<Database>, cafeId: string): Promise<Buffer | undefined> {
  const removed = await trx.deleteFrom("cafe_pictures").where("cafe_id", "=", cafeId).returning("stamp_mask_hash").executeTakeFirst();
  return removed?.stamp_mask_hash;
}

/** Where a silhouette (a logo's or a picture's) is served, publicly (the web card's stamps), by its own hash. */
export const stampMaskPath = (hash: Buffer): string => `/logos/${hash.toString("hex")}-stamp.png`;

/** Where a café's logo is served, publicly (Google fetches it, the web card shows it): by its hash, naming no café. */
export const cafeLogoPath = (hash: Buffer): string => `/logos/${hash.toString("hex")}.png`;
