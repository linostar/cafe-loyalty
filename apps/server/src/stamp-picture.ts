import type { StampPicture } from "@cafe-loyalty/db";
import { STAMP_SHAPE_PATHS, STAMP_STROKE, stampGrid, stampShapeSchema, type StampShape } from "@cafe-loyalty/shared";
import sharp from "sharp";

/** One stamp's drawing (STAMP_SHAPE_PATHS) inside an <svg viewBox="0 0 24 24">, in the given colours (any SVG paint). */
function stampShapeMarkup(shape: StampShape, full: boolean, paint: { stamp: string; background: string }): string {
  const { body, extra, inner } = STAMP_SHAPE_PATHS[shape];
  const line = (d: string, color: string, extraAttributes = "") =>
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="${String(STAMP_STROKE)}" stroke-linecap="round" stroke-linejoin="round"${extraAttributes}/>`;
  return [
    full ? `<path d="${body}" fill="${paint.stamp}"/>` : line(body, paint.stamp),
    extra === undefined ? "" : line(extra, paint.stamp),
    inner === undefined ? "" : line(inner, full ? paint.background : paint.stamp, ' class="stamp-inner"'),
  ].join("");
}

/**
 * One stamp of the web card as an inline SVG (no image request): drawn in currentColor, which customer.css sets for full
 * and empty stamps; a full stamp's inner lines take the card's background there (`.stamp-inner`).
 */
export function stampSlotSvg(shape: StampShape, full: boolean): string {
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
 * The stamp picture's layouts: 2 (the current one, addresses under `/stamps/v2/`) is stampGrid's rows (at most 5 a row,
 * spread evenly) inside the pass's side margins; 1 (addresses without `v2/`, on passes from before) put up to 10 a row
 * with PADDING all round, kept so a cached picture and a fresh one at the same address always look the same.
 */
export type StampLayoutVersion = 1 | 2;

/**
 * Where a program's stamps sit on the strip, in a layout (StampLayoutVersion): each stamp as big as the rows and
 * columns allow (a long program's stamps get small), the grid centred.
 */
export function stampLayout(required: number, version: StampLayoutVersion = 2): { size: number; positions: { x: number; y: number }[] } {
  const legacyRows = Math.ceil(required / 10);
  const { rows, columns } = version === 2 ? stampGrid(required) : { rows: legacyRows, columns: Math.ceil(required / legacyRows) };
  const side = version === 2 ? SIDE_INSET : PADDING;
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

/** The strip's SVG at `scale` (1, 2 or 3): the card's background, its stamps full in the text colour, the rest outlined. */
export function stampPictureSvg(picture: StampPicture, scale: number, version: StampLayoutVersion = 2): string {
  const { size, positions } = stampLayout(picture.required, version);
  const stamps = positions.map(
    ({ x, y }, index) =>
      `<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${(size / 24).toFixed(4)})">${stampShapeMarkup(picture.shape, index < picture.stamps, { stamp: picture.foreground, background: picture.background })}</g>`,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${String(STRIP_WIDTH * scale)}" height="${String(STRIP_HEIGHT * scale)}" viewBox="0 0 ${String(STRIP_WIDTH)} ${String(STRIP_HEIGHT)}"><rect width="${String(STRIP_WIDTH)}" height="${String(STRIP_HEIGHT)}" fill="${picture.background}"/>${stamps.join("")}</svg>`;
}

/** The strip as a PNG at `scale`. */
export const stampPicturePng = (picture: StampPicture, scale: number, version: StampLayoutVersion = 2): Promise<Buffer> =>
  sharp(Buffer.from(stampPictureSvg(picture, scale, version))).png().toBuffer();

/** The most stamps a program takes (cafe-setup's stampsRequired, loyalty_programs' CHECK). */
const MAX_REQUIRED = 50;

/**
 * The picture a stamp address names (stampPicturePath: `<shape>-<background>-<text colour>-<stamps>-<required>.png`), or
 * undefined for anything else: a known shape, lowercase colours, and 0 <= stamps <= required <= 50, so an address can
 * only ask for a picture a card could show.
 */
export function parseStampPicture(file: string): StampPicture | undefined {
  const match = /^([a-z]+)-([0-9a-f]{6})-([0-9a-f]{6})-(0|[1-9]\d?)-([1-9]\d?)\.png$/.exec(file);
  if (match === null) {
    return undefined;
  }
  const [, name, background = "", foreground = "", stamps = "", required = ""] = match;
  const shape = stampShapeSchema.safeParse(name);
  const picture = { background: `#${background}`, foreground: `#${foreground}`, stamps: Number(stamps), required: Number(required) };
  return shape.success && picture.stamps <= picture.required && picture.required <= MAX_REQUIRED ? { ...picture, shape: shape.data } : undefined;
}
