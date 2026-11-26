// Orders that could not be created as typed. An /order line that names no
// product, or an alias several products share, is never guessed: the whole
// order is kept as a draft that no one can pick. A coordinator chooses the
// product for each unclear line in the Mini App and confirms, and only then
// does the order exist.
//
// Confirming goes through createOrder with the draft's own source key, so the
// order is created once however often confirm is retried, and its status
// message reaches the group exactly as for an order typed correctly. A draft
// is marked confirmed after the order exists; a crash in between leaves an
// open draft whose next confirm finds the same order.

import type pg from "pg";
import type { Match } from "./catalogue.ts";
import { createOrder, type Actor } from "./fulfilment.ts";

/** DraftLine is one typed line: the SKU once it names one product, and the products an ambiguous alias could mean. */
export type DraftLine = { readonly item: string; readonly quantity: number; readonly sku: string | null; readonly candidates: readonly string[] };

export type Draft = {
  readonly id: string;
  readonly ref: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lines: readonly DraftLine[];
};

export type NewDraft = {
  readonly workspaceId: string;
  readonly createdBy: string;
  readonly sourceKey: string;
  readonly connectionId: string | null;
  readonly sourceMessageId: string | null;
  readonly ref: string | null;
  readonly lines: readonly { item: string; quantity: number; match: Match }[];
};

/** saveDraft keeps an unclear order; the same source sent twice keeps one draft. */
export async function saveDraft(pool: pg.Pool, input: NewDraft): Promise<string> {
  const lines: DraftLine[] = input.lines.map(({ item, quantity, match }) => ({
    item,
    quantity,
    sku: match.kind === "MATCHED" ? match.sku : null,
    candidates: match.kind === "AMBIGUOUS" ? match.skus : [],
  }));
  const { rows } = await pool.query<{ id: string }>(
    `insert into order_drafts (workspace_id, ref, source_key, connection_id, source_message_id, created_by, lines)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (workspace_id, source_key) do update set source_key = excluded.source_key
     returning id`,
    [input.workspaceId, input.ref, input.sourceKey, input.connectionId, input.sourceMessageId, input.createdBy, JSON.stringify(lines)],
  );
  return rows[0]!.id;
}

const openDrafts_max = 50;

/** drafts lists a workspace's open drafts, oldest first. */
export async function drafts(pool: pg.Pool, workspaceId: string): Promise<Draft[]> {
  const { rows } = await pool.query<DraftRow>(
    `${selectDraft} where d.workspace_id = $1 and d.status = 'OPEN' and d.expires_at > now() order by d.created_at, d.id limit ${openDrafts_max}`,
    [workspaceId],
  );
  return rows.map(toDraft);
}

/** draft reads one open draft, or null when it is gone, decided or expired. */
export async function draft(pool: pg.Pool, workspaceId: string, draftId: string): Promise<Draft | null> {
  const { rows } = await pool.query<DraftRow>(`${selectDraft} where d.workspace_id = $1 and d.id = $2 and d.status = 'OPEN' and d.expires_at > now()`, [
    workspaceId,
    draftId,
  ]);
  return rows[0] ? toDraft(rows[0]) : null;
}

export type ConfirmResult =
  | { readonly ok: true; readonly orderId: string; readonly ref: string }
  | { readonly ok: false; readonly code: "ROLE_REQUIRED" | "NOT_FOUND" | "REF_TAKEN" }
  | { readonly ok: false; readonly code: "UNKNOWN_SKU"; readonly skus: readonly string[] };

/**
 * confirmDraft creates the order from the lines the coordinator settled on,
 * which the caller has already checked for shape, limits and repeats.
 */
export async function confirmDraft(pool: pg.Pool, actor: Actor, draftId: string, lines: readonly { sku: string; quantity: number }[]): Promise<ConfirmResult> {
  if (actor.role !== "OWNER" && actor.role !== "COORDINATOR") return { ok: false, code: "ROLE_REQUIRED" };
  const { rows } = await pool.query<{ ref: string | null; source_key: string; connection_id: string | null; source_message_id: string | null; status: string; order_id: string | null }>(
    "select ref, source_key, connection_id, source_message_id, status, order_id from order_drafts where workspace_id = $1 and id = $2 and expires_at > now()",
    [actor.workspaceId, draftId],
  );
  const found = rows[0];
  if (!found || found.status === "DISCARDED") return { ok: false, code: "NOT_FOUND" };
  const created = await createOrder(pool, {
    workspaceId: actor.workspaceId,
    createdBy: actor.memberId,
    sourceKey: found.source_key,
    connectionId: found.connection_id,
    sourceMessageId: found.source_message_id,
    request: { ref: found.ref, lines },
  });
  if (!created.ok) return "unknownSkus" in created ? { ok: false, code: "UNKNOWN_SKU", skus: created.unknownSkus } : { ok: false, code: "REF_TAKEN" };
  await pool.query("update order_drafts set status = 'CONFIRMED', order_id = $3 where workspace_id = $1 and id = $2 and status = 'OPEN'", [
    actor.workspaceId,
    draftId,
    created.orderId,
  ]);
  return { ok: true, orderId: created.orderId, ref: created.ref };
}

/** discardDraft drops an open draft; nothing was ever pickable, so nothing needs undoing. */
export async function discardDraft(pool: pg.Pool, actor: Actor, draftId: string): Promise<"DISCARDED" | "ROLE_REQUIRED" | "NOT_FOUND"> {
  if (actor.role !== "OWNER" && actor.role !== "COORDINATOR") return "ROLE_REQUIRED";
  const { rowCount } = await pool.query("update order_drafts set status = 'DISCARDED' where workspace_id = $1 and id = $2 and status = 'OPEN'", [actor.workspaceId, draftId]);
  return rowCount ? "DISCARDED" : "NOT_FOUND";
}

type DraftRow = { id: string; ref: string | null; created_by: string; created_at: Date; expires_at: Date; lines: DraftLine[] };

const selectDraft = `select d.id, d.ref, m.display_name as created_by, d.created_at, d.expires_at, d.lines
  from order_drafts d join members m on m.workspace_id = d.workspace_id and m.id = d.created_by`;

function toDraft(row: DraftRow): Draft {
  return { id: row.id, ref: row.ref, createdBy: row.created_by, createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(), lines: row.lines };
}
