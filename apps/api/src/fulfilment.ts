// Fulfilment is the imperative shell around the pure order engine. Every
// mutation follows one shape, inside a single transaction:
//
//   1. lock the workspace row (writers in a workspace queue behind it),
//   2. replay the command's stored result if this command ID was seen before,
//   3. lock and load the order, run the engine, write the new state,
//   4. append the event, store the command result, queue the Telegram update.
//
// Nothing here talks to the network, so a slow Telegram can never hold a lock
// or roll back a physical confirmation.

import { createHash } from "node:crypto";
import type pg from "pg";
import { claim, complete, confirm, plan, type Order, type Outcome, type Plan, type Rejection, type TaskKind } from "@stow/order-engine";
import type { OrderRequest } from "@stow/telegram/commands";

/** PickerCommand is what a worker's device may ask for in Gate A. */
export type PickerCommand =
  | { readonly type: "CLAIM_ORDER"; readonly orderId: string; readonly revision: number; readonly version: number; readonly toteId: string | null }
  | {
      readonly type: "CONFIRM_TASK";
      readonly orderId: string;
      readonly revision: number;
      readonly version: number;
      readonly kind: TaskKind;
      readonly lineId: string;
      readonly quantity: number;
    }
  | { readonly type: "COMPLETE_ORDER"; readonly orderId: string; readonly revision: number; readonly version: number };

export type CommandResult =
  | { readonly status: 200; readonly body: { readonly outcome: "APPLIED"; readonly seq: string; readonly orderId: string; readonly version: string } }
  | { readonly status: 404; readonly body: { readonly code: "NOT_FOUND" } }
  | { readonly status: 409; readonly body: { readonly code: Rejection | "IDEMPOTENCY_CONFLICT" } };

/** runPickerCommand executes one picker command exactly once per command ID. */
export async function runPickerCommand(
  pool: pg.Pool,
  actor: { readonly workspaceId: string; readonly workerId: string },
  commandId: string,
  command: PickerCommand,
): Promise<CommandResult> {
  const requestHash = hashCommand(command);
  return transaction(pool, async (client) => {
    await lockWorkspace(client, actor.workspaceId);
    const previous = await client.query<{ request_hash: string; http_status: number; response: CommandResult["body"] }>(
      "select request_hash, http_status, response from command_results where workspace_id = $1 and actor_member_id = $2 and command_id = $3",
      [actor.workspaceId, actor.workerId, commandId],
    );
    const stored = previous.rows[0];
    if (stored) {
      if (stored.request_hash !== requestHash) return { status: 409, body: { code: "IDEMPOTENCY_CONFLICT" } };
      return { status: stored.http_status, body: stored.response } as CommandResult;
    }

    const before = await loadOrder(client, actor.workspaceId, command.orderId);
    if (!before) return { status: 404, body: { code: "NOT_FOUND" } };
    const outcome = apply(before, actor.workerId, command);
    const result: CommandResult = outcome.ok
      ? await commit(client, actor, commandId, command, before, outcome.order)
      : { status: 409, body: { code: outcome.code } };
    // Rejections are stored too, so a retry of a refused command is refused the same way.
    await client.query(
      "insert into command_results (workspace_id, actor_member_id, command_id, request_hash, http_status, response) values ($1, $2, $3, $4, $5, $6)",
      [actor.workspaceId, actor.workerId, commandId, requestHash, result.status, result.body],
    );
    return result;
  });
}

async function commit(
  client: pg.ClientBase,
  actor: { readonly workspaceId: string; readonly workerId: string },
  commandId: string,
  command: PickerCommand,
  before: Order,
  after: Order,
): Promise<CommandResult> {
  await saveOrder(client, actor.workspaceId, before, after, actor.workerId);
  const seq = await appendEvent(client, actor.workspaceId, {
    orderId: after.id,
    type: eventType(command),
    actorId: actor.workerId,
    commandId,
    revision: after.revision,
    version: after.version,
    payload: eventPayload(command),
  });
  await queueStatusUpdate(client, actor.workspaceId, after.id, after.version);
  return { status: 200, body: { outcome: "APPLIED", seq: String(seq), orderId: after.id, version: String(after.version) } };
}

function apply(order: Order, workerId: string, command: PickerCommand): Outcome {
  const expected = { revision: command.revision, version: command.version };
  switch (command.type) {
    case "CLAIM_ORDER":
      return claim(order, workerId, command.toteId, expected);
    case "CONFIRM_TASK":
      return confirm(order, workerId, { ...expected, kind: command.kind, lineId: command.lineId, quantity: command.quantity });
    case "COMPLETE_ORDER":
      return complete(order, workerId, expected);
  }
}

function eventType(command: PickerCommand): string {
  if (command.type === "CLAIM_ORDER") return "ORDER_CLAIMED";
  if (command.type === "COMPLETE_ORDER") return "ORDER_COMPLETED";
  return command.kind === "PICK" ? "PICK_CONFIRMED" : "RETURN_CONFIRMED";
}

function eventPayload(command: PickerCommand): Record<string, unknown> {
  if (command.type === "CONFIRM_TASK") return { lineId: command.lineId, quantity: command.quantity };
  if (command.type === "CLAIM_ORDER") return { toteId: command.toteId };
  return {};
}

/** WorkerView is the order a worker should see now and what to do with it. */
export type WorkerView = { readonly order: Order | null; readonly plan: Plan | { readonly kind: "QUEUE_EMPTY" }; readonly cursor: string };

/**
 * workerView finds the worker's live order, or else the next queued one to
 * offer. It reads in one snapshot so the cursor matches the state returned.
 */
export async function workerView(pool: pg.Pool, workspaceId: string, workerId: string): Promise<WorkerView> {
  return transaction(pool, async (client) => {
    const cursor = await client.query<{ event_seq: string }>("select event_seq from workspaces where id = $1", [workspaceId]);
    const current = await client.query<{ order_id: string }>(
      `select a.order_id from assignments a join orders o on o.id = a.order_id
       where a.workspace_id = $1 and a.worker_id = $2 and a.released_at is null and o.terminal is null
       order by a.created_at limit 1`,
      [workspaceId, workerId],
    );
    const queued = current.rows[0]
      ? current
      : await client.query<{ order_id: string }>(
          `select o.id as order_id from orders o
           where o.workspace_id = $1 and o.terminal is null
             and not exists (select 1 from assignments a where a.order_id = o.id and a.released_at is null)
           order by o.priority desc, o.created_at, o.id limit 1`,
          [workspaceId],
        );
    const orderId = queued.rows[0]?.order_id;
    const order = orderId ? await loadOrder(client, workspaceId, orderId, "read") : null;
    return { order, plan: order ? plan(order, workerId) : { kind: "QUEUE_EMPTY" }, cursor: cursor.rows[0]?.event_seq ?? "0" };
  }, "repeatable read");
}

/** NewOrder is a parsed order request with where it came from. */
export type NewOrder = {
  readonly workspaceId: string;
  readonly createdBy: string;
  readonly sourceKey: string;
  readonly connectionId: string | null;
  readonly request: OrderRequest;
};

export type CreateResult =
  | { readonly ok: true; readonly orderId: string; readonly ref: string; readonly isNew: boolean }
  | { readonly ok: false; readonly unknownSkus: readonly string[] }
  | { readonly ok: false; readonly code: "REF_TAKEN" };

/**
 * createOrder queues an order whose SKUs all exist in the active catalogue.
 * The same source key always yields the same order, so a redelivered Telegram
 * update can never create a duplicate.
 */
export async function createOrder(pool: pg.Pool, input: NewOrder): Promise<CreateResult> {
  return transaction(pool, async (client) => {
    await lockWorkspace(client, input.workspaceId);
    const existing = await client.query<{ id: string; ref: string }>(
      "select id, ref from orders where workspace_id = $1 and source_key = $2",
      [input.workspaceId, input.sourceKey],
    );
    if (existing.rows[0]) {
      return { ok: true, orderId: existing.rows[0].id, ref: existing.rows[0].ref, isNew: false };
    }

    const skus = input.request.lines.map((line) => line.sku);
    const products = await client.query<{ id: string; normalized_sku: string; sku: string; name: string; bin: string | null; route_rank: number }>(
      "select id, normalized_sku, sku, name, bin, route_rank from products where workspace_id = $1 and is_active and normalized_sku = any($2)",
      [input.workspaceId, skus],
    );
    const bySku = new Map(products.rows.map((product) => [product.normalized_sku, product]));
    const unknownSkus = skus.filter((sku) => !bySku.has(sku));
    if (unknownSkus.length > 0) {
      return { ok: false, unknownSkus };
    }

    const ref = input.request.ref ?? (await nextRef(client, input.workspaceId));
    const taken = await client.query("select 1 from orders where workspace_id = $1 and ref = $2", [input.workspaceId, ref]);
    if (taken.rowCount) {
      return { ok: false, code: "REF_TAKEN" };
    }
    const order = await client.query<{ id: string }>(
      "insert into orders (workspace_id, ref, source_key, connection_id, created_by) values ($1, $2, $3, $4, $5) returning id",
      [input.workspaceId, ref, input.sourceKey, input.connectionId, input.createdBy],
    );
    const orderId = order.rows[0]!.id;
    for (const [index, line] of input.request.lines.entries()) {
      const product = bySku.get(line.sku)!;
      await client.query(
        `insert into order_lines (workspace_id, order_id, product_id, sku_snapshot, name_snapshot, bin_snapshot,
           route_rank_snapshot, creation_index, requested_qty) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [input.workspaceId, orderId, product.id, product.sku, product.name, product.bin, product.route_rank, index, line.quantity],
      );
    }
    await appendEvent(client, input.workspaceId, {
      orderId,
      type: "ORDER_CREATED",
      actorId: input.createdBy,
      commandId: null,
      revision: 1,
      version: 1,
      payload: { lines: input.request.lines.length },
    });
    await queueStatusUpdate(client, input.workspaceId, orderId, 1);
    return { ok: true, orderId, ref, isNew: true };
  });
}

async function nextRef(client: pg.ClientBase, workspaceId: string): Promise<string> {
  const { rows } = await client.query<{ order_seq: string }>(
    "update workspaces set order_seq = order_seq + 1 where id = $1 returning order_seq",
    [workspaceId],
  );
  return `ST-${rows[0]!.order_seq}`;
}

// Queues a refresh of the order's status message in its source chat, if the
// order came from one. The sender renders the latest state when it runs, so
// a queued row only says "something changed at this version".
async function queueStatusUpdate(client: pg.ClientBase, workspaceId: string, orderId: string, version: number): Promise<void> {
  await client.query(
    `insert into telegram_outbox (workspace_id, connection_id, order_id, kind, dedupe_key, payload)
     select o.workspace_id, c.id, o.id, 'STATUS', 'status:' || o.id || ':' || $3::text, jsonb_build_object('version', $3::bigint)
     from orders o join telegram_connections c on c.workspace_id = o.workspace_id and c.id = o.connection_id and c.status = 'ACTIVE'
     where o.workspace_id = $1 and o.id = $2
     on conflict (workspace_id, dedupe_key) do nothing`,
    [workspaceId, orderId, version],
  );
}

// Taking the workspace row lock first gives every transaction the same lock
// order (workspace, then order, then lines), so writers in a workspace queue
// up instead of deadlocking.
async function lockWorkspace(client: pg.ClientBase, workspaceId: string): Promise<void> {
  const { rowCount } = await client.query("select 1 from workspaces where id = $1 for update", [workspaceId]);
  if (!rowCount) throw new Error(`workspace ${workspaceId} does not exist`);
}

type NewEvent = {
  readonly orderId: string;
  readonly type: string;
  readonly actorId: string;
  readonly commandId: string | null;
  readonly revision: number;
  readonly version: number;
  readonly payload: Record<string, unknown>;
};

// Allocates the next workspace sequence number and records the event with it.
// Only called for committed changes, so the sequence has no gaps from rejections.
async function appendEvent(client: pg.ClientBase, workspaceId: string, event: NewEvent): Promise<bigint> {
  const { rows } = await client.query<{ event_seq: string }>(
    "update workspaces set event_seq = event_seq + 1 where id = $1 returning event_seq",
    [workspaceId],
  );
  const seq = rows[0]!.event_seq;
  await client.query(
    `insert into fulfilment_events (workspace_id, seq, order_id, event_type, actor_member_id, command_id, revision, version, payload)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [workspaceId, seq, event.orderId, event.type, event.actorId, event.commandId, event.revision, event.version, event.payload],
  );
  return BigInt(seq);
}

/** loadOrder reads an order in the engine's shape, locking it unless asked only to read. */
export async function loadOrder(client: pg.ClientBase, workspaceId: string, orderId: string, mode: "lock" | "read" = "lock"): Promise<Order | null> {
  const lock = mode === "lock" ? "for update" : "";
  const order = await client.query<{
    id: string; ref: string; revision: number; version: string; terminal: Order["terminal"];
    is_paused: boolean; is_cancel_requested: boolean; is_release_requested: boolean;
  }>(
    `select id, ref, revision, version, terminal, is_paused, is_cancel_requested, is_release_requested
     from orders where workspace_id = $1 and id = $2 ${lock}`,
    [workspaceId, orderId],
  );
  const row = order.rows[0];
  if (!row) return null;
  const lines = await client.query<{
    id: string; sku_snapshot: string; name_snapshot: string; bin_snapshot: string | null;
    route_rank_snapshot: number; creation_index: number; requested_qty: number; picked_qty: number;
  }>(
    `select id, sku_snapshot, name_snapshot, bin_snapshot, route_rank_snapshot, creation_index, requested_qty, picked_qty
     from order_lines where workspace_id = $1 and order_id = $2 order by creation_index ${lock}`,
    [workspaceId, orderId],
  );
  const assignment = await client.query<{ worker_id: string; tote_id: string | null; is_accepted: boolean; ack_revision: number }>(
    "select worker_id, tote_id, is_accepted, ack_revision from assignments where workspace_id = $1 and order_id = $2 and released_at is null",
    [workspaceId, orderId],
  );
  const live = assignment.rows[0];
  return {
    id: row.id,
    ref: row.ref,
    revision: row.revision,
    version: toSafeNumber(row.version),
    terminal: row.terminal,
    isPaused: row.is_paused,
    isCancelRequested: row.is_cancel_requested,
    isReleaseRequested: row.is_release_requested,
    exception: null,
    assignment: live ? { workerId: live.worker_id, toteId: live.tote_id, isAccepted: live.is_accepted, ackRevision: live.ack_revision } : null,
    lines: lines.rows.map((line) => ({
      id: line.id,
      sku: line.sku_snapshot,
      name: line.name_snapshot,
      bin: line.bin_snapshot,
      routeRank: line.route_rank_snapshot,
      creationIndex: line.creation_index,
      requested: line.requested_qty,
      picked: line.picked_qty,
    })),
  };
}

// Writes only what the engine changed. Gate A commands change version,
// terminal state, picked counts and the assignment.
async function saveOrder(client: pg.ClientBase, workspaceId: string, before: Order, after: Order, workerId: string): Promise<void> {
  await client.query("update orders set version = $3, terminal = $4, updated_at = now() where workspace_id = $1 and id = $2", [
    workspaceId,
    after.id,
    after.version,
    after.terminal,
  ]);
  for (const line of after.lines) {
    const old = before.lines.find((candidate) => candidate.id === line.id);
    if (old?.picked === line.picked) continue;
    await client.query("update order_lines set picked_qty = $3 where workspace_id = $1 and id = $2", [workspaceId, line.id, line.picked]);
  }
  if (!before.assignment && after.assignment) {
    await client.query(
      "insert into assignments (workspace_id, order_id, worker_id, tote_id, is_accepted, ack_revision) values ($1, $2, $3, $4, true, $5)",
      [workspaceId, after.id, workerId, after.assignment.toteId, after.assignment.ackRevision],
    );
  }
}

/** transaction runs fn in one transaction and always returns the connection. */
export async function transaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
  isolation: "read committed" | "repeatable read" = "read committed",
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`begin isolation level ${isolation}`);
    const value = await fn(client);
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

// The request hash covers the command's content, not its ID, with keys in a
// fixed order so the same command always hashes the same.
function hashCommand(command: PickerCommand): string {
  const canonical = JSON.stringify(command, Object.keys(command).sort());
  return createHash("sha256").update(canonical).digest("hex");
}

function toSafeNumber(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`version ${value} exceeds the safe integer range`);
  return number;
}
