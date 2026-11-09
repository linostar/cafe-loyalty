import { stampPicturePath } from "@cafe-loyalty/db";
import { STAMP_SHAPES } from "@cafe-loyalty/shared";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { SIDE_INSET, STRIP_HEIGHT, STRIP_WIDTH, parseStampPicture, stampLayout, stampPicturePng, stampPictureSvg, stampSlotSvg } from "./stamp-picture.js";

const PICTURE = { shape: "cup" as const, background: "#1f5a85", foreground: "#ffffff", stamps: 4, required: 9 };

describe("stampLayout", () => {
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
    // A cup's body: full (filled) for 4, outlined for 5.
    expect(svg.match(/<path d="M3\.5 7h12[^"]*" fill="#ffffff"\/>/g)).toHaveLength(4);
    expect(svg.match(/<path d="M3\.5 7h12[^"]*" fill="none"/g)).toHaveLength(5);
    expect(stampPictureSvg({ ...PICTURE, stamps: 0 }, 1)).not.toMatch(/fill="#ffffff"/);
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
      expect(parseStampPicture(stampPicturePath(picture).slice("/stamps/v2/".length))).toEqual(picture);
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
    expect(stampSlotSvg("circle", true)).toMatch(/^<svg viewBox="0 0 24 24" focusable="false"><path d="[^"]+" fill="currentColor"\/><\/svg>$/);
    expect(stampSlotSvg("circle", false)).toContain('fill="none" stroke="currentColor"');
  });
});
