import { createHash, randomBytes } from "node:crypto";
import { ApiError } from "@cafe-loyalty/shared";
import sharp, { type Sharp } from "sharp";
import { describe, expect, it } from "vitest";
import { LOGO_MAX_BYTES, LOGO_SQUARE_SIDE, LOGO_STORED_MAX_BYTES, STAMP_MASK_SIDE, STAMP_MASK_VERSION, otsuThreshold, processLogo, processStampPicture, stampSilhouette } from "./logo-image.js";

const red = { r: 200, g: 30, b: 30, alpha: 1 };
const picture = (width: number, height: number) => sharp({ create: { width, height, channels: 4, background: red } });
const base64 = async (image: Sharp) => (await image.toBuffer()).toString("base64");
const size = async (png: Buffer) => {
  const { width, height, format } = await sharp(png).metadata();
  return { width, height, format };
};

/** The field issue a refused upload names. */
async function refusal(upload: string, process: (base64: string) => Promise<unknown> = processLogo): Promise<string | undefined> {
  try {
    await process(upload);
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

/** The alpha of a silhouette (stampSilhouette's PNG) at a point given as a share of its side. */
async function alphaAt(mask: Buffer, x: number, y: number): Promise<number> {
  const { data, info } = await sharp(mask).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const index = (Math.floor(y * info.height) * info.width + Math.floor(x * info.width)) * 4;
  return data[index + 3] ?? -1;
}

/** A 200-pixel square of one colour with a 100-pixel square of another in its middle. */
const squareOn = (outside: { r: number; g: number; b: number; alpha: number }, inside: { r: number; g: number; b: number; alpha: number }) =>
  sharp({ create: { width: 200, height: 200, channels: 4, background: outside } })
    .composite([{ input: { create: { width: 100, height: 100, channels: 4, background: inside } }, left: 50, top: 50 }])
    .png()
    .toBuffer();

describe("a café's \"From picture\" picture", () => {
  it("is kept as the logo's square and cut into the same silhouette a logo of it would have, with its hash and version", async () => {
    const upload = (await squareOn({ r: 255, g: 255, b: 255, alpha: 1 }, { r: 20, g: 20, b: 20, alpha: 1 })).toString("base64");
    const [picture, logo] = await Promise.all([processStampPicture(upload), processLogo(upload)]);
    expect(Object.keys(picture).sort()).toEqual(["square", "stampMask", "stampMaskHash", "stampMaskVersion"]);
    expect(picture.square).toEqual(logo.square);
    expect(await size(picture.square)).toEqual({ width: LOGO_SQUARE_SIDE, height: LOGO_SQUARE_SIDE, format: "png" });
    expect(picture.stampMask).toEqual(logo.stampMask);
    expect(picture.stampMaskHash).toEqual(createHash("sha256").update(picture.stampMask).digest());
    expect(picture.stampMaskVersion).toBe(STAMP_MASK_VERSION);
  });

  it("takes what a logo takes, refused in the words of a picture", async () => {
    expect(await refusal(Buffer.from("not an image at all").toString("base64"), processStampPicture)).toBe("Upload the picture as a PNG or JPEG image.");
    expect(await refusal(await base64(picture(300, 40).png()), processStampPicture)).toBe("Use a picture at least 64 pixels wide and high.");
    expect(await refusal(Buffer.alloc(LOGO_MAX_BYTES + 1).toString("base64"), processStampPicture)).toBe("Use a picture of at most 2 MB.");
  });
});

describe("a logo's silhouette for \"From logo\" stamps", () => {
  it("is made with every upload: a white square PNG whose alpha is the silhouette, with its own hash and version", async () => {
    const logo = await processLogo((await squareOn({ r: 255, g: 255, b: 255, alpha: 1 }, { r: 20, g: 20, b: 20, alpha: 1 })).toString("base64"));
    expect(await size(logo.stampMask)).toEqual({ width: STAMP_MASK_SIDE, height: STAMP_MASK_SIDE, format: "png" });
    expect(logo.stampMaskHash).toEqual(createHash("sha256").update(logo.stampMask).digest());
    expect(logo.stampMaskVersion).toBe(STAMP_MASK_VERSION);
  });

  it("keeps a transparent logo's inner detail: its dark parts inked, its light parts holes", async () => {
    // A light 160-pixel badge on a transparent background, with a dark 120 x 30 bar across its middle.
    const badge = await sharp({ create: { width: 200, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([
        { input: { create: { width: 160, height: 160, channels: 4, background: { r: 235, g: 225, b: 200, alpha: 1 } } }, left: 20, top: 20 },
        { input: { create: { width: 120, height: 30, channels: 4, background: { r: 30, g: 20, b: 20, alpha: 1 } } }, left: 40, top: 85 },
      ])
      .png()
      .toBuffer();
    const mask = await stampSilhouette(badge);
    // Trimmed to the dark bar, centred: the bar is inked, and above it is see-through (an inked badge would fill it).
    expect(await alphaAt(mask, 0.5, 0.5)).toBe(255);
    expect(await alphaAt(mask, 0.5, 0.15)).toBe(0);
    const ring = await stampSilhouette(
      await sharp({ create: { width: 200, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([
          { input: { create: { width: 160, height: 160, channels: 4, background: { r: 30, g: 20, b: 20, alpha: 1 } } }, left: 20, top: 20 },
          { input: { create: { width: 60, height: 60, channels: 4, background: { r: 235, g: 225, b: 200, alpha: 1 } } }, left: 70, top: 70 },
        ])
        .png()
        .toBuffer(),
    );
    // A dark badge with a light middle: the badge inked, the middle a hole (an outline would have filled it).
    expect(await alphaAt(ring, 0.05, 0.05)).toBe(255);
    expect(await alphaAt(ring, 0.5, 0.5)).toBe(0);
  });

  it("takes a one-colour transparent logo's whole visible shape, trimmed to it so it fills the stamp", async () => {
    const mask = await stampSilhouette(await squareOn({ r: 0, g: 0, b: 0, alpha: 0 }, { r: 200, g: 30, b: 30, alpha: 1 }));
    // The 100-pixel square, trimmed, fills the whole silhouette.
    expect(await alphaAt(mask, 0.05, 0.05)).toBe(255);
    expect(await alphaAt(mask, 0.5, 0.5)).toBe(255);
  });

  it("cuts an opaque logo by brightness, its dark parts inked: dark on light, or a dark background around light", async () => {
    const darkOnLight = await stampSilhouette(
      await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 250, g: 250, b: 250 } } })
        .composite([{ input: { create: { width: 100, height: 100, channels: 3, background: { r: 30, g: 30, b: 30 } } }, left: 0, top: 50 }])
        .png()
        .toBuffer(),
    );
    // The dark square, trimmed and centred: solid in the middle, see-through beside it.
    expect(await alphaAt(darkOnLight, 0.5, 0.5)).toBe(255);
    // Light on dark: the dark background is inked and the light square in it is a hole.
    const lightOnDark = await stampSilhouette(await squareOn({ r: 10, g: 10, b: 60, alpha: 1 }, { r: 240, g: 240, b: 240, alpha: 1 }));
    expect(await alphaAt(lightOnDark, 0.5, 0.5)).toBe(0);
    expect(await alphaAt(lightOnDark, 0.05, 0.05)).toBe(255);
    // A wide logo's silhouette, centred on the square, leaves its top and bottom see-through.
    const wide = await stampSilhouette(
      await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 250, g: 250, b: 250 } } })
        .composite([{ input: { create: { width: 200, height: 50, channels: 3, background: { r: 30, g: 30, b: 30 } } }, left: 50, top: 75 }])
        .png()
        .toBuffer(),
    );
    expect(await alphaAt(wide, 0.5, 0.5)).toBe(255);
    expect(await alphaAt(wide, 0.5, 0.05)).toBe(0);
  });

  it("is a full square for a logo of one flat colour, light or dark, which has nothing to cut out", async () => {
    for (const grey of [30, 90, 240]) {
      const mask = await stampSilhouette(await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: grey, g: grey, b: grey } } }).png().toBuffer());
      expect(await alphaAt(mask, 0.02, 0.02), String(grey)).toBe(255);
      expect(await alphaAt(mask, 0.98, 0.98), String(grey)).toBe(255);
    }
  });

  it("splits a histogram where its two groups are furthest apart", () => {
    const histogram = new Array<number>(256).fill(0);
    histogram[20] = 100;
    histogram[220] = 100;
    const threshold = otsuThreshold(histogram);
    expect(threshold).toBeGreaterThanOrEqual(20);
    expect(threshold).toBeLessThan(220);
  });
});
