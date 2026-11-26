// The Telegram groups a workspace is connected to, for the Telegram page in
// the Mini App. Connecting happens in the group itself (/stow_connect), where
// Telegram proves who sent it; this module only lists and disconnects.
//
// Disconnecting marks the connection DISCONNECTED and nothing more. Every
// path that posts to a group or reads from one already requires an ACTIVE
// connection, so the group goes quiet at once, and orders already created
// from it carry on in Stow and the glasses.

import type pg from "pg";
import { transaction, type Actor } from "./fulfilment.ts";

/** Group is one connected Telegram group. */
export type Group = {
  readonly id: string;
  readonly title: string | null;
  readonly connectedAt: string;
  readonly connectedBy: string;
  readonly openOrders: number;
};

/** Delivery is how Telegram sending has gone in the last 24 hours. */
export type Delivery = { readonly undelivered: number };

/** listGroups returns the workspace's active groups and recent delivery failures. */
export async function listGroups(pool: pg.Pool, workspaceId: string): Promise<{ groups: Group[]; delivery: Delivery }> {
  const groups = await pool.query<{ id: string; title: string | null; created_at: Date; connected_by: string; open_orders: number }>(
    `select c.id, c.chat_title as title, c.created_at, m.display_name as connected_by,
            (select count(*)::int from orders o where o.connection_id = c.id and o.terminal is null) as open_orders
     from telegram_connections c join members m on m.workspace_id = c.workspace_id and m.id = c.bound_by
     where c.workspace_id = $1 and c.status = 'ACTIVE' order by c.created_at limit 20`,
    [workspaceId],
  );
  const failed = await pool.query<{ n: number }>(
    "select count(*)::int as n from telegram_outbox where workspace_id = $1 and status in ('FAILED', 'UNCERTAIN') and created_at > now() - interval '24 hours'",
    [workspaceId],
  );
  return {
    groups: groups.rows.map((row) => ({ id: row.id, title: row.title, connectedAt: row.created_at.toISOString(), connectedBy: row.connected_by, openOrders: row.open_orders })),
    delivery: { undelivered: failed.rows[0]!.n },
  };
}

export type Disconnect = { readonly ok: true } | { readonly ok: false; readonly code: "ROLE_REQUIRED" | "NOT_FOUND" };

/** disconnectGroup stops a group driving the workspace; an owner can reconnect it with /stow_connect. */
export function disconnectGroup(pool: pg.Pool, actor: Actor, connectionId: string): Promise<Disconnect> {
  if (actor.role !== "OWNER") return Promise.resolve({ ok: false, code: "ROLE_REQUIRED" });
  return transaction(pool, async (client) => {
    await client.query("select 1 from workspaces where id = $1 for update", [actor.workspaceId]);
    const { rowCount } = await client.query(
      "update telegram_connections set status = 'DISCONNECTED' where workspace_id = $1 and id = $2 and status = 'ACTIVE'",
      [actor.workspaceId, connectionId],
    );
    return rowCount ? { ok: true } : { ok: false, code: "NOT_FOUND" };
  });
}
