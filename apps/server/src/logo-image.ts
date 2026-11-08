import { createHash } from "node:crypto";
import type { CafeLogoImages } from "@cafe-loyalty/db";
import { ApiError, apiText, type ApiText } from "@cafe-loyalty/shared";
import sharp from "sharp";

/** The largest logo file taken (decoded), and the request body that carries it in base64 with room for the JSON around it. */
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const LOGO_BODY_LIMIT_BYTES = Math.ceil((LOGO_MAX_BYTES * 4) / 3) + 1024;
/** Uploads an owner or an operator may make an hour: each is decoded and resized, which takes memory and time. */
export const LOGO_UPLOADS_PER_HOUR = 20;
/** The smallest side a logo may have, in pixels. */
export const LOGO_MIN_SIDE = 64;
/** The square logo's side: Google's recommended class logo size, also shown on the web card. */
export const LOGO_SQUARE_SIDE = 660;
/**
 * The largest image cafe_logos stores (its CHECKs, migration 0024): the worst case, a square of noise PNG cannot
 * compress, is 660 × 660 × 4 bytes and a little, about 1.75 MB; Apple's largest is 480 × 150 × 4.
 */
export const LOGO_STORED_MAX_BYTES = 2 * 1024 * 1024;
/** Apple's logo area, in points: the image is fitted inside it at 1x, 2x and 3x. */
const APPLE_LOGO_POINTS = { width: 160, height: 50 };
/** Decoding stops on anything larger, so a small file that unpacks to a huge image is refused, not decoded. */
const MAX_INPUT_PIXELS = 16_000_000;

/** A PNG's or a JPEG's first bytes: nothing else reaches the decoder (sharp reads many more formats). */
const isPngOrJpeg = (input: Buffer): boolean =>
  input.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) || input.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));

const refused = (issue: ApiText) => new ApiError("VALIDATION_FAILED", issue, [{ path: "image", issue }]);
const notAnImage = () => refused(apiText("Upload the logo as a PNG or JPEG image."));

/**
 * A logo upload (base64, PNG or JPEG) turned into the images a café's cards use: a square PNG (the image centred on a
 * transparent square, so Google's round crop keeps all of it) and Apple's logo.png at 1x, 2x and 3x. Every output is
 * re-encoded, so no metadata of the upload (EXIF, places, comments) is kept; a JPEG's rotation is applied first.
 * Throws VALIDATION_FAILED, on the `image` field, for anything else.
 */
export async function processLogo(base64: string): Promise<CafeLogoImages> {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw notAnImage();
  }
  const input = Buffer.from(base64, "base64");
  if (input.length > LOGO_MAX_BYTES) {
    throw refused(apiText("Use a logo of at most 2 MB."));
  }
  if (!isPngOrJpeg(input)) {
    throw notAnImage();
  }
  let width: number;
  let height: number;
  try {
    const metadata = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" }).metadata();
    if (metadata.format !== "png" && metadata.format !== "jpeg") {
      throw notAnImage();
    }
    width = metadata.width;
    height = metadata.height;
  } catch (error) {
    throw error instanceof ApiError ? error : notAnImage();
  }
  if (Math.min(width, height) < LOGO_MIN_SIDE) {
    throw refused(apiText("Use a logo at least 64 pixels wide and high."));
  }
  try {
    // Decoded once, rotated and brought down to the largest size any card uses; every output is made from that.
    const base = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
      .rotate()
      .resize(LOGO_SQUARE_SIDE, LOGO_SQUARE_SIDE, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    const image = () => sharp(base);
    const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
    const square = await image().resize(LOGO_SQUARE_SIDE, LOGO_SQUARE_SIDE, { fit: "contain", background: transparent }).png({ compressionLevel: 9 }).toBuffer();
    const apple = (scale: number) =>
      image()
        .resize(APPLE_LOGO_POINTS.width * scale, APPLE_LOGO_POINTS.height * scale, { fit: "inside", withoutEnlargement: true })
        .png({ compressionLevel: 9 })
        .toBuffer();
    const [apple1x, apple2x, apple3x] = await Promise.all([apple(1), apple(2), apple(3)]);
    return { hash: createHash("sha256").update(square).digest(), square, apple1x, apple2x, apple3x };
  } catch {
    // A file whose header reads but whose pixels do not (truncated, corrupt).
    throw notAnImage();
  }
}
