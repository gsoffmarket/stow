// Read models for the coordinator console in the Mini App. Writes go through
// the same command runner as Telegram and the glasses; this module only reads.

import type pg from "pg";
import { transaction } from "./fulfilment.ts";

export type Hold = "NONE" | "AWAITING_PICKER" | "BLOCKED" | "CANCELLING" | "RELEASING" | "PAUSED";

/** OrderRow is one order as the console list shows it. */
export type OrderRow = {
  readonly id: string;
  readonly ref: string;
  readonly terminal: "COMPLETED" | "CANCELLED" | null;
  readonly hold: Hold;
  readonly picker: string | null;
  /** False while an assigned picker has not started the order; null when nobody holds it. */
  readonly isAccepted: boolean | null;
  readonly toteId: string | null;
  readonly confirmed: number;
  readonly requested: number;
  readonly lines: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** View picks which orders a list shows; "needs_you" is what a coordinator must act on now. */
export type View = "needs_you" | "active" | "done";

const filters: Record<View, string> = {
  needs_you: "o.terminal is null and exists (select 1 from order_exceptions e where e.order_id = o.id and e.status = 'OPEN')",
  active: "o.terminal is null",
  done: "o.terminal is not null",
};

/** pageSize is how many orders one list request returns at most. */
export const pageSize = 50;

/** Cursor is the last row of a page in list order. */
export type Cursor = { readonly updatedAt: string; readonly id: string };

/** OrderQuery narrows a list: a search over ref, SKU and picker, and where the previous page ended. */
export type OrderQuery = { readonly view: View; readonly search: string | null; readonly after: Cursor | null };

/**
 * listOrders returns one page of a workspace's orders, newest activity first,
 * and a cursor when there may be more. Paging is by (updated_at, id), so a
 * page never repeats or skips an order that did not change in between.
 */
export async function listOrders(pool: pg.Pool, workspaceId: string, query: OrderQuery): Promise<{ orders: OrderRow[]; next: Cursor | null }> {
  const conditions = [filters[query.view]];
  const params: unknown[] = [];
  if (query.search) {
    // ilike treats % and _ as wildcards; a search for "A_1" means those characters.
    params.push(`%${query.search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`);
    const search = `$${params.length + 1}`;
    conditions.push(`(o.ref ilike ${search} or m.display_name ilike ${search} or exists (select 1 from order_lines s where s.order_id = o.id and s.sku_snapshot ilike ${search}))`);
  }
  if (query.after) {
    // The cursor came back through a JS Date, which keeps milliseconds only;
    // the sort truncates the same way so the comparison is exact.
    params.push(query.after.updatedAt, query.after.id);
    conditions.push(`(date_trunc('milliseconds', o.updated_at), o.id) < ($${params.length}::timestamptz, $${params.length + 1}::uuid)`);
  }
  const rows = await selectOrders(pool, workspaceId, conditions.join(" and "), params, pageSize + 1);
  const page = rows.slice(0, pageSize);
  const last = page.at(-1);
  return { orders: page, next: rows.length > pageSize && last ? { updatedAt: last.updatedAt, id: last.id } : null };
}

type Queryable = Pick<pg.ClientBase, "query">;

// One query shape for the list and the detail header, so they always agree.
async function selectOrders(db: Queryable, workspaceId: string, condition: string, params: unknown[], limit = 1): Promise<OrderRow[]> {
  const { rows } = await db.query<{
    id: string; ref: string; terminal: OrderRow["terminal"]; revision: number; created_at: Date; updated_at: Date;
    picker: string | null; tote_id: string | null; ack_revision: number | null; is_accepted: boolean | null; is_paused: boolean; is_cancel_requested: boolean; is_release_requested: boolean;
    is_blocked: boolean; confirmed: number; requested: number; lines: number;
  }>(
    `select o.id, o.ref, o.terminal, o.revision, o.created_at, o.updated_at, o.is_paused, o.is_cancel_requested, o.is_release_requested,
            m.display_name as picker, a.tote_id, a.ack_revision, a.is_accepted,
            exists (select 1 from order_exceptions e where e.order_id = o.id and e.status = 'OPEN') as is_blocked,
            l.confirmed, l.requested, l.lines
     from orders o
     left join assignments a on a.order_id = o.id and a.released_at is null
     left join members m on m.id = a.worker_id
     cross join lateral (
       select coalesce(sum(least(picked_qty, requested_qty)), 0)::int as confirmed, coalesce(sum(requested_qty), 0)::int as requested, count(*)::int as lines
       from order_lines where order_id = o.id
     ) l
     where o.workspace_id = $1 and ${condition}
     order by date_trunc('milliseconds', o.updated_at) desc, o.id desc limit ${limit}`,
    [workspaceId, ...params],
  );
  return rows.map((row) => ({
    id: row.id,
    ref: row.ref,
    terminal: row.terminal,
    hold: row.is_blocked ? "BLOCKED"
      : row.is_accepted === false || (row.ack_revision !== null && row.ack_revision !== row.revision) ? "AWAITING_PICKER"
      : row.is_cancel_requested ? "CANCELLING"
      : row.is_release_requested ? "RELEASING"
      : row.is_paused ? "PAUSED"
      : "NONE",
    picker: row.picker,
    isAccepted: row.is_accepted,
    toteId: row.tote_id,
    confirmed: row.confirmed,
    requested: row.requested,
    lines: row.lines,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));
}

export type OrderDetail = {
  readonly order: OrderRow & { readonly version: string };
  readonly lines: readonly { readonly id: string; readonly sku: string; readonly name: string; readonly bin: string | null; readonly requested: number; readonly picked: number }[];
  readonly exception: { readonly id: string; readonly type: string; readonly lineId: string | null; readonly sku: string | null; readonly reportedQty: number | null; readonly status: string } | null;
  readonly timeline: readonly { readonly seq: string; readonly type: string; readonly actor: string | null; readonly at: string; readonly detail: string | null }[];
  readonly messages: readonly { readonly direction: "TO_PICKER" | "TO_GROUP"; readonly body: string; readonly author: string; readonly at: string; readonly isRead: boolean }[];
};

/** orderDetail is everything the console shows for one order, read in one snapshot. */
export async function orderDetail(pool: pg.Pool, workspaceId: string, orderId: string): Promise<OrderDetail | null> {
  return transaction(pool, async (client) => {
    const summary = await client.query<{ version: string }>("select version from orders where workspace_id = $1 and id = $2", [workspaceId, orderId]);
    if (!summary.rows[0]) return null;
    const row = (await selectOrders(client, workspaceId, "o.id = $2", [orderId]))[0]!;
    const lines = await client.query<{ id: string; sku: string; name: string; bin: string | null; requested: number; picked: number }>(
      `select id, sku_snapshot as sku, name_snapshot as name, bin_snapshot as bin, requested_qty as requested, picked_qty as picked
       from order_lines where order_id = $1 order by creation_index`,
      [orderId],
    );
    const exception = await client.query<{ id: string; type: string; line_id: string | null; sku: string | null; reported_qty: number | null; status: string }>(
      `select e.id, e.type, e.line_id, l.sku_snapshot as sku, e.reported_qty, e.status
       from order_exceptions e left join order_lines l on l.id = e.line_id
       where e.order_id = $1 and e.status <> 'CLOSED'`,
      [orderId],
    );
    const events = await client.query<{ seq: string; event_type: string; actor: string | null; occurred_at: Date; payload: Record<string, unknown> }>(
      `select f.seq, f.event_type, m.display_name as actor, f.occurred_at, f.payload
       from fulfilment_events f left join members m on m.id = f.actor_member_id
       where f.order_id = $1 order by f.seq desc limit 100`,
      [orderId],
    );
    const messages = await client.query<{ direction: "TO_PICKER" | "TO_GROUP"; body: string; author: string; created_at: Date; read_at: Date | null }>(
      `select n.direction, n.body, m.display_name as author, n.created_at, n.read_at
       from order_messages n join members m on m.id = n.author_member_id where n.order_id = $1 order by n.created_at`,
      [orderId],
    );
    const skuOf = new Map(lines.rows.map((line) => [line.id, line.sku]));
    const found = exception.rows[0];
    return {
      order: { ...row, version: summary.rows[0].version },
      lines: lines.rows,
      exception: found ? { id: found.id, type: found.type, lineId: found.line_id, sku: found.sku, reportedQty: found.reported_qty, status: found.status } : null,
      timeline: events.rows.map((event) => ({
        seq: event.seq,
        type: event.event_type,
        actor: event.actor,
        at: event.occurred_at.toISOString(),
        detail: describe(event.event_type, event.payload, skuOf),
      })),
      messages: messages.rows.map((message) => ({
        direction: message.direction,
        body: message.body,
        author: message.author,
        at: message.created_at.toISOString(),
        isRead: message.read_at !== null,
      })),
    };
  }, "repeatable read");
}

// One short line per event for the timeline, from its typed payload.
function describe(type: string, payload: Record<string, unknown>, skuOf: Map<string, string>): string | null {
  const sku = typeof payload.lineId === "string" ? skuOf.get(payload.lineId) : undefined;
  if ((type === "PICK_CONFIRMED" || type === "RETURN_CONFIRMED") && sku) return `${sku} × ${String(payload.quantity)}`;
  if (type === "EXCEPTION_REPORTED") return String(payload.type).toLowerCase().replace(/_/g, " ");
  if (type === "EXCEPTION_RESOLVED") return String(payload.resolution).toLowerCase();
  if (type === "ORDER_CLAIMED" && payload.toteId) return `tote ${String(payload.toteId)}`;
  return null;
}

/** Picker is someone an order can be assigned to, with how many orders they hold now. */
export type Picker = { readonly id: string; readonly name: string; readonly openOrders: number };

/** pickers lists the workspace's pickers, least busy first. */
export async function pickers(pool: pg.Pool, workspaceId: string): Promise<Picker[]> {
  const { rows } = await pool.query<{ id: string; name: string; open_orders: number }>(
    `select m.id, m.display_name as name,
            (select count(*)::int from assignments a join orders o on o.id = a.order_id
             where a.worker_id = m.id and a.released_at is null and o.terminal is null) as open_orders
     from members m where m.workspace_id = $1 and m.role in ('PICKER', 'OWNER') and m.removed_at is null
     order by open_orders, m.display_name, m.id limit 100`,
    [workspaceId],
  );
  return rows.map((row) => ({ id: row.id, name: row.name, openOrders: row.open_orders }));
}
