// Reporting over a range of calendar days (PRD FR-23, T69, T70).
//
// A range is whole days in the viewer's time zone: [from 00:00, to + 1 day
// 00:00) local, converted to UTC instants by Postgres. Every figure is
// counted by when it happened, from the event log, not from an order's
// current state, so a report for last week does not change because an order
// moved today. The definitions are spelled out in the Mini App next to each
// number.

import type pg from "pg";

/** rangeLimit_days caps a report so one request cannot scan a workspace's whole history. */
export const rangeLimit_days = 366;
const exportRows_max = 10_000;

/** Range is a validated span of calendar days in one IANA time zone. */
export type Range = { readonly from: string; readonly to: string; readonly timeZone: string };

/** parseRange checks dates and the time zone; null means the request is invalid. */
export function parseRange(from: string, to: string, timeZone: string): Range | null {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (!day.test(from) || !day.test(to)) return null;
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || new Date(start).toISOString().slice(0, 10) !== from || new Date(end).toISOString().slice(0, 10) !== to) return null;
  if (end < start || (end - start) / 86_400_000 >= rangeLimit_days) return null;
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    return null;
  }
  return { from, to, timeZone };
}

/** Report is what happened in a workspace over a range. */
export type Report = {
  readonly range: Range & { readonly startsAt: string; readonly endsAt: string };
  readonly orders: { readonly created: number; readonly completed: number; readonly cancelled: number };
  readonly unitsConfirmed: number;
  readonly problems: number;
  readonly undelivered: number;
  readonly pickers: readonly { readonly name: string; readonly completed: number; readonly units: number }[];
};

// The range's bounds as UTC instants, shared by every query below.
const bounds = `with bounds as (select ($2::date)::timestamp at time zone $4 as starts_at, ($3::date + 1)::timestamp at time zone $4 as ends_at)`;

// One row per closed order with when and how it closed. A cancelled order's
// closing event is the later of the request and the picker's close, because
// an unclaimed order is cancelled by the request alone.
const closed = `closed as (
  select o.id, o.terminal, max(e.occurred_at) as closed_at
  from orders o join fulfilment_events e on e.order_id = o.id
   and e.event_type in ('ORDER_COMPLETED', 'ORDER_CANCELLED', 'ORDER_CANCEL_REQUESTED')
  where o.workspace_id = $1 and o.terminal is not null
  group by o.id, o.terminal)`;

/** report counts orders, units, problems and delivery failures in a range. */
export async function report(pool: pg.Pool, workspaceId: string, range: Range): Promise<Report> {
  const params = [workspaceId, range.from, range.to, range.timeZone];
  const totals = await pool.query<{
    starts_at: Date; ends_at: Date; created: number; completed: number; cancelled: number; units: number; problems: number; undelivered: number;
  }>(
    `${bounds}, ${closed}
     select b.starts_at, b.ends_at,
       (select count(*)::int from fulfilment_events e where e.workspace_id = $1 and e.event_type = 'ORDER_CREATED' and e.occurred_at >= b.starts_at and e.occurred_at < b.ends_at) as created,
       (select count(*)::int from closed c where c.terminal = 'COMPLETED' and c.closed_at >= b.starts_at and c.closed_at < b.ends_at) as completed,
       (select count(*)::int from closed c where c.terminal = 'CANCELLED' and c.closed_at >= b.starts_at and c.closed_at < b.ends_at) as cancelled,
       (select coalesce(sum(least(l.picked_qty, l.requested_qty)), 0)::int from closed c join order_lines l on l.order_id = c.id
         where c.terminal = 'COMPLETED' and c.closed_at >= b.starts_at and c.closed_at < b.ends_at) as units,
       (select count(*)::int from fulfilment_events e where e.workspace_id = $1 and e.event_type = 'EXCEPTION_REPORTED' and e.occurred_at >= b.starts_at and e.occurred_at < b.ends_at) as problems,
       (select count(*)::int from telegram_outbox t where t.workspace_id = $1 and t.status in ('FAILED', 'UNCERTAIN') and t.created_at >= b.starts_at and t.created_at < b.ends_at) as undelivered
     from bounds b`,
    params,
  );
  const pickers = await pool.query<{ name: string; completed: number; units: number }>(
    `${bounds}, ${closed}
     select m.display_name as name, count(distinct c.id)::int as completed, coalesce(sum(least(l.picked_qty, l.requested_qty)), 0)::int as units
     from closed c cross join bounds b
     join assignments a on a.order_id = c.id and a.released_at is null
     join members m on m.id = a.worker_id
     join order_lines l on l.order_id = c.id
     where c.terminal = 'COMPLETED' and c.closed_at >= b.starts_at and c.closed_at < b.ends_at
     group by m.id, m.display_name order by units desc, m.display_name limit 100`,
    params,
  );
  const row = totals.rows[0]!;
  return {
    range: { ...range, startsAt: row.starts_at.toISOString(), endsAt: row.ends_at.toISOString() },
    orders: { created: row.created, completed: row.completed, cancelled: row.cancelled },
    unitsConfirmed: row.units,
    problems: row.problems,
    undelivered: row.undelivered,
    pickers: pickers.rows,
  };
}

/**
 * ordersCsv is the order history for orders created in a range, one row per
 * order, times in UTC. It is capped at 10,000 rows.
 */
export async function ordersCsv(pool: pg.Pool, workspaceId: string, range: Range): Promise<string> {
  const { rows } = await pool.query<{
    ref: string; status: string; source: string; created_at: Date; closed_at: Date | null; picker: string | null; lines: number; requested: number; confirmed: number; revision: number; problems: number;
  }>(
    `${bounds}, ${closed}
     select o.ref, coalesce(o.terminal, 'OPEN') as status,
            case when o.source_key like 'miniapp:%' then 'mini app' when o.connection_id is not null then 'telegram' else 'other' end as source,
            o.created_at, c.closed_at, m.display_name as picker,
            (select count(*)::int from order_lines l where l.order_id = o.id) as lines,
            (select coalesce(sum(l.requested_qty), 0)::int from order_lines l where l.order_id = o.id) as requested,
            (select coalesce(sum(least(l.picked_qty, l.requested_qty)), 0)::int from order_lines l where l.order_id = o.id) as confirmed,
            o.revision,
            (select count(*)::int from order_exceptions x where x.order_id = o.id) as problems
     from orders o cross join bounds b
     left join closed c on c.id = o.id
     left join assignments a on a.order_id = o.id and a.released_at is null
     left join members m on m.id = a.worker_id
     where o.workspace_id = $1 and o.created_at >= b.starts_at and o.created_at < b.ends_at
     order by o.created_at, o.id limit ${exportRows_max}`,
    [workspaceId, range.from, range.to, range.timeZone],
  );
  const header = ["ref", "status", "source", "created_at_utc", "closed_at_utc", "picker", "lines", "units_requested", "units_confirmed", "revision", "problems"];
  const lines = rows.map((row) =>
    [row.ref, row.status, row.source, row.created_at.toISOString(), row.closed_at?.toISOString() ?? "", row.picker ?? "", row.lines, row.requested, row.confirmed, row.revision, row.problems].map(cell).join(","),
  );
  return [header.join(","), ...lines].join("\r\n") + "\r\n";
}

// RFC 4180 quoting, plus a leading apostrophe on anything a spreadsheet would
// run as a formula (OWASP CSV injection): names and refs come from users.
function cell(value: string | number): string {
  if (typeof value === "number") return String(value);
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
