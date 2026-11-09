import { stampPicturePath } from "@cafe-loyalty/db";
import { STAMP_SHAPES } from "@cafe-loyalty/shared";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { STRIP_HEIGHT, STRIP_WIDTH, parseStampPicture, stampLayout, stampPicturePng, stampPictureSvg, stampSlotSvg } from "./stamp-picture.js";

const PICTURE = { shape: "cup" as const, background: "#1f5a85", foreground: "#ffffff", stamps: 4, required: 9 };

describe("stampLayout", () => {
  it("puts up to 10 stamps on a row, spreads more over even rows, and keeps every stamp inside the strip", () => {
    const rowsOf = (required: number) => new Set(stampLayout(required).positions.map(({ y }) => y.toFixed(2))).size;
    expect([1, 9, 10, 11, 12, 20, 21, 50].map(rowsOf)).toEqual([1, 1, 1, 2, 2, 2, 3, 5]);
    // 12 stamps: two rows of 6.
    expect(stampLayout(12).positions.filter(({ y }) => y === stampLayout(12).positions[0]?.y)).toHaveLength(6);
    for (const required of [1, 9, 50]) {
      const { size, positions } = stampLayout(required);
      expect(positions).toHaveLength(required);
      for (const { x, y } of positions) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x + size).toBeLessThanOrEqual(STRIP_WIDTH);
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
      expect(parseStampPicture(stampPicturePath(picture).slice("/stamps/".length))).toEqual(picture);
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
