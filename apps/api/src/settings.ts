// Workspace settings an owner controls (PRD §13.1 Settings): the time zone
// reports use, and how long closed orders are kept. There is no deletion of
// the workspace from the app; that stays with whoever runs the server.
//
// Retention is enforced by purgeExpired, which a loop in the API process runs
// every hour. It deletes a closed order with everything that hangs off it, in
// foreign-key order, and the idempotency records older than the same window,
// since their stored responses repeat order data. Open orders are never
// purged. Messages already posted to Telegram stay there.

import type pg from "pg";
import { transaction, type Actor } from "./fulfilment.ts";

/** RetentionDays is how long closed orders are kept; null keeps them. */
export type RetentionDays = 90 | 365 | null;

/** Settings is what the Settings page shows and an owner can change. */
export type Settings = { readonly timeZone: string; readonly retentionDays: RetentionDays };

/** settings reads a workspace's settings. */
export async function settings(pool: pg.Pool, workspaceId: string): Promise<Settings> {
  const { rows } = await pool.query<{ timezone: string; retention_days: RetentionDays }>("select timezone, retention_days from workspaces where id = $1", [workspaceId]);
  const row = rows[0]!;
  return { timeZone: row.timezone, retentionDays: row.retention_days };
}

/** isTimeZone accepts IANA names the runtime knows, like Africa/Lagos. */
export function isTimeZone(name: string): boolean {
  try {
    return new Intl.DateTimeFormat("en", { timeZone: name }).resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
}

export type Change = { readonly ok: true; readonly settings: Settings } | { readonly ok: false; readonly code: "ROLE_REQUIRED" };

/** changeSettings replaces both settings; the caller has checked the time zone. */
export async function changeSettings(pool: pg.Pool, actor: Actor, next: Settings): Promise<Change> {
  if (actor.role !== "OWNER") return { ok: false, code: "ROLE_REQUIRED" };
  await pool.query("update workspaces set timezone = $2, retention_days = $3, updated_at = now() where id = $1", [actor.workspaceId, next.timeZone, next.retentionDays]);
  return { ok: true, settings: next };
}

const purgeBatch = 200;

/**
 * purgeExpired deletes up to one batch of closed orders past their
 * workspace's retention, and old idempotency records, and returns how many
 * orders went. Run it until it returns less than a batch.
 */
export async function purgeExpired(pool: pg.Pool): Promise<number> {
  return transaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `select o.id from orders o join workspaces w on w.id = o.workspace_id
       where w.retention_days is not null and o.terminal is not null and o.updated_at < now() - make_interval(days => w.retention_days)
       order by o.updated_at limit ${purgeBatch} for update of o skip locked`,
    );
    const ids = rows.map((row) => row.id);
    if (ids.length > 0) {
      // Children before parents; order_exceptions also points at order_lines.
      for (const table of ["order_exceptions", "order_messages", "telegram_message_refs", "telegram_outbox", "assignments", "order_revisions", "order_lines", "fulfilment_events", "order_drafts"]) {
        await client.query(`delete from ${table} where order_id = any($1::uuid[])`, [ids]);
      }
      await client.query("delete from orders where id = any($1::uuid[])", [ids]);
    }
    // Drafts never became orders, or did and are kept only as a link to one; neither is needed after a week.
    await client.query("delete from order_drafts where expires_at < now()");
    await client.query(
      `delete from command_results c using workspaces w
       where w.id = c.workspace_id and w.retention_days is not null and c.created_at < now() - make_interval(days => w.retention_days)`,
    );
    return ids.length;
  });
}

const purgeInterval_ms = 60 * 60 * 1000;
const purgeRuns_max = 50;

/** runRetention purges expired data every hour until the signal aborts. */
export async function runRetention(pool: pg.Pool, signal: AbortSignal, log: (msg: string, data?: object) => void): Promise<void> {
  while (!signal.aborted) {
    try {
      // At most purgeRuns_max batches an hour, so a large first purge spreads out.
      let purged = 0;
      for (let run = 0; run < purgeRuns_max && !signal.aborted; run++) {
        const batch = await purgeExpired(pool);
        purged += batch;
        if (batch < purgeBatch) break;
      }
      if (purged > 0) log("retention purged closed orders", { orders: purged });
    } catch (error) {
      log("retention purge failed", { error: (error as Error).message });
    }
    await new Promise((resolve) => setTimeout(resolve, purgeInterval_ms).unref());
  }
}
