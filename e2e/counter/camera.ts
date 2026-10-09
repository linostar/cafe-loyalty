import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encode } from "uqr";

/** The café the fake camera's card belongs to, and the card QR it shows (test data only: the mac is not real). */
export const CAMERA_CAFE_ID = "0b9a3c4d-1e2f-4a5b-8c7d-6e5f4a3b2c1d";
export const CAMERA_CARD_QR = `v1.5e6f7a8b-9c0d-4e5f-8a6b-7c8d9e0f1a2b.${CAMERA_CAFE_ID}.1.q1.${"M".repeat(43)}`;
/** The video Chromium plays as the counter phone's camera. */
export const CAMERA_FILE = join(tmpdir(), "cafe-loyalty-e2e-camera.y4m");

/**
 * Writes CAMERA_FILE: a still Y4M video (4:2:0) of CAMERA_CARD_QR as a QR code, black on white, which Chromium's
 * fake capture device loops as the camera picture.
 */
export async function writeCameraFile(): Promise<void> {
  const { data: modules, size } = encode(CAMERA_CARD_QR, { border: 4 });
  const scale = Math.max(2, Math.floor(480 / size)) & ~1;
  const side = size * scale;
  const luma = Buffer.alloc(side * side);
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      luma[y * side + x] = modules[Math.floor(y / scale)]?.[Math.floor(x / scale)] === true ? 16 : 235;
    }
  }
  const chroma = Buffer.alloc((side / 2) * (side / 2), 128);
  const frame = Buffer.concat([Buffer.from("FRAME\n"), luma, chroma, chroma]);
  const header = Buffer.from(`YUV4MPEG2 W${String(side)} H${String(side)} F10:1 Ip A1:1 C420jpeg\n`);
  await writeFile(CAMERA_FILE, Buffer.concat([header, frame, frame]));
}
