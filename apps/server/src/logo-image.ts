import { createHash } from "node:crypto";
import type { CafeLogoImages, CafePictureImages } from "@cafe-loyalty/db";
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

/** What an upload is refused with, in the words of what it is (a logo, or a "From picture" picture). */
interface UploadText {
  notAnImage: ApiText;
  tooLarge: ApiText;
  tooSmall: ApiText;
}

const LOGO_TEXT: UploadText = {
  notAnImage: apiText("Upload the logo as a PNG or JPEG image."),
  tooLarge: apiText("Use a logo of at most 2 MB."),
  tooSmall: apiText("Use a logo at least 64 pixels wide and high."),
};

const PICTURE_TEXT: UploadText = {
  notAnImage: apiText("Upload the picture as a PNG or JPEG image."),
  tooLarge: apiText("Use a picture of at most 2 MB."),
  tooSmall: apiText("Use a picture at least 64 pixels wide and high."),
};

/**
 * An upload (base64, PNG or JPEG) checked, decoded once, rotated and brought down to the largest size any card uses
 * (a PNG), with `make` turning it into the images kept. Every output is re-encoded, so no metadata of the upload (EXIF,
 * places, comments) is kept. Throws VALIDATION_FAILED, on the `image` field, for anything else.
 */
async function processUpload<T>(base64: string, text: UploadText, make: (base: Buffer) => Promise<T>): Promise<T> {
  const notAnImage = () => refused(text.notAnImage);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw notAnImage();
  }
  const input = Buffer.from(base64, "base64");
  if (input.length > LOGO_MAX_BYTES) {
    throw refused(text.tooLarge);
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
    throw refused(text.tooSmall);
  }
  try {
    const base = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
      .rotate()
      .resize(LOGO_SQUARE_SIDE, LOGO_SQUARE_SIDE, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    return await make(base);
  } catch {
    // A file whose header reads but whose pixels do not (truncated, corrupt).
    throw notAnImage();
  }
}

/** The image centred on a transparent square of LOGO_SQUARE_SIDE, so Google's round crop keeps all of it. */
const squareOf = (base: Buffer): Promise<Buffer> =>
  sharp(base)
    .resize(LOGO_SQUARE_SIDE, LOGO_SQUARE_SIDE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();

/**
 * A logo upload (base64, PNG or JPEG) turned into the images a café's cards use: a square PNG (squareOf) and Apple's
 * logo.png at 1x, 2x and 3x, with its silhouette for "From logo" stamps; a JPEG's rotation is applied first.
 */
export function processLogo(base64: string): Promise<CafeLogoImages> {
  return processUpload(base64, LOGO_TEXT, async (base) => {
    const apple = (scale: number) =>
      sharp(base)
        .resize(APPLE_LOGO_POINTS.width * scale, APPLE_LOGO_POINTS.height * scale, { fit: "inside", withoutEnlargement: true })
        .png({ compressionLevel: 9 })
        .toBuffer();
    const [square, apple1x, apple2x, apple3x, stampMask] = await Promise.all([squareOf(base), apple(1), apple(2), apple(3), stampSilhouette(base)]);
    return { hash: createHash("sha256").update(square).digest(), square, apple1x, apple2x, apple3x, ...silhouetteOf(stampMask) };
  });
}

/**
 * A "From picture" upload (base64, PNG or JPEG, the same limits as a logo's) turned into its square PNG (squareOf,
 * kept to cut it again) and the ringed circle its stamps are drawn as (stampPictureSilhouette), cut from that square as
 * a re-cut is, so both give the same silhouette.
 */
export function processStampPicture(base64: string): Promise<CafePictureImages> {
  return processUpload(base64, PICTURE_TEXT, async (base) => {
    const square = await squareOf(base);
    return { square, ...silhouetteOf(await stampPictureSilhouette(square)) };
  });
}

/** The side of a logo's silhouette for "From logo" stamps: twice the largest stamp drawn (a 3x strip's, about 110 px). */
export const STAMP_MASK_SIDE = 256;
/**
 * How silhouettes are cut (cafe_logos.stamp_mask_version): 1 took a transparent logo's alpha alone (its filled outline);
 * 2 inks a logo's dark visible parts, so its inner detail shows; 3 cuts a "From picture" picture as a ringed circle
 * (a logo's cut is 2's, so its re-cut keeps its hash and marks no pass). The server re-cuts older ones at start-up.
 */
export const STAMP_MASK_VERSION = 3;
/** The ring round a "From picture" stamp and the clear gap (padding) between it and the picture, in STAMP_MASK_SIDE pixels. */
const PICTURE_RING = 10;
const PICTURE_GAP = 14;
/** A pixel at least this opaque is part of the logo; anything fainter is see-through. */
const VISIBLE_ALPHA = 128;
/** Visible pixels all within this brightness of each other are one colour: the logo is then its whole visible shape. */
const ONE_COLOUR_RANGE = 48;

/** A silhouette as cafe_logos keeps it: the PNG, its own SHA-256 (its public address) and the cut's version. */
export const silhouetteOf = (stampMask: Buffer): { stampMask: Buffer; stampMaskHash: Buffer; stampMaskVersion: number } => ({
  stampMask,
  stampMaskHash: createHash("sha256").update(stampMask).digest(),
  stampMaskVersion: STAMP_MASK_VERSION,
});

/**
 * The threshold that best splits a histogram of 0-255 values in two (Otsu's method): the one with the largest
 * variance between the two groups.
 */
export function otsuThreshold(histogram: readonly number[]): number {
  const total = histogram.reduce((sum, count) => sum + count, 0);
  const sumAll = histogram.reduce((sum, count, value) => sum + count * value, 0);
  let below = 0;
  let sumBelow = 0;
  let best = { threshold: 0, variance: -1 };
  for (let value = 0; value < 256; value += 1) {
    below += histogram[value] ?? 0;
    sumBelow += value * (histogram[value] ?? 0);
    const above = total - below;
    if (below === 0 || above === 0) {
      continue;
    }
    const variance = below * above * (sumBelow / below - (sumAll - sumBelow) / above) ** 2;
    if (variance > best.variance) {
      best = { threshold: value, variance };
    }
  }
  return best.threshold;
}

/**
 * A logo's two-tone silhouette for "From logo" stamps (STAMP_MASK_VERSION 2): a STAMP_MASK_SIDE square PNG, white, whose
 * alpha is the silhouette, trimmed to it and centred. Its visible pixels are split in two by brightness (otsuThreshold)
 * and the dark side is inked, so letters, lines and colour areas inside the logo show; see-through pixels and the light
 * side are holes. A logo of one colour (light or dark) is its whole visible shape; a logo with nothing visible gives a
 * full square, which the owner sees in the preview.
 */
export async function stampSilhouette(logo: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(logo)
    .resize(STAMP_MASK_SIDE, STAMP_MASK_SIDE, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const pixels = width * height;
  const ink = inkOf(data, pixels);
  // Trimmed to the silhouette, so a logo with space around it fills the stamp as other shapes do.
  let box = { left: width, top: height, right: -1, bottom: -1 };
  for (let index = 0; index < pixels; index += 1) {
    if ((ink[index] ?? 0) >= 128) {
      const x = index % width;
      const y = Math.floor(index / width);
      box = { left: Math.min(box.left, x), top: Math.min(box.top, y), right: Math.max(box.right, x), bottom: Math.max(box.bottom, y) };
    }
  }
  if (box.right < 0) {
    ink.fill(255);
    box = { left: 0, top: 0, right: width - 1, bottom: height - 1 };
  }
  const white = Buffer.alloc(pixels * 4, 255);
  for (let index = 0; index < pixels; index += 1) {
    white[index * 4 + 3] = ink[index] ?? 0;
  }
  return sharp(white, { raw: { width, height, channels: 4 } })
    .extract({ left: box.left, top: box.top, width: box.right - box.left + 1, height: box.bottom - box.top + 1 })
    .resize(STAMP_MASK_SIDE, STAMP_MASK_SIDE, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * A "From picture" picture's silhouette (STAMP_MASK_VERSION 3), cut from its stored square (squareOf): the picture
 * without that square's transparent padding, its centre cut to fill the circle inside a ring always inked and a clear
 * gap (a wide or tall picture loses its sides; the picture is scaled into that circle, so the gap hides none of it),
 * inked as a logo is (inkOf, untrimmed), so the stamp is round whatever the picture's edges.
 */
export async function stampPictureSilhouette(square: Buffer): Promise<Buffer> {
  const { data: alpha, info: whole } = await sharp(square).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  let box = { left: whole.width, top: whole.height, right: -1, bottom: -1 };
  for (let index = 0; index < whole.width * whole.height; index += 1) {
    if ((alpha[index] ?? 0) > 0) {
      const x = index % whole.width;
      const y = Math.floor(index / whole.width);
      box = { left: Math.min(box.left, x), top: Math.min(box.top, y), right: Math.max(box.right, x), bottom: Math.max(box.bottom, y) };
    }
  }
  const picture = box.right < 0 ? sharp(square) : sharp(square).extract({ left: box.left, top: box.top, width: box.right - box.left + 1, height: box.bottom - box.top + 1 });
  const inset = PICTURE_RING + PICTURE_GAP;
  const { data } = await picture
    .resize(STAMP_MASK_SIDE - 2 * inset, STAMP_MASK_SIDE - 2 * inset, { fit: "cover" })
    .extend({ top: inset, bottom: inset, left: inset, right: inset, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const side = STAMP_MASK_SIDE;
  const ink = inkOf(data, side * side);
  const radius = side / 2;
  const white = Buffer.alloc(side * side * 4, 255);
  for (let index = 0; index < side * side; index += 1) {
    const away = Math.hypot((index % side) + 0.5 - radius, Math.floor(index / side) + 0.5 - radius);
    const inked = away >= radius - PICTURE_RING ? 255 : away >= radius - PICTURE_RING - PICTURE_GAP ? 0 : (ink[index] ?? 0);
    // The circle's edge smoothed over a pixel.
    white[index * 4 + 3] = Math.round(inked * Math.min(1, Math.max(0, radius - away + 0.5)));
  }
  return sharp(white, { raw: { width: side, height: side, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Which of an RGBA image's pixels are ink (255) or holes (0): its visible pixels split in two by brightness
 * (otsuThreshold), the dark side inked; one colour (light or dark) is all ink; see-through pixels are holes.
 */
function inkOf(data: Buffer, pixels: number): Buffer {
  const ink = Buffer.alloc(pixels);
  const brightness = new Uint8Array(pixels);
  const histogram = new Array<number>(256).fill(0);
  let darkest = 255;
  let lightest = 0;
  for (let index = 0; index < pixels; index += 1) {
    if ((data[index * 4 + 3] ?? 0) < VISIBLE_ALPHA) {
      continue;
    }
    const value = Math.round(0.2126 * (data[index * 4] ?? 0) + 0.7152 * (data[index * 4 + 1] ?? 0) + 0.0722 * (data[index * 4 + 2] ?? 0));
    brightness[index] = value;
    histogram[value] = (histogram[value] ?? 0) + 1;
    darkest = Math.min(darkest, value);
    lightest = Math.max(lightest, value);
  }
  // One colour: every visible pixel is ink. Otherwise the dark side of the split (at or under the threshold).
  const threshold = lightest - darkest < ONE_COLOUR_RANGE ? 255 : otsuThreshold(histogram);
  for (let index = 0; index < pixels; index += 1) {
    ink[index] = (data[index * 4 + 3] ?? 0) >= VISIBLE_ALPHA && (brightness[index] ?? 0) <= threshold ? 255 : 0;
  }
  return ink;
}
