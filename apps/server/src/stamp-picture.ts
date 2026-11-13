import type { StampPicture } from "@cafe-loyalty/db";
import { LOGO_STAMP_EMPTY_OPACITY, STAMP_SHAPE_PATHS, STAMP_STROKE, stampGrid, stampShapeSchema, type DrawnStampShape } from "@cafe-loyalty/shared";
import sharp from "sharp";

/**
 * One stamp's drawing (STAMP_SHAPE_PATHS) inside an <svg viewBox="0 0 24 24">, in the given colours (any SVG paint). A
 * full stamp is filled and outlined with the empty one's line (`outlineFull`), so the two are the same size; pictures
 * of an older layout (StampLayoutVersion 1, 2) drew it filled only, a line's half width smaller all round.
 */
function stampShapeMarkup(shape: DrawnStampShape, full: boolean, paint: { stamp: string; background: string }, outlineFull = true): string {
  const { body, extra, inner } = STAMP_SHAPE_PATHS[shape];
  const line = (d: string, color: string, extraAttributes = "") =>
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="${String(STAMP_STROKE)}" stroke-linecap="round" stroke-linejoin="round"${extraAttributes}/>`;
  const fullBody = outlineFull
    ? `<path d="${body}" fill="${paint.stamp}" stroke="${paint.stamp}" stroke-width="${String(STAMP_STROKE)}" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<path d="${body}" fill="${paint.stamp}"/>`;
  return [
    full ? fullBody : line(body, paint.stamp),
    extra === undefined ? "" : line(extra, paint.stamp),
    inner === undefined ? "" : line(inner, full ? paint.background : paint.stamp, ' class="stamp-inner"'),
  ].join("");
}

/**
 * One stamp of the web card as an inline SVG (no image request): drawn in currentColor, which customer.css sets for full
 * and empty stamps; a full stamp's inner lines take the card's background there (`.stamp-inner`).
 */
export function stampSlotSvg(shape: DrawnStampShape, full: boolean): string {
  return `<svg viewBox="0 0 24 24" focusable="false">${stampShapeMarkup(shape, full, { stamp: "currentColor", background: "currentColor" })}</svg>`;
}

/** Apple's strip image size in points (a store card's, under the header); Google's hero image is drawn the same. */
export const STRIP_WIDTH = 375;
export const STRIP_HEIGHT = 123;
/** Space kept clear above and below the stamps. */
const PADDING = 10;
/** Space kept clear on each side: the pass's own margin, so no row reaches past the text above and below it. */
export const SIDE_INSET = 16;

/**
 * The stamp picture's layouts: 3 (the current one, addresses under `/stamps/v3/`) is stampGrid's rows (at most 5 a row,
 * spread evenly) inside the pass's side margins, a full stamp as big as an empty one; 2 (`/stamps/v2/`) had the same
 * rows with full stamps filled only; 1 (addresses without a version) put up to 10 a row with PADDING all round. The
 * older ones are kept so a cached picture and a fresh one at the same address always look the same.
 */
export type StampLayoutVersion = 1 | 2 | 3;

/**
 * Where a program's stamps sit on the strip, in a layout (StampLayoutVersion): each stamp as big as the rows and
 * columns allow (a long program's stamps get small), the grid centred.
 */
export function stampLayout(required: number, version: StampLayoutVersion = 3): { size: number; positions: { x: number; y: number }[] } {
  const legacyRows = Math.ceil(required / 10);
  const { rows, columns } = version === 1 ? { rows: legacyRows, columns: Math.ceil(required / legacyRows) } : stampGrid(required);
  const side = version === 1 ? PADDING : SIDE_INSET;
  const cell = Math.min((STRIP_WIDTH - 2 * side) / columns, (STRIP_HEIGHT - 2 * PADDING) / rows);
  const left = (STRIP_WIDTH - cell * columns) / 2;
  const top = (STRIP_HEIGHT - cell * rows) / 2;
  const size = cell * 0.8;
  const positions = Array.from({ length: required }, (_, index) => ({
    x: left + (index % columns) * cell + (cell - size) / 2,
    y: top + Math.floor(index / columns) * cell + (cell - size) / 2,
  }));
  return { size, positions };
}

/**
 * The strip's SVG at `scale` (1, 2 or 3): the card's background, its stamps full in the text colour, the rest outlined.
 * "From logo" stamps are the logo's silhouette (`mask`, stampSilhouette) in the text colour, solid when full and faded
 * when empty; without the silhouette they are drawn as circles.
 */
export function stampPictureSvg(picture: StampPicture, scale: number, version: StampLayoutVersion = 3, mask?: Buffer): string {
  const { size, positions } = stampLayout(picture.required, version);
  const paint = { stamp: picture.foreground, background: picture.background };
  const logo = picture.shape === "logo" ? mask : undefined;
  const shape = picture.shape === "logo" ? "circle" : picture.shape;
  const stamp = (full: boolean) =>
    logo === undefined
      ? stampShapeMarkup(shape, full, paint, version === 3)
      : `<rect width="24" height="24" fill="${picture.foreground}" mask="url(#logo-stamp)"${full ? "" : ` opacity="${String(LOGO_STAMP_EMPTY_OPACITY)}"`}/>`;
  const stamps = positions.map(
    ({ x, y }, index) => `<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${(size / 24).toFixed(4)})">${stamp(index < picture.stamps)}</g>`,
  );
  // The silhouette's alpha masks each stamp's square (a white mask: its luminance is its alpha).
  const defs =
    logo === undefined
      ? ""
      : `<defs><mask id="logo-stamp" maskContentUnits="objectBoundingBox"><image href="data:image/png;base64,${logo.toString("base64")}" width="1" height="1" preserveAspectRatio="xMidYMid meet"/></mask></defs>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${String(STRIP_WIDTH * scale)}" height="${String(STRIP_HEIGHT * scale)}" viewBox="0 0 ${String(STRIP_WIDTH)} ${String(STRIP_HEIGHT)}">${defs}<rect width="${String(STRIP_WIDTH)}" height="${String(STRIP_HEIGHT)}" fill="${picture.background}"/>${stamps.join("")}</svg>`;
}

/** The strip as a PNG at `scale`; "From logo" pictures need the logo's silhouette (`mask`). */
export const stampPicturePng = (picture: StampPicture, scale: number, version: StampLayoutVersion = 3, mask?: Buffer): Promise<Buffer> =>
  sharp(Buffer.from(stampPictureSvg(picture, scale, version, mask))).png().toBuffer();

/** The most stamps a program takes (cafe-setup's stampsRequired, loyalty_programs' CHECK). */
const MAX_REQUIRED = 50;

/**
 * The picture a stamp address names (stampPicturePath: `<shape>-<background>-<text colour>-<stamps>-<required>.png`, the
 * shape `logo.<silhouette hash>` for "From logo"), or undefined for anything else: a known shape (with a silhouette's hash for
 * "From logo" and only then), lowercase colours, and 0 <= stamps <= required <= 50, so an address can only ask for a
 * picture a card could show (a logo's is drawn only once its silhouette is found).
 */
export function parseStampPicture(file: string): StampPicture | undefined {
  const match = /^([a-z]+)(?:\.([0-9a-f]{64}))?-([0-9a-f]{6})-([0-9a-f]{6})-(0|[1-9]\d?)-([1-9]\d?)\.png$/.exec(file);
  if (match === null) {
    return undefined;
  }
  const [, name, maskHash, background = "", foreground = "", stamps = "", required = ""] = match;
  const shape = stampShapeSchema.safeParse(name);
  const picture = { background: `#${background}`, foreground: `#${foreground}`, stamps: Number(stamps), required: Number(required) };
  const hashed = maskHash !== undefined;
  return shape.success && (shape.data === "logo") === hashed && picture.stamps <= picture.required && picture.required <= MAX_REQUIRED
    ? { ...picture, shape: shape.data, ...(hashed ? { maskHash: Buffer.from(maskHash, "hex") } : {}) }
    : undefined;
}
