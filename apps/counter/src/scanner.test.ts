import { encode } from "uqr";
import { describe, expect, it } from "vitest";
import { decodeQr } from "./scanner.js";

/**
 * An RGBA image of `text` as a QR code, `scale` pixels per module, as a camera frame would give it; `inverted` draws it
 * light on dark, as a browser's forced dark mode can show the web card.
 */
function qrImage(text: string, scale = 4, inverted = false): { data: Uint8ClampedArray; width: number; height: number } {
  const { data: modules, size } = encode(text, { border: 4 });
  const width = size * scale;
  const data = new Uint8ClampedArray(width * width * 4);
  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dark = (modules[Math.floor(y / scale)]?.[Math.floor(x / scale)] === true) !== inverted;
      const offset = (y * width + x) * 4;
      data.set(dark ? [0, 0, 0, 255] : [255, 255, 255, 255], offset);
    }
  }
  return { data, width, height: width };
}

const TOKEN = `v1.0b9a3c4d-1e2f-4a5b-8c7d-6e5f4a3b2c1d.1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d.1.q1.${"A".repeat(43)}`;

describe("decodeQr", () => {
  it("reads a card QR code from a camera frame", () => {
    expect(decodeQr(qrImage(TOKEN))).toBe(TOKEN);
  });

  it("reads an inverted card QR code, light on dark", () => {
    expect(decodeQr(qrImage(TOKEN, 4, true))).toBe(TOKEN);
  });

  it("finds nothing in a frame without a code", () => {
    expect(decodeQr({ data: new Uint8ClampedArray(64 * 64 * 4).fill(255), width: 64, height: 64 })).toBeNull();
  });
});
