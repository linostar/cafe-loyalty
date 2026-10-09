import { readFile, readdir } from "node:fs/promises";
import { COUNTER_SUPPORT_DAYS, SYNC_STATUSES, devicePublicKeySchema } from "@cafe-loyalty/shared";
import { z } from "zod";

/** A counter release's sync requests and the results the API gave them, frozen when it shipped (AC 27). */
export const syncFixtureSchema = z.object({
  build: z.string(),
  builtAt: z.iso.datetime({ offset: false }),
  /** The time the events were recorded; the replay runs at this server time, so the clock-skew rules match. */
  recordedAt: z.iso.datetime({ offset: false }),
  device: z.object({ deviceId: z.uuid(), keyId: z.uuid(), publicKey: devicePublicKeySchema }),
  staffId: z.uuid(),
  requests: z
    .array(
      z.object({
        events: z.array(z.record(z.string(), z.unknown())).min(1),
        results: z.array(z.object({ status: z.enum(SYNC_STATUSES), code: z.string() })),
      }),
    )
    .min(1),
});

export type SyncFixture = z.output<typeof syncFixtureSchema>;

const FIXTURES_DIR = new URL("../../sync-fixtures/", import.meta.url);

/** Every frozen fixture, by file name. */
export async function loadSyncFixtures(): Promise<{ name: string; fixture: SyncFixture }[]> {
  const names = (await readdir(FIXTURES_DIR)).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(
    names.map(async (name) => ({ name, fixture: syncFixtureSchema.parse(JSON.parse(await readFile(new URL(name, FIXTURES_DIR), "utf8"))) })),
  );
}

/** Whether a counter build made at `builtAt` is inside the support window of a release built at `releaseBuiltAt` (AC 26). */
export const inSupportWindow = (builtAt: string, releaseBuiltAt: Date): boolean =>
  Date.parse(builtAt) >= releaseBuiltAt.getTime() - COUNTER_SUPPORT_DAYS * 24 * 60 * 60 * 1000;
