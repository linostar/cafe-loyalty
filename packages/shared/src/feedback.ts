import { z } from "zod";

const timestamp = z.iso.datetime({ offset: false });

/** The inbox shows this many messages, newest first. ponytail: no paging; add it (as the review queue pages) when a café outgrows it. */
export const FEEDBACK_INBOX_LIMIT = 200;

/** A customer's private message (AC 37): what they wrote, when, the hour of the visit it is about, and whether the owner read it. */
export const feedbackItemSchema = z.object({ id: z.uuid(), message: z.string(), receivedAt: timestamp, visitedAt: timestamp, read: z.boolean() });

/** The owner's inbox: the newest messages, how many are unread in all, and whether older ones were left out. */
export const feedbackInboxSchema = z.object({ items: z.array(feedbackItemSchema), unread: z.int().min(0), more: z.boolean() });

/** The answer to marking a message read. */
export const feedbackReadSchema = z.object({ read: z.literal(true) });

export type FeedbackItem = z.output<typeof feedbackItemSchema>;
export type FeedbackInbox = z.output<typeof feedbackInboxSchema>;
