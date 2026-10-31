import { FEEDBACK_PAGE_SIZE, type FeedbackInbox } from "@cafe-loyalty/shared";
import { describe, expect, it } from "vitest";
import { useApiHarness, withBearer, withCookie, type SignedUpOwner } from "./testing/api-harness.js";

const context = useApiHarness();
const { harness, signUp, pairDevice, issueCard } = context;

/** `count` fake messages for one card of the owner's café, a minute apart (message 1 the oldest), with bare visit rows an hour apart behind them (the cooldown). */
async function messages(owner: SignedUpOwner, count: number): Promise<void> {
  const { cardId } = await issueCard(owner.cafeId);
  // Bare visit rows (no device, staff or signed event behind them), as the worker's tests make them.
  await context.admin.query("SET session_replication_role = replica");
  try {
    await context.admin.query(
      `WITH made AS (
         INSERT INTO app.visits (cafe_id, sync_event_id, card_id, identified_by, device_id, staff_id, occurred_at, total_cents, stamps_earned, stamps_added, outcome)
         SELECT $1, gen_random_uuid(), $2, 'qr', gen_random_uuid(), gen_random_uuid(), now() - make_interval(days => 1, hours => g::int), 300, 1, 1, 'stamped' FROM generate_series(1, $3) AS g
         RETURNING id
       ), asked AS (
         INSERT INTO app.feedback_requests (cafe_id, card_id, visit_id) SELECT $1, $2, id FROM made RETURNING id
       )
       INSERT INTO app.feedback (cafe_id, request_id, message, created_at)
       SELECT $1, id, 'Fake message ' || n, now() - make_interval(mins => ($3 - n)::int)
       FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM asked) AS numbered`,
      [owner.cafeId, cardId, count],
    );
  } finally {
    await context.admin.query("SET session_replication_role = DEFAULT");
  }
}

describe("the owner's inbox (AC 37)", () => {
  it("pages messages newest first with a cursor, and counts the unread across every page", async () => {
    const { app } = await harness();
    const owner = await signUp(app);
    const other = await signUp(app);
    const total = FEEDBACK_PAGE_SIZE + 3;
    await messages(owner, total);
    await messages(other, 2);
    const inbox = async (session: string, query = "") => {
      const response = await app.inject({ method: "GET", url: `/api/feedback${query}`, headers: withCookie(session) });
      expect(response.statusCode).toBe(200);
      return response.json<FeedbackInbox>();
    };

    const first = await inbox(owner.session);
    expect(first.items).toHaveLength(FEEDBACK_PAGE_SIZE);
    expect(first.items[0]?.message).toBe(`Fake message ${String(total)}`);
    expect(first.unread).toBe(total);
    expect(first.nextCursor).not.toBeNull();
    const second = await inbox(owner.session, `?cursor=${encodeURIComponent(first.nextCursor ?? "")}`);
    expect(second.items.map((item) => item.message)).toEqual(["Fake message 3", "Fake message 2", "Fake message 1"]);
    expect(second.nextCursor).toBeNull();
    // Every message once, newest first.
    const all = [...first.items, ...second.items].map((item) => item.receivedAt);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(total);
    expect(all).toEqual([...all].sort().reverse());

    // Read on the older page: the count, which every page carries, goes down.
    const oldest = second.items.at(-1)?.id ?? "";
    expect((await app.inject({ method: "POST", url: `/api/feedback/${oldest}/read`, headers: withCookie(owner.session), payload: {} })).statusCode).toBe(200);
    expect((await inbox(owner.session)).unread).toBe(total - 1);

    // A message arriving while the owner pages joins the top; the older page stays as it was.
    await messages(owner, 1);
    expect((await inbox(owner.session, `?cursor=${encodeURIComponent(first.nextCursor ?? "")}`)).items.map((item) => item.message)).toEqual([
      "Fake message 3",
      "Fake message 2",
      "Fake message 1",
    ]);

    // The other café's owner sees only their own two.
    expect(await inbox(other.session)).toMatchObject({ unread: 2, nextCursor: null, items: [{ message: "Fake message 2" }, { message: "Fake message 1" }] });
    // Nor can they read the first café's messages by its cursor or id.
    expect((await inbox(other.session, `?cursor=${encodeURIComponent(first.nextCursor ?? "")}`)).items).toEqual([]);
    expect((await app.inject({ method: "POST", url: `/api/feedback/${oldest}/read`, headers: withCookie(other.session), payload: {} })).statusCode).toBe(404);
  });

  it("pages messages received at the same moment by id, each exactly once across the page boundary", async () => {
    const { app } = await harness();
    const owner = await signUp(app);
    const total = FEEDBACK_PAGE_SIZE + 2;
    await messages(owner, total);
    // Every message at one instant: only the id orders them.
    await context.admin.query("UPDATE app.feedback SET created_at = '2026-10-01T10:00:00Z' WHERE cafe_id = $1", [owner.cafeId]);
    const inbox = async (query = "") => {
      const response = await app.inject({ method: "GET", url: `/api/feedback${query}`, headers: withCookie(owner.session) });
      expect(response.statusCode).toBe(200);
      return response.json<FeedbackInbox>();
    };
    const first = await inbox();
    expect(first.items).toHaveLength(FEEDBACK_PAGE_SIZE);
    const second = await inbox(`?cursor=${encodeURIComponent(first.nextCursor ?? "")}`);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items].map((item) => item.id);
    expect(ids).toHaveLength(total);
    expect(new Set(ids).size).toBe(total);
    expect(ids).toEqual([...ids].sort().reverse());
  });

  it("refuses a cursor that is not one, and anyone but the owner", async () => {
    const { app } = await harness();
    const owner = await signUp(app);
    for (const cursor of ["nope", Buffer.from(JSON.stringify(["2026-02-30T10:00:00.000000Z", "8a7f4b9e-3c2d-4e1f-9a8b-7c6d5e4f3a2b"])).toString("base64url")]) {
      const response = await app.inject({ method: "GET", url: `/api/feedback?cursor=${cursor}`, headers: withCookie(owner.session) });
      expect(response.statusCode).toBe(400);
      expect(response.json<{ code: string }>().code).toBe("VALIDATION_FAILED");
    }
    expect((await app.inject({ method: "GET", url: "/api/feedback" })).statusCode).toBe(401);
    const device = await pairDevice(app, owner);
    expect((await app.inject({ method: "GET", url: "/api/feedback", headers: withBearer(device.accessToken) })).statusCode).toBe(403);
  });
});
