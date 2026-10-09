import { writeCameraFile } from "./counter/camera.js";

/** Runs once before the browsers start: the counter's fake camera needs its video file. */
export default async function globalSetup(): Promise<void> {
  await writeCameraFile();
}
