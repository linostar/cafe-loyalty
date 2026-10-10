import { withCafe, type Database } from "@cafe-loyalty/db";
import { ApiError, FEEDBACK_INBOX_LIMIT, type FeedbackInbox } from "@cafe-loyalty/shared";
import type { FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { ownerOf } from "./access.js";
import { parseInput } from "./http-errors.js";

export interface FeedbackRoutesOptions {
  db: Kysely<Database>;
}

const idParams = z.object({ id: z.uuid("Use an id from the list.") });

/**
 * The owner's inbox of customers' private feedback (AC 37), owner only (AC 20). A message says nothing of who sent it
 * beyond its visit's hour: the café has no way to reply, and the customer was told the message is anonymous.
 */
export function feedbackRoutes(app: FastifyInstance, options: FeedbackRoutesOptions, done: (error?: Error) => void): void {
  const { db } = options;

  /** The newest messages, with the number unread in all. */
  app.get("/feedback", { config: { access: "owner" } }, async (request): Promise<FeedbackInbox> => {
    const owner = ownerOf(request);
    const { rows, unread } = await withCafe(db, owner.cafeId, async (trx) => ({
      rows: await trx
        .selectFrom("feedback")
        .innerJoin("feedback_requests", "feedback_requests.id", "feedback.request_id")
        .innerJoin("visits", "visits.id", "feedback_requests.visit_id")
        // The visit's hour only: its exact time could tell staff who wrote the message.
        .select(["feedback.id", "feedback.message", "feedback.created_at", "feedback.read_at", sql<Date>`date_trunc('hour', visits.occurred_at)`.as("visit_hour")])
        .orderBy("feedback.created_at", "desc")
        .orderBy("feedback.id", "desc")
        .limit(FEEDBACK_INBOX_LIMIT + 1)
        .execute(),
      unread: Number(
        (await trx.selectFrom("feedback").select(sql<string>`count(*)`.as("count")).where("read_at", "is", null).executeTakeFirstOrThrow()).count,
      ),
    }));
    return {
      items: rows.slice(0, FEEDBACK_INBOX_LIMIT).map((row) => ({
        id: row.id,
        message: row.message,
        receivedAt: row.created_at.toISOString(),
        visitedAt: row.visit_hour.toISOString(),
        read: row.read_at !== null,
      })),
      unread,
      more: rows.length > FEEDBACK_INBOX_LIMIT,
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
      throw new ApiError("NOT_FOUND", "This message does not exist. Reload the inbox.");
    }
    return { read: true as const };
  });

  done();
}
