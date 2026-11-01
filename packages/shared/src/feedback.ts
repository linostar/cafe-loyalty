import { z } from "zod";

const timestamp = z.iso.datetime({ offset: false });

/** The inbox shows this many messages a page, newest first; "Show older messages" loads the next page. */
export const FEEDBACK_PAGE_SIZE = 50;

/** A customer's private message (AC 37): what they wrote, when, the hour of the visit it is about, and whether the owner read it. */
export const feedbackItemSchema = z.object({ id: z.uuid(), message: z.string(), receivedAt: timestamp, visitedAt: timestamp, read: z.boolean() });

/** A page of the owner's inbox, newest first, with how many are unread in all; `nextCursor` fetches the older page. */
export const feedbackInboxSchema = z.object({ items: z.array(feedbackItemSchema), unread: z.int().min(0), nextCursor: z.string().nullable() });

/** The answer to marking a message read. */
export const feedbackReadSchema = z.object({ read: z.literal(true) });

export type FeedbackItem = z.output<typeof feedbackItemSchema>;
export type FeedbackInbox = z.output<typeof feedbackInboxSchema>;
