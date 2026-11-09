import { stampPicturePath } from "@cafe-loyalty/db";
import { STAMP_SHAPES } from "@cafe-loyalty/shared";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { SIDE_INSET, STRIP_HEIGHT, STRIP_WIDTH, parseStampPicture, stampLayout, stampPicturePng, stampPictureSvg, stampSlotSvg } from "./stamp-picture.js";

const PICTURE = { shape: "cup" as const, background: "#1f5a85", foreground: "#ffffff", stamps: 4, required: 9 };

describe("stampLayout", () => {
  it("keeps the previous layout for its addresses: up to 10 a row, more spread over even rows, inside the strip", () => {
    const rowsOf = (required: number) => new Set(stampLayout(required, 1).positions.map(({ y }) => y.toFixed(2))).size;
    expect([1, 9, 10, 11, 12, 20, 21, 50].map(rowsOf)).toEqual([1, 1, 1, 2, 2, 2, 3, 5]);
    for (const required of [1, 9, 50]) {
      const { size, positions } = stampLayout(required, 1);
      expect(positions).toHaveLength(required);
      for (const { x, y } of positions) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x + size).toBeLessThanOrEqual(STRIP_WIDTH);
        expect(y + size).toBeLessThanOrEqual(STRIP_HEIGHT);
      }
    }
  });

  it("puts at most 5 stamps on a row, spread evenly over the rows, and keeps every stamp inside the pass's margins", () => {
    const rowLengths = (required: number) => {
      const rows = new Map<string, number>();
      for (const { y } of stampLayout(required).positions) {
        rows.set(y.toFixed(2), (rows.get(y.toFixed(2)) ?? 0) + 1);
      }
      return [...rows.values()];
    };
    expect(rowLengths(10)).toEqual([5, 5]);
    expect(rowLengths(8)).toEqual([4, 4]);
    expect(rowLengths(7)).toEqual([4, 3]);
    expect(rowLengths(6)).toEqual([3, 3]);
    expect(rowLengths(12)).toEqual([4, 4, 4]);
    expect(rowLengths(50)).toEqual(Array.from({ length: 10 }, () => 5));
    for (let required = 1; required <= 50; required += 1) {
      const { size, positions } = stampLayout(required);
      expect(positions).toHaveLength(required);
      expect(size).toBeGreaterThan(0);
      for (const { x, y } of positions) {
        expect(x).toBeGreaterThanOrEqual(SIDE_INSET);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x + size).toBeLessThanOrEqual(STRIP_WIDTH - SIDE_INSET);
        expect(y + size).toBeLessThanOrEqual(STRIP_HEIGHT);
      }
    }
  });
});

describe("stampPictureSvg", () => {
  it("draws the collected stamps full and the rest outlined, on the card's background", () => {
    const svg = stampPictureSvg(PICTURE, 1);
    expect(svg).toContain('fill="#1f5a85"');
    // A cup's body: full (filled, and outlined in the same colour) for 4, outlined only for 5.
    expect(svg.match(/<path d="M3\.5 7h12[^"]*" fill="#ffffff" stroke="#ffffff"/g)).toHaveLength(4);
    expect(svg.match(/<path d="M3\.5 7h12[^"]*" fill="none"/g)).toHaveLength(5);
    expect(stampPictureSvg({ ...PICTURE, stamps: 0 }, 1)).not.toMatch(/fill="#ffffff"/);
    // Layout 2's pictures (addresses under /stamps/v2/) keep their full stamps filled only.
    expect(stampPictureSvg(PICTURE, 1, 2).match(/<path d="M3\.5 7h12[^"]*" fill="#ffffff"\/>/g)).toHaveLength(4);
  });

  it("draws every full stamp as big as an empty one", async () => {
    // The drawn area of one stamp, full or empty, found by trimming the background off the strip.
    const extent = async (shape: (typeof STAMP_SHAPES)[number], stamps: number) => {
      const { info } = await sharp(await stampPicturePng({ ...PICTURE, shape, stamps, required: 1 }, 3))
        .trim({ background: PICTURE.background, threshold: 0 })
        .toBuffer({ resolveWithObject: true });
      return [info.width, info.height];
    };
    for (const shape of STAMP_SHAPES) {
      expect(await extent(shape, 1), shape).toEqual(await extent(shape, 0));
    }
  });

  it("draws a full stamp's inner lines in the background, an empty one's in the stamp colour", () => {
    const svg = stampPictureSvg({ ...PICTURE, shape: "plate", stamps: 1, required: 2 }, 1);
    expect(svg.match(/class="stamp-inner"/g)).toHaveLength(2);
    expect(svg).toMatch(/stroke="#1f5a85"[^>]*class="stamp-inner"/);
    expect(svg).toMatch(/stroke="#ffffff"[^>]*class="stamp-inner"/);
  });
});

describe("stampPicturePng", () => {
  it("renders every shape at Apple's three strip sizes", async () => {
    for (const shape of STAMP_SHAPES) {
      for (const scale of [1, 2, 3]) {
        const meta = await sharp(await stampPicturePng({ ...PICTURE, shape, stamps: 50, required: 50 }, scale)).metadata();
        expect([meta.format, meta.width, meta.height]).toEqual(["png", STRIP_WIDTH * scale, STRIP_HEIGHT * scale]);
      }
    }
  });
});

describe("parseStampPicture", () => {
  it("reads back every address stampPicturePath makes", () => {
    for (const picture of [PICTURE, { ...PICTURE, shape: "bean" as const, stamps: 0, required: 1 }, { ...PICTURE, stamps: 50, required: 50 }]) {
      expect(parseStampPicture(stampPicturePath(picture).slice("/stamps/v3/".length))).toEqual(picture);
    }
  });

  it("finds nothing for anything a card could not show", () => {
    for (const file of [
      "star-1f5a85-ffffff-4-9.png",
      "cup-1F5A85-ffffff-4-9.png",
      "cup-1f5a8-ffffff-4-9.png",
      "cup-1f5a85-ffffff-10-9.png",
      "cup-1f5a85-ffffff-4-51.png",
      "cup-1f5a85-ffffff-4-0.png",
      "cup-1f5a85-ffffff-04-9.png",
      "cup-1f5a85-ffffff-4-9.svg",
      "cup-1f5a85-ffffff-4-9.png.png",
      "../cup-1f5a85-ffffff-4-9.png",
    ]) {
      expect(parseStampPicture(file), file).toBeUndefined();
    }
  });
});

describe("stampSlotSvg", () => {
  it("draws one web card stamp in currentColor", () => {
    expect(stampSlotSvg("circle", true)).toMatch(/^<svg viewBox="0 0 24 24" focusable="false"><path d="[^"]+" fill="currentColor" stroke="currentColor" [^>]*\/><\/svg>$/);
    expect(stampSlotSvg("circle", false)).toContain('fill="none" stroke="currentColor"');
  });
});
