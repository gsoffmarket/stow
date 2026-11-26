// Notes and replies between the work group and the glasses (PRD §10.8).
//
// A coordinator note reaches the picker's glasses; the picker answers with a
// quick reply that the bot posts to the group under the order. Messages never
// change quantities, revision or version: a note that says "only send 2" is
// read, not applied. That is also why a note can arrive mid-pick without
// making the picker's next confirmation stale.

import type pg from "pg";
import { transaction, type Actor } from "./fulfilment.ts";

/** Quick replies are fixed text chosen by ID, so the glasses never send free text. */
export const quickReplies = [
  { id: "ON_IT", text: "On it" },
  { id: "FOUND", text: "Found them" },
  { id: "NOT_FOUND", text: "Can't find it" },
  { id: "NEED_TIME", text: "Need 5 minutes" },
] as const;

export type QuickReplyId = (typeof quickReplies)[number]["id"];

/** Note is an unread coordinator note as the glasses show it. */
export type Note = { readonly id: string; readonly body: string; readonly author: string };

/** postNote attaches a coordinator note to an open order. */
export async function postNote(pool: pg.Pool, workspaceId: string, orderId: string, authorId: string, body: string): Promise<"POSTED" | "CLOSED"> {
  return transaction(pool, async (client) => {
    const order = await client.query<{ terminal: string | null }>("select terminal from orders where workspace_id = $1 and id = $2", [workspaceId, orderId]);
    if (!order.rows[0] || order.rows[0].terminal) return "CLOSED";
    const { rows } = await client.query<{ id: string }>(
      "insert into order_messages (workspace_id, order_id, direction, author_member_id, body) values ($1, $2, 'TO_PICKER', $3, $4) returning id",
      [workspaceId, orderId, authorId, body.trim().slice(0, 280)],
    );
    await refreshStatus(client, workspaceId, orderId, `note:${rows[0]!.id}:posted`);
    return "POSTED";
  });
}

/** unreadNote is the oldest note the worker has not yet marked read on their current order. */
export async function unreadNote(client: pg.ClientBase, orderId: string): Promise<Note | null> {
  const { rows } = await client.query<{ id: string; body: string; author: string }>(
    `select n.id, n.body, m.display_name as author from order_messages n join members m on m.id = n.author_member_id
     where n.order_id = $1 and n.direction = 'TO_PICKER' and n.read_at is null order by n.created_at limit 1`,
    [orderId],
  );
  return rows[0] ?? null;
}

/** markRead records that the assigned picker saw a note; the group's status message says so. */
export async function markRead(pool: pg.Pool, actor: Actor, messageId: string): Promise<boolean> {
  return transaction(pool, async (client) => {
    const { rows } = await client.query<{ order_id: string }>(
      `update order_messages n set read_at = now()
       from assignments a
       where n.workspace_id = $1 and n.id = $2 and n.direction = 'TO_PICKER' and n.read_at is null
         and a.order_id = n.order_id and a.worker_id = $3 and a.released_at is null
       returning n.order_id`,
      [actor.workspaceId, messageId, actor.memberId],
    );
    if (!rows[0]) return false;
    await refreshStatus(client, actor.workspaceId, rows[0].order_id, `note:${messageId}:read`);
    return true;
  });
}

export type ReplyResult = "SENT" | "NOT_ASSIGNED" | "UNKNOWN_REPLY";

/**
 * sendReply posts a quick reply to the order's group, once per client ID.
 * Only the picker assigned to the order can reply on it.
 */
export async function sendReply(pool: pg.Pool, actor: Actor, orderId: string, clientId: string, replyId: string): Promise<ReplyResult> {
  const reply = quickReplies.find((candidate) => candidate.id === replyId);
  if (!reply) return "UNKNOWN_REPLY";
  return transaction(pool, async (client) => {
    const assigned = await client.query(
      "select 1 from assignments where workspace_id = $1 and order_id = $2 and worker_id = $3 and released_at is null",
      [actor.workspaceId, orderId, actor.memberId],
    );
    if (!assigned.rowCount) return "NOT_ASSIGNED";
    const inserted = await client.query<{ id: string }>(
      `insert into order_messages (workspace_id, order_id, direction, author_member_id, body, client_id)
       values ($1, $2, 'TO_GROUP', $3, $4, $5) on conflict (author_member_id, client_id) do nothing returning id`,
      [actor.workspaceId, orderId, actor.memberId, reply.text, clientId],
    );
    // A retried send finds its row already there and queues nothing new.
    const messageId = inserted.rows[0]?.id;
    if (messageId) {
      await client.query(
        `insert into telegram_outbox (workspace_id, connection_id, order_id, kind, dedupe_key, payload)
         select o.workspace_id, c.id, o.id, 'REPLY', 'reply:' || $3, jsonb_build_object('messageId', $3::text)
         from orders o join telegram_connections c on c.id = o.connection_id and c.status = 'ACTIVE'
         where o.workspace_id = $1 and o.id = $2`,
        [actor.workspaceId, orderId, messageId],
      );
    }
    return "SENT";
  });
}

// A note does not change the order's version, so its status refresh is
// marked to skip the "already shown this version" check.
async function refreshStatus(client: pg.ClientBase, workspaceId: string, orderId: string, reason: string): Promise<void> {
  await client.query(
    `insert into telegram_outbox (workspace_id, connection_id, order_id, kind, dedupe_key, payload)
     select o.workspace_id, c.id, o.id, 'STATUS', 'status:' || o.id || ':' || $3, '{"force": true}'
     from orders o join telegram_connections c on c.id = o.connection_id and c.status = 'ACTIVE'
     where o.workspace_id = $1 and o.id = $2
     on conflict (workspace_id, dedupe_key) do nothing`,
    [workspaceId, orderId, reason],
  );
}
