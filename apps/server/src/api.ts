import type { Database, PgBoss } from "@cafe-loyalty/db";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { registerAccessControl } from "./access.js";
import type { BackgroundTasks } from "./background.js";
import type { CustomerSecrets } from "./customer-crypto.js";
import { cafeRoutes } from "./cafe-routes.js";
import { campaignRoutes } from "./campaign-routes.js";
import { deviceRoutes } from "./device-routes.js";
import type { Mailer } from "./mailer.js";
import { ownerAuthRoutes } from "./owner-auth.js";
import { stampingRoutes } from "./stamping.js";
import { staffRoutes } from "./staff-routes.js";
import { syncRoutes } from "./sync-routes.js";

export interface ApiOptions {
  db: Kysely<Database>;
  mailer: Mailer;
  background: BackgroundTasks;
  /** Public dashboard address (invite and reset links). */
  dashboardUrl: string;
  /** Public counter app address (pairing QR codes). */
  counterUrl: string;
  /** This server's public address (café signup QR codes). */
  publicUrl: string;
  /** When this release was built: counter builds more than COUNTER_SUPPORT_DAYS older are refused new actions. */
  releaseBuiltAt: Date;
  /** Card QR keys and the phone lookup pepper, to identify the cards of visits and redemptions. */
  secrets: CustomerSecrets;
  /** The job queue (send only), for pass updates queued with stamps and redemptions; undefined when it could not start. */
  jobs: PgBoss | undefined;
}

/** Every API route, behind the access control each declares. Register with `{ prefix: "/api" }`. */
export function apiRoutes(app: FastifyInstance, options: ApiOptions, done: (error?: Error) => void): void {
  registerAccessControl(app, options.db);
  void app.register(ownerAuthRoutes, { prefix: "/auth", db: options.db, mailer: options.mailer, background: options.background, dashboardUrl: options.dashboardUrl });
  void app.register(cafeRoutes, { db: options.db, publicUrl: options.publicUrl });
  void app.register(campaignRoutes, { db: options.db, jobs: options.jobs });
  void app.register(staffRoutes, { db: options.db });
  void app.register(deviceRoutes, { db: options.db, counterUrl: options.counterUrl, releaseBuiltAt: options.releaseBuiltAt });
  void app.register(syncRoutes, { db: options.db, secrets: options.secrets, jobs: options.jobs });
  void app.register(stampingRoutes, { db: options.db, secrets: options.secrets, jobs: options.jobs, releaseBuiltAt: options.releaseBuiltAt });
  done();
}
