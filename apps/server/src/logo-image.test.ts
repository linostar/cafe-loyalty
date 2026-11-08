import { createHash, randomBytes } from "node:crypto";
import { ApiError } from "@cafe-loyalty/shared";
import sharp, { type Sharp } from "sharp";
import { describe, expect, it } from "vitest";
import { LOGO_MAX_BYTES, LOGO_SQUARE_SIDE, LOGO_STORED_MAX_BYTES, processLogo } from "./logo-image.js";

const red = { r: 200, g: 30, b: 30, alpha: 1 };
const picture = (width: number, height: number) => sharp({ create: { width, height, channels: 4, background: red } });
const base64 = async (image: Sharp) => (await image.toBuffer()).toString("base64");
const size = async (png: Buffer) => {
  const { width, height, format } = await sharp(png).metadata();
  return { width, height, format };
};

/** The field issue a refused upload names. */
async function refusal(upload: string): Promise<string | undefined> {
  try {
    await processLogo(upload);
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error instanceof ApiError ? error.details?.[0]?.issue : undefined;
  }
}

describe("a café logo", () => {
  it("makes a square PNG and Apple's three sizes from a wide PNG, hashed by the square", async () => {
    const logo = await processLogo(await base64(picture(800, 200).png()));
    expect(await size(logo.square)).toEqual({ width: LOGO_SQUARE_SIDE, height: LOGO_SQUARE_SIDE, format: "png" });
    // 800x200 fitted inside 160x50 points: limited by the width.
    expect(await size(logo.apple1x)).toEqual({ width: 160, height: 40, format: "png" });
    expect(await size(logo.apple2x)).toEqual({ width: 320, height: 80, format: "png" });
    expect(await size(logo.apple3x)).toEqual({ width: 480, height: 120, format: "png" });
    expect(logo.hash).toEqual(createHash("sha256").update(logo.square).digest());
  });

  it("takes a JPEG, keeps a small logo small on Apple, and drops the upload's metadata", async () => {
    const jpeg = await picture(100, 100).jpeg().withMetadata({ exif: { IFD0: { Copyright: "Fake test metadata" } } }).toBuffer();
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();
    const logo = await processLogo(jpeg.toString("base64"));
    // Never enlarged past the upload: 100x100 fits 50 points high at 1x, then stays 100 pixels.
    expect(await size(logo.apple1x)).toEqual({ width: 50, height: 50, format: "png" });
    expect(await size(logo.apple3x)).toEqual({ width: 100, height: 100, format: "png" });
    for (const image of [logo.square, logo.apple1x, logo.apple2x, logo.apple3x]) {
      expect((await sharp(image).metadata()).exif).toBeUndefined();
    }
  });

  it("stores even a logo PNG cannot compress (noise) within the database's limit", async () => {
    const side = LOGO_SQUARE_SIDE;
    const noise = sharp(randomBytes(side * side * 4), { raw: { width: side, height: side, channels: 4 } }).png({ compressionLevel: 0 });
    const upload = await noise.toBuffer();
    expect(upload.length).toBeLessThanOrEqual(LOGO_MAX_BYTES);
    const logo = await processLogo(upload.toString("base64"));
    // Over the 1 MiB an image might be thought to need.
    expect(logo.square.length).toBeGreaterThan(1024 * 1024);
    for (const image of [logo.square, logo.apple1x, logo.apple2x, logo.apple3x]) {
      expect(image.length).toBeLessThanOrEqual(LOGO_STORED_MAX_BYTES);
    }
  });

  it("refuses anything but a PNG or JPEG, and what is not an image at all", async () => {
    const message = "Upload the logo as a PNG or JPEG image.";
    expect(await refusal(await base64(picture(100, 100).gif()))).toBe(message);
    expect(await refusal(await base64(picture(100, 100).webp()))).toBe(message);
    expect(await refusal(Buffer.from("not an image at all").toString("base64"))).toBe(message);
    expect(await refusal("data:image/png;base64,AAAA")).toBe(message);
    // A PNG cut short: its header reads, its pixels do not.
    const png = await picture(300, 300).png().toBuffer();
    expect(await refusal(png.subarray(0, 60).toString("base64"))).toBe(message);
  });

  it("refuses a logo under 64 pixels on a side, or over 2 MB", async () => {
    expect(await refusal(await base64(picture(300, 40).png()))).toBe("Use a logo at least 64 pixels wide and high.");
    expect(await refusal(Buffer.alloc(LOGO_MAX_BYTES + 1).toString("base64"))).toBe("Use a logo of at most 2 MB.");
  });
});
