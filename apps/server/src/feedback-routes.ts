import { withCafe, type Database } from "@cafe-loyalty/db";
import { apiText, ApiError, FEEDBACK_PAGE_SIZE, type FeedbackInbox } from "@cafe-loyalty/shared";
import type { FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { ownerOf } from "./access.js";
import { parseInput } from "./http-errors.js";

export interface FeedbackRoutesOptions {
  db: Kysely<Database>;
}

const idParams = z.object({ id: z.uuid("Use an id from the list.") });

/** An inbox position: the created_at (microseconds, as PostgreSQL text) and id of the last message shown, as the review queue's. */
const cursorSchema = z
  .string()
  .max(200)
  .transform((value, context) => {
    try {
      const parsed = z
        .tuple([z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/), z.uuid()])
        .safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
      // A real date and time (2026-02-30 is not): checked here, so PostgreSQL never sees an impossible one.
      const [createdAt = "", id = ""] = parsed.success ? parsed.data : [];
      const date = new Date(createdAt);
      if (parsed.success && !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 23) === createdAt.slice(0, 23)) {
        return { createdAt, id };
      }
    } catch {
      // Reported below.
    }
    context.addIssue({ code: "custom", message: apiText("This list position is not valid. Reload the list.") });
    return z.NEVER;
  });
const inboxQuery = z.object({ cursor: cursorSchema.optional() });

const encodeCursor = (createdAt: string, id: string): string => Buffer.from(JSON.stringify([createdAt, id])).toString("base64url");

/**
 * The owner's inbox of customers' private feedback (AC 37), owner only (AC 20). A message says nothing of who sent it
 * beyond its visit's hour: the café has no way to reply, and the customer was told the message is anonymous.
 */
export function feedbackRoutes(app: FastifyInstance, options: FeedbackRoutesOptions, done: (error?: Error) => void): void {
  const { db } = options;

  /**
   * Messages, newest first, a page at a time, with the number unread in all. A message arriving while the owner pages
   * joins the top, so the older pages never repeat or skip one.
   */
  app.get("/feedback", { config: { access: "owner" } }, async (request): Promise<FeedbackInbox> => {
    const owner = ownerOf(request);
    const { cursor } = parseInput(inboxQuery, request.query);
    const { rows, unread } = await withCafe(db, owner.cafeId, async (trx) => {
      let query = trx
        .selectFrom("feedback")
        .innerJoin("feedback_requests", "feedback_requests.id", "feedback.request_id")
        .innerJoin("visits", "visits.id", "feedback_requests.visit_id")
        // The visit's hour only: its exact time could tell staff who wrote the message.
        .select([
          "feedback.id",
          "feedback.message",
          "feedback.created_at",
          "feedback.read_at",
          sql<Date>`date_trunc('hour', visits.occurred_at)`.as("visit_hour"),
          sql<string>`to_char(feedback.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as("position"),
        ]);
      if (cursor !== undefined) {
        query = query.where(sql<boolean>`(feedback.created_at, feedback.id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`);
      }
      return {
        rows: await query.orderBy("feedback.created_at", "desc").orderBy("feedback.id", "desc").limit(FEEDBACK_PAGE_SIZE + 1).execute(),
        unread: Number(
          (await trx.selectFrom("feedback").select(sql<string>`count(*)`.as("count")).where("read_at", "is", null).executeTakeFirstOrThrow()).count,
        ),
      };
    });
    const page = rows.slice(0, FEEDBACK_PAGE_SIZE);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        message: row.message,
        receivedAt: row.created_at.toISOString(),
        visitedAt: row.visit_hour.toISOString(),
        read: row.read_at !== null,
      })),
      unread,
      nextCursor: rows.length > FEEDBACK_PAGE_SIZE && last !== undefined ? encodeCursor(last.position, last.id) : null,
    };
  });

  /** Marks a message read; marking it again keeps its first time. */
  app.post("/feedback/:id/read", { config: { access: "owner" } }, async (request) => {
    const owner = ownerOf(request);
    const { id } = parseInput(idParams, request.params);
    const found = await withCafe(db, owner.cafeId, (trx) =>
      trx.updateTable("feedback").set({ read_at: sql<Date>`coalesce(read_at, now())` }).where("id", "=", id).returning("id").executeTakeFirst(),
    );
    if (found === undefined) {
      throw new ApiError("NOT_FOUND", apiText("This message does not exist. Reload the inbox."));
    }
    return { read: true as const };
  });

  done();
}
