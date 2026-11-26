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

import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import {
  acknowledge,
  acknowledgeResolution,
  batchLimits,
  cancelRelease,
  claim,
  closeCancelled,
  complete,
  confirm,
  pause,
  plan,
  planBatch,
  prepareRelease,
  release,
  report,
  requestCancel,
  resolve,
  resume,
  revise,
  type Change,
  type ExceptionType,
  type Line,
  type Order,
  type Outcome,
  type Plan,
  type Rejection,
  type TaskKind,
} from "@stow/order-engine";
import type { OrderRequest } from "@stow/telegram/commands";
import { unreadNote, type Note } from "./messages.ts";

/** Role is a member's role in a workspace. */
export type Role = "OWNER" | "COORDINATOR" | "PICKER" | "VIEWER";

/** Actor is who is issuing a command. */
export type Actor = { readonly workspaceId: string; readonly memberId: string; readonly role: Role };

type Expected = { readonly orderId: string; readonly revision: number; readonly version: number };

/** Coordinator edits name SKUs; the server resolves them against the catalogue. */
export type RevisionChange =
  | { readonly kind: "SET_QUANTITY"; readonly lineId: string; readonly quantity: number }
  | { readonly kind: "ADD_LINE"; readonly sku: string; readonly quantity: number };

export type ResolutionRequest =
  | { readonly kind: "RESUME" }
  | { readonly kind: "REDUCE"; readonly quantity: number }
  | { readonly kind: "SUBSTITUTE"; readonly quantity: number; readonly sku: string; readonly substituteQuantity: number }
  | { readonly kind: "CANCEL" };

/** Command is everything a picker or coordinator can do to an existing order. */
export type Command = Expected &
  (
    | { readonly type: "CLAIM_ORDER"; readonly toteId: string | null }
    | { readonly type: "CONFIRM_TASK"; readonly kind: TaskKind; readonly lineId: string; readonly quantity: number }
    | { readonly type: "COMPLETE_ORDER" | "ACK_REVISION" | "PAUSE_ORDER" | "RESUME_ORDER" | "CLOSE_CANCELLED" | "PREPARE_RELEASE" | "CANCEL_RELEASE" | "RELEASE_ORDER" }
    | { readonly type: "REPORT_EXCEPTION"; readonly exceptionType: ExceptionType; readonly reportedQty: number | null }
    | { readonly type: "ACK_RESOLUTION"; readonly exceptionId: string }
    | { readonly type: "REVISE_ORDER"; readonly reason: string; readonly changes: readonly RevisionChange[] }
    | { readonly type: "REQUEST_CANCEL"; readonly reason: string }
    | { readonly type: "RESOLVE_EXCEPTION"; readonly reason: string; readonly resolution: ResolutionRequest }
  );

const coordinatorCommands = new Set<Command["type"]>(["REVISE_ORDER", "REQUEST_CANCEL", "RESOLVE_EXCEPTION"]);

export type CommandResult =
  | { readonly status: 200; readonly body: { readonly outcome: "APPLIED"; readonly seq: string; readonly orderId: string; readonly version: string } }
  | { readonly status: 200; readonly body: { readonly outcome: "NO_CHANGE"; readonly seq: null; readonly orderId: string; readonly version: string } }
  | { readonly status: 400; readonly body: { readonly code: "UNKNOWN_SKU"; readonly skus: readonly string[] } }
  | { readonly status: 403; readonly body: { readonly code: "ROLE_REQUIRED" } }
  | { readonly status: 404; readonly body: { readonly code: "NOT_FOUND" } }
  | { readonly status: 409; readonly body: { readonly code: Exclude<Rejection, "NO_CHANGE"> | "IDEMPOTENCY_CONFLICT" } };

/**
 * runCommand executes one command exactly once per command ID: the actor's
 * role decides which commands are allowed, the engine decides whether the
 * order's state allows it.
 */
export async function runCommand(pool: pg.Pool, actor: Actor, commandId: string, command: Command): Promise<CommandResult> {
  const isCoordinatorCommand = coordinatorCommands.has(command.type);
  const allowed = actor.role === "OWNER" || actor.role === (isCoordinatorCommand ? "COORDINATOR" : "PICKER");
  if (!allowed) return { status: 403, body: { code: "ROLE_REQUIRED" } };

  return transaction(pool, async (client) =>
    once(client, actor, commandId, hashCommand(command), async () => {
      const before = await loadOrder(client, actor.workspaceId, command.orderId);
      return before ? execute(client, actor, commandId, command, before) : { status: 404, body: { code: "NOT_FOUND" } };
    }),
  );
}

// Runs a command's work at most once per command ID, inside the caller's
// transaction: the workspace lock serialises writers, a stored result is
// replayed, and a reused ID with different content is refused. Rejections
// are stored too, so a retry of a refused command is refused the same way.
async function once<R extends { readonly status: number; readonly body: unknown }>(
  client: pg.ClientBase,
  actor: Actor,
  commandId: string,
  requestHash: string,
  run: () => Promise<R>,
): Promise<R | { status: 409; body: { code: "IDEMPOTENCY_CONFLICT" } }> {
  await lockWorkspace(client, actor.workspaceId);
  const previous = await client.query<{ request_hash: string; http_status: number; response: R["body"] }>(
    "select request_hash, http_status, response from command_results where workspace_id = $1 and actor_member_id = $2 and command_id = $3",
    [actor.workspaceId, actor.memberId, commandId],
  );
  const stored = previous.rows[0];
  if (stored) {
    if (stored.request_hash !== requestHash) return { status: 409, body: { code: "IDEMPOTENCY_CONFLICT" } };
    return { status: stored.http_status, body: stored.response } as R;
  }
  const result = await run();
  await client.query(
    "insert into command_results (workspace_id, actor_member_id, command_id, request_hash, http_status, response) values ($1, $2, $3, $4, $5, $6)",
    [actor.workspaceId, actor.memberId, commandId, requestHash, result.status, result.body],
  );
  return result;
}

async function execute(client: pg.ClientBase, actor: Actor, commandId: string, command: Command, before: Order): Promise<CommandResult> {
  const products = await resolveSkus(client, actor.workspaceId, skusIn(command));
  const unknown = skusIn(command).filter((sku) => !products.has(sku));
  if (unknown.length > 0) return { status: 400, body: { code: "UNKNOWN_SKU", skus: unknown } };

  const outcome = apply(before, actor.memberId, command, products);
  if (!outcome.ok) {
    const code = outcome.code;
    if (code === "NO_CHANGE") return { status: 200, body: { outcome: "NO_CHANGE", seq: null, orderId: before.id, version: String(before.version) } };
    return { status: 409, body: { code } };
  }

  const after = outcome.order;
  await saveOrder(client, actor, before, after, command, products);
  const seq = await appendEvent(client, actor.workspaceId, {
    orderId: after.id,
    type: eventType(command),
    actorId: actor.memberId,
    commandId,
    revision: after.revision,
    version: after.version,
    payload: eventPayload(command, after),
  });
  await queueStatusUpdate(client, actor.workspaceId, after.id, after.version);
  if ((command.type === "REPORT_EXCEPTION" || command.type === "RESOLVE_EXCEPTION") && after.exception) {
    await queueExceptionUpdate(client, actor.workspaceId, after.id, after.exception.id, after.exception.status);
  }
  return { status: 200, body: { outcome: "APPLIED", seq: String(seq), orderId: after.id, version: String(after.version) } };
}

/** Shown is an order exactly as the worker's screen showed it. */
export type Shown = Expected;

export type BatchResult =
  | { readonly status: 200; readonly body: { readonly outcome: "APPLIED"; readonly seq: string; readonly orderIds: readonly string[] } }
  | { readonly status: 400; readonly body: { readonly code: "BATCH_SIZE" } }
  | { readonly status: 403; readonly body: { readonly code: "ROLE_REQUIRED" } }
  | { readonly status: 404; readonly body: { readonly code: "NOT_FOUND" } }
  | { readonly status: 409; readonly body: { readonly code: Exclude<Rejection, "NO_CHANGE"> | "IDEMPOTENCY_CONFLICT" } };

const totes = ["A", "B", "C", "D", "E"] as const;

/**
 * startBatch claims two to five queued orders for one picker, all or none,
 * each into its own tote in the order offered. Every claim is checked before
 * any is written, so a batch never starts with an order someone else took.
 */
export async function startBatch(pool: pg.Pool, actor: Actor, commandId: string, shown: readonly Shown[]): Promise<BatchResult> {
  if (actor.role !== "OWNER" && actor.role !== "PICKER") return { status: 403, body: { code: "ROLE_REQUIRED" } };
  const isDistinct = new Set(shown.map((order) => order.orderId)).size === shown.length;
  if (shown.length < batchLimits.min || shown.length > batchLimits.max || !isDistinct) return { status: 400, body: { code: "BATCH_SIZE" } };
  return transaction(pool, (client) =>
    once(client, actor, commandId, hashCommand({ type: "START_BATCH", shown }), async (): Promise<BatchResult> => {
      // Assignments outlive their order, so only an open order counts as carried.
      const busy = await client.query(
        `select 1 from assignments a join orders o on o.id = a.order_id
         where a.workspace_id = $1 and a.worker_id = $2 and a.released_at is null and o.terminal is null limit 1`,
        [actor.workspaceId, actor.memberId],
      );
      if (busy.rowCount) return { status: 409, body: { code: "ASSIGNMENT_CONFLICT" } };
      const claims = [];
      for (const [index, order] of shown.entries()) {
        const before = await loadOrder(client, actor.workspaceId, order.orderId);
        if (!before) return { status: 404, body: { code: "NOT_FOUND" } };
        const command = { type: "CLAIM_ORDER", ...order, toteId: totes[index]! } as const;
        const outcome = claim(before, actor.memberId, command.toteId, order);
        if (!outcome.ok) return { status: 409, body: { code: outcome.code === "NO_CHANGE" ? "ASSIGNMENT_CONFLICT" : outcome.code } };
        claims.push({ before, after: outcome.order, command });
      }
      let seq = "";
      for (const { before, after, command } of claims) {
        await saveOrder(client, actor, before, after, command, new Map());
        const payload = { ...eventPayload(command, after), batchSize: claims.length };
        const event = { orderId: after.id, type: eventType(command), actorId: actor.memberId, commandId, revision: after.revision, version: after.version, payload };
        seq = String(await appendEvent(client, actor.workspaceId, event));
        await queueStatusUpdate(client, actor.workspaceId, after.id, after.version);
      }
      return { status: 200, body: { outcome: "APPLIED", seq, orderIds: claims.map(({ after }) => after.id) } };
    }),
  );
}

type Product = { id: string; sku: string; name: string; bin: string | null; route_rank: number };

function skusIn(command: Command): string[] {
  if (command.type === "REVISE_ORDER") return command.changes.flatMap((change) => (change.kind === "ADD_LINE" ? [change.sku] : []));
  if (command.type === "RESOLVE_EXCEPTION" && command.resolution.kind === "SUBSTITUTE") return [command.resolution.sku];
  return [];
}

async function resolveSkus(client: pg.ClientBase, workspaceId: string, skus: string[]): Promise<Map<string, Product>> {
  if (skus.length === 0) return new Map();
  const { rows } = await client.query<Product & { normalized_sku: string }>(
    "select id, normalized_sku, sku, name, bin, route_rank from products where workspace_id = $1 and is_active and normalized_sku = any($2)",
    [workspaceId, skus],
  );
  return new Map(rows.map((row) => [row.normalized_sku, row]));
}

// A new line gets its ID here, so the engine stays free of randomness.
function newLine(product: Product): Omit<Line, "requested" | "picked" | "creationIndex"> {
  return { id: randomUUID(), sku: product.sku, name: product.name, bin: product.bin, routeRank: product.route_rank };
}

function apply(order: Order, memberId: string, command: Command, products: Map<string, Product>): Outcome {
  const expected = { revision: command.revision, version: command.version };
  switch (command.type) {
    case "CLAIM_ORDER":
      return claim(order, memberId, command.toteId, expected);
    case "CONFIRM_TASK":
      return confirm(order, memberId, { ...expected, kind: command.kind, lineId: command.lineId, quantity: command.quantity });
    case "COMPLETE_ORDER":
      return complete(order, memberId, expected);
    case "ACK_REVISION":
      return acknowledge(order, memberId, expected);
    case "PAUSE_ORDER":
      return pause(order, memberId, expected);
    case "RESUME_ORDER":
      return resume(order, memberId, expected);
    case "CLOSE_CANCELLED":
      return closeCancelled(order, memberId, expected);
    case "PREPARE_RELEASE":
      return prepareRelease(order, memberId, expected);
    case "CANCEL_RELEASE":
      return cancelRelease(order, memberId, expected);
    case "RELEASE_ORDER":
      return release(order, memberId, expected);
    case "REPORT_EXCEPTION":
      return report(order, memberId, { exceptionId: randomUUID(), type: command.exceptionType, reportedQty: command.reportedQty }, expected);
    case "ACK_RESOLUTION":
      return acknowledgeResolution(order, memberId, command.exceptionId, expected);
    case "REVISE_ORDER": {
      const changes: Change[] = command.changes.map((change) =>
        change.kind === "SET_QUANTITY" ? change : { kind: "ADD_LINE", line: newLine(products.get(change.sku)!), quantity: change.quantity },
      );
      return revise(order, changes, expected);
    }
    case "REQUEST_CANCEL":
      return requestCancel(order, expected);
    case "RESOLVE_EXCEPTION": {
      const r = command.resolution;
      if (r.kind !== "SUBSTITUTE") return resolve(order, r, expected);
      return resolve(order, { kind: "SUBSTITUTE", quantity: r.quantity, substitute: newLine(products.get(r.sku)!), substituteQuantity: r.substituteQuantity }, expected);
    }
  }
}

const eventTypes: Record<Exclude<Command["type"], "CONFIRM_TASK">, string> = {
  CLAIM_ORDER: "ORDER_CLAIMED",
  COMPLETE_ORDER: "ORDER_COMPLETED",
  ACK_REVISION: "REVISION_ACKNOWLEDGED",
  PAUSE_ORDER: "ORDER_PAUSED",
  RESUME_ORDER: "ORDER_RESUMED",
  CLOSE_CANCELLED: "ORDER_CANCELLED",
  PREPARE_RELEASE: "RELEASE_REQUESTED",
  CANCEL_RELEASE: "RELEASE_CANCELLED",
  RELEASE_ORDER: "ORDER_RELEASED",
  REPORT_EXCEPTION: "EXCEPTION_REPORTED",
  ACK_RESOLUTION: "RESOLUTION_ACKNOWLEDGED",
  REVISE_ORDER: "ORDER_REVISED",
  REQUEST_CANCEL: "ORDER_CANCEL_REQUESTED",
  RESOLVE_EXCEPTION: "EXCEPTION_RESOLVED",
};

function eventType(command: Command): string {
  if (command.type === "CONFIRM_TASK") return command.kind === "PICK" ? "PICK_CONFIRMED" : "RETURN_CONFIRMED";
  return eventTypes[command.type];
}

function eventPayload(command: Command, after: Order): Record<string, unknown> {
  switch (command.type) {
    case "CONFIRM_TASK":
      return { lineId: command.lineId, quantity: command.quantity };
    case "CLAIM_ORDER":
      return { toteId: command.toteId };
    case "REPORT_EXCEPTION":
      return { exceptionId: after.exception?.id, type: command.exceptionType, reportedQty: command.reportedQty };
    case "RESOLVE_EXCEPTION":
      return { resolution: command.resolution.kind };
    default:
      return {};
  }
}

/** TargetChange is one line's target before and after the revisions a worker has not yet seen. */
export type TargetChange = { readonly sku: string; readonly from: number; readonly to: number; readonly picked: number };

/** Decision is what a coordinator decided about the worker's report. */
export type Decision = { readonly resolution: string; readonly sku: string; readonly target: number };

/** Completed is the worker's most recently closed order and whether the group has heard. */
export type Completed = {
  readonly ref: string;
  readonly terminal: "COMPLETED" | "CANCELLED";
  readonly units: number;
  readonly delivery: "SENT" | "PENDING" | "UNCERTAIN" | "FAILED" | "NOT_REQUIRED";
};

/** Tote is one order a worker is carrying in a batch, with its progress. */
export type Tote = { readonly orderId: string; readonly ref: string; readonly toteId: string | null; readonly picked: number; readonly requested: number };

/** Queued is an order waiting for a picker, as a batch offer shows it. */
export type Queued = { readonly orderId: string; readonly ref: string; readonly revision: number; readonly version: string };

/** WorkerView is the order a worker should see now, what to do with it, and why it changed. */
export type WorkerView = {
  readonly order: Order | null;
  /** Every order the worker carries, when there is more than one. */
  readonly totes: readonly Tote[];
  /** Queued orders a worker with nothing in hand may start together, when there are at least two. */
  readonly batchOffer: readonly Queued[];
  readonly plan: Plan | { readonly kind: "QUEUE_EMPTY" };
  readonly cursor: string;
  readonly changes: readonly TargetChange[];
  readonly decision: Decision | null;
  readonly lastCompleted: Completed | null;
  /** The oldest unread coordinator note on the worker's current order. */
  readonly note: Note | null;
};

/**
 * workerView finds what the worker should do next across every order they
 * carry, or else the next queued order to offer, with what the worker needs
 * to understand a change. It reads in one snapshot so the cursor matches the
 * state returned.
 */
export async function workerView(pool: pg.Pool, workspaceId: string, workerId: string): Promise<WorkerView> {
  return transaction(pool, async (client) => {
    const cursor = await client.query<{ event_seq: string }>("select event_seq from workspaces where id = $1", [workspaceId]);
    const live = await client.query<{ order_id: string }>(
      `select a.order_id from assignments a join orders o on o.id = a.order_id
       where a.workspace_id = $1 and a.worker_id = $2 and a.released_at is null and o.terminal is null
       order by a.tote_id, a.created_at limit $3`,
      [workspaceId, workerId, batchLimits.max],
    );
    const carried: Order[] = [];
    for (const { order_id } of live.rows) carried.push((await loadOrder(client, workspaceId, order_id, "read"))!);
    const queued =
      carried.length > 0
        ? []
        : (
            await client.query<{ id: string; ref: string; revision: number; version: string }>(
              `select o.id, o.ref, o.revision, o.version from orders o
               where o.workspace_id = $1 and o.terminal is null
                 and not exists (select 1 from assignments a where a.order_id = o.id and a.released_at is null)
               order by o.priority desc, o.created_at, o.id limit $2`,
              [workspaceId, batchLimits.max],
            )
          ).rows;
    const offered = queued[0] ? await loadOrder(client, workspaceId, queued[0].id, "read") : null;
    const step = carried.length > 0 ? planBatch(carried, workerId) : null;
    const order = step ? carried.find((candidate) => candidate.id === step.orderId)! : offered;
    const next = step ? step.plan : offered ? plan(offered, workerId) : ({ kind: "QUEUE_EMPTY" } as const);
    return {
      order,
      plan: next,
      cursor: cursor.rows[0]?.event_seq ?? "0",
      totes: carried.length > 1 ? carried.map(tote) : [],
      batchOffer: queued.length >= batchLimits.min ? queued.map((row) => ({ orderId: row.id, ref: row.ref, revision: row.revision, version: row.version })) : [],
      changes: order && order.assignment && (next.kind === "REVISION_ACK" || next.kind === "RESOLUTION_ACK") ? await changesSince(client, order, order.assignment.ackRevision) : [],
      decision: order && next.kind === "RESOLUTION_ACK" ? await decisionOn(client, workspaceId, next.exceptionId) : null,
      lastCompleted: carried.length > 0 ? null : await lastCompleted(client, workspaceId, workerId),
      note: step ? await unreadNote(client, step.orderId) : null,
    };
  }, "repeatable read");
}

function tote(order: Order): Tote {
  const picked = order.lines.reduce((sum, line) => sum + Math.min(line.picked, line.requested), 0);
  const requested = order.lines.reduce((sum, line) => sum + line.requested, 0);
  return { orderId: order.id, ref: order.ref, toteId: order.assignment?.toteId ?? null, picked, requested };
}

// Collapses every revision after the one the worker acknowledged into a
// single before/after per line, so several edits read as one change.
async function changesSince(client: pg.ClientBase, order: Order, acknowledged: number): Promise<TargetChange[]> {
  const { rows } = await client.query<{ prior_targets: Record<string, number> }>(
    "select prior_targets from order_revisions where order_id = $1 and revision > $2 order by revision limit 1",
    [order.id, acknowledged],
  );
  const before = rows[0]?.prior_targets ?? {};
  return order.lines
    .map((line) => ({ sku: line.sku, from: before[line.sku] ?? 0, to: line.requested, picked: line.picked }))
    .filter((change) => change.from !== change.to);
}

async function decisionOn(client: pg.ClientBase, workspaceId: string, exceptionId: string): Promise<Decision | null> {
  const { rows } = await client.query<{ resolution: string; sku: string; target: number }>(
    `select e.resolution, l.sku_snapshot as sku, l.requested_qty as target
     from order_exceptions e join order_lines l on l.id = e.line_id
     where e.workspace_id = $1 and e.id = $2`,
    [workspaceId, exceptionId],
  );
  return rows[0] ?? null;
}

// The order this worker most recently closed, if within the last 15 minutes,
// with the state of its final status message in the group.
async function lastCompleted(client: pg.ClientBase, workspaceId: string, workerId: string): Promise<Completed | null> {
  const { rows } = await client.query<{ id: string; ref: string; terminal: "COMPLETED" | "CANCELLED"; units: number; connection_id: string | null; version: string }>(
    `select o.id, o.ref, o.terminal, o.connection_id, o.version,
            (select coalesce(sum(least(picked_qty, requested_qty)), 0)::int from order_lines l where l.order_id = o.id) as units
     from assignments a join orders o on o.id = a.order_id
     where a.workspace_id = $1 and a.worker_id = $2 and o.terminal is not null and o.updated_at > now() - interval '15 minutes'
     order by o.updated_at desc limit 1`,
    [workspaceId, workerId],
  );
  const order = rows[0];
  if (!order) return null;
  if (!order.connection_id) return { ref: order.ref, terminal: order.terminal, units: order.units, delivery: "NOT_REQUIRED" };
  const outbox = await client.query<{ status: string }>(
    "select status from telegram_outbox where order_id = $1 and kind = 'STATUS' and dedupe_key = 'status:' || $1 || ':' || $2",
    [order.id, order.version],
  );
  const status = outbox.rows[0]?.status;
  const delivery = status === "SENT" ? "SENT" : status === "UNCERTAIN" ? "UNCERTAIN" : status === "FAILED" ? "FAILED" : "PENDING";
  return { ref: order.ref, terminal: order.terminal, units: order.units, delivery };
}

/** NewOrder is a parsed order request with where it came from. */
export type NewOrder = {
  readonly workspaceId: string;
  readonly createdBy: string;
  readonly sourceKey: string;
  readonly connectionId: string | null;
  readonly sourceMessageId: string | null;
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
      `insert into orders (workspace_id, ref, source_key, connection_id, source_message_id, created_by)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [input.workspaceId, ref, input.sourceKey, input.connectionId, input.sourceMessageId, input.createdBy],
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

// Queues the coordinator-facing message for a reported or resolved exception.
async function queueExceptionUpdate(client: pg.ClientBase, workspaceId: string, orderId: string, exceptionId: string, status: string): Promise<void> {
  await client.query(
    `insert into telegram_outbox (workspace_id, connection_id, order_id, kind, dedupe_key, payload)
     select o.workspace_id, c.id, o.id, 'EXCEPTION', 'exception:' || $3 || ':' || $4, jsonb_build_object('exceptionId', $3::text)
     from orders o join telegram_connections c on c.workspace_id = o.workspace_id and c.id = o.connection_id and c.status = 'ACTIVE'
     where o.workspace_id = $1 and o.id = $2
     on conflict (workspace_id, dedupe_key) do nothing`,
    [workspaceId, orderId, exceptionId, status],
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
  const open = await client.query<{ id: string; status: "OPEN" | "RESOLVED_AWAITING_ACK"; type: ExceptionType; line_id: string | null; reported_qty: number | null }>(
    "select id, status, type, line_id, reported_qty from order_exceptions where workspace_id = $1 and order_id = $2 and status <> 'CLOSED'",
    [workspaceId, orderId],
  );
  const exception = open.rows[0];
  return {
    id: row.id,
    ref: row.ref,
    revision: row.revision,
    version: toSafeNumber(row.version),
    terminal: row.terminal,
    isPaused: row.is_paused,
    isCancelRequested: row.is_cancel_requested,
    isReleaseRequested: row.is_release_requested,
    exception: exception
      ? { id: exception.id, status: exception.status, type: exception.type, lineId: exception.line_id, reportedQty: exception.reported_qty }
      : null,
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

// Writes exactly what the engine changed: order flags, line targets and
// counts, new lines, the assignment, the exception, and a revision record
// whenever the revision number moved.
async function saveOrder(client: pg.ClientBase, actor: Actor, before: Order, after: Order, command: Command, products: Map<string, Product>): Promise<void> {
  const ws = actor.workspaceId;
  await client.query(
    `update orders set revision = $3, version = $4, terminal = $5, is_paused = $6, is_cancel_requested = $7, is_release_requested = $8, updated_at = now()
     where workspace_id = $1 and id = $2`,
    [ws, after.id, after.revision, after.version, after.terminal, after.isPaused, after.isCancelRequested, after.isReleaseRequested],
  );
  for (const line of after.lines) {
    const old = before.lines.find((candidate) => candidate.id === line.id);
    if (!old) {
      const product = [...products.values()].find((candidate) => candidate.sku === line.sku)!;
      await client.query(
        `insert into order_lines (workspace_id, id, order_id, product_id, sku_snapshot, name_snapshot, bin_snapshot,
           route_rank_snapshot, creation_index, requested_qty, picked_qty) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [ws, line.id, after.id, product.id, line.sku, line.name, line.bin, line.routeRank, line.creationIndex, line.requested, line.picked],
      );
    } else if (old.requested !== line.requested || old.picked !== line.picked) {
      await client.query("update order_lines set requested_qty = $3, picked_qty = $4 where workspace_id = $1 and id = $2", [ws, line.id, line.requested, line.picked]);
    }
  }
  if (!before.assignment && after.assignment) {
    await client.query(
      "insert into assignments (workspace_id, order_id, worker_id, tote_id, is_accepted, ack_revision) values ($1, $2, $3, $4, true, $5)",
      [ws, after.id, after.assignment.workerId, after.assignment.toteId, after.assignment.ackRevision],
    );
  } else if (before.assignment && !after.assignment) {
    await client.query("update assignments set released_at = now() where workspace_id = $1 and order_id = $2 and released_at is null", [ws, after.id]);
  } else if (before.assignment && after.assignment && before.assignment.ackRevision !== after.assignment.ackRevision) {
    await client.query("update assignments set ack_revision = $3 where workspace_id = $1 and order_id = $2 and released_at is null", [ws, after.id, after.assignment.ackRevision]);
  }
  await saveException(client, actor, before, after, command);
  if (after.revision !== before.revision) {
    const targets = (order: Order) => Object.fromEntries(order.lines.map((line) => [line.sku, line.requested]));
    const reason = "reason" in command ? command.reason : command.type;
    await client.query(
      `insert into order_revisions (workspace_id, order_id, revision, reason, actor_member_id, prior_targets, new_targets)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [ws, after.id, after.revision, reason, actor.memberId, targets(before), targets(after)],
    );
  }
}

async function saveException(client: pg.ClientBase, actor: Actor, before: Order, after: Order, command: Command): Promise<void> {
  const ws = actor.workspaceId;
  const was = before.exception;
  const now = after.exception;
  if (!was && now) {
    await client.query(
      `insert into order_exceptions (workspace_id, id, order_id, line_id, type, reported_qty, status, reporter_id, reported_revision)
       values ($1, $2, $3, $4, $5, $6, 'OPEN', $7, $8)`,
      [ws, now.id, after.id, now.lineId, now.type, now.reportedQty, actor.memberId, after.revision],
    );
  } else if (was && now && was.status !== now.status && command.type === "RESOLVE_EXCEPTION") {
    await client.query(
      `update order_exceptions set status = $3, resolution = $4, resolution_reason = $5, resolver_id = $6, resolved_at = now()
       where workspace_id = $1 and id = $2`,
      [ws, now.id, now.status, command.resolution.kind, command.reason, actor.memberId],
    );
  } else if (was && !now) {
    await client.query("update order_exceptions set status = 'CLOSED', acknowledged_at = now() where workspace_id = $1 and id = $2", [ws, was.id]);
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

// The request hash covers the command's content, not its ID. Keys are sorted
// at every depth so the same command always hashes the same.
function hashCommand(command: unknown): string {
  return createHash("sha256").update(canonicalJson(command)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function toSafeNumber(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`version ${value} exceeds the safe integer range`);
  return number;
}
