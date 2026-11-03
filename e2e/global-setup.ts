import { CAMERA_CARD_QR, CAMERA_FILE, NOT_A_CARD_FILE, writeCameraFile } from "./counter/camera.js";

/** Runs once before the browsers start: the counter's fake cameras need their video files (a card, and a menu link). */
export default async function globalSetup(): Promise<void> {
  await writeCameraFile(CAMERA_CARD_QR, CAMERA_FILE);
  await writeCameraFile("https://example.com/menu", NOT_A_CARD_FILE);
}
