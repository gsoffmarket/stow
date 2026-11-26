// Gate B flows through real Postgres: revisions, exceptions, cancellation.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "./db/testdb.ts";
import { createOrder, runCommand, workerView, type Actor, type Command } from "./fulfilment.ts";

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

type Setup = { orderId: string; picker: Actor; coordinator: Actor; workspaceId: string };

// An order of 3 shirts and 2 caps, claimed by the picker, with 3 shirts picked.
async function pickedOrder(): Promise<Setup> {
  const q = async (sql: string, params: unknown[]) => (await db.pool.query<{ id: string }>(sql, params)).rows[0]!.id;
  const workspaceId = await q("insert into workspaces (name) values ('Stockroom') returning id", []);
  const member = (role: string) => q("insert into members (workspace_id, display_name, role) values ($1, $2, $2) returning id", [workspaceId, role]);
  const coordinator: Actor = { workspaceId, memberId: await member("COORDINATOR"), role: "COORDINATOR" };
  const picker: Actor = { workspaceId, memberId: await member("PICKER"), role: "PICKER" };
  for (const [sku, rank] of [["TS-BLK-M", 1], ["CP-WHT", 2], ["CP-GRY", 3]] as const) {
    await db.pool.query("insert into products (workspace_id, sku, normalized_sku, name, bin, route_rank) values ($1, $2, $2, $2, 'A-01', $3)", [workspaceId, sku, rank]);
  }
  const created = await createOrder(db.pool, {
    workspaceId,
    createdBy: coordinator.memberId,
    sourceKey: `test:${randomUUID()}`,
    connectionId: null,
    sourceMessageId: null,
    request: { ref: null, lines: [{ sku: "TS-BLK-M", quantity: 3 }, { sku: "CP-WHT", quantity: 2 }] },
  });
  if (!created.ok || !("orderId" in created)) throw new Error("order not created");
  const setup = { orderId: created.orderId, picker, coordinator, workspaceId };
  await run(setup.picker, { type: "CLAIM_ORDER", orderId: setup.orderId, ...(await at(setup)), toteId: "A" });
  await run(setup.picker, { type: "CONFIRM_TASK", orderId: setup.orderId, ...(await at(setup)), kind: "PICK", lineId: await lineId(setup, "TS-BLK-M"), quantity: 3 });
  return setup;
}

async function at(setup: Setup): Promise<{ revision: number; version: number }> {
  const { rows } = await db.pool.query<{ revision: number; version: string }>("select revision, version from orders where id = $1", [setup.orderId]);
  return { revision: rows[0]!.revision, version: Number(rows[0]!.version) };
}

async function lineId(setup: Setup, sku: string): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>("select id from order_lines where order_id = $1 and sku_snapshot = $2", [setup.orderId, sku]);
  return rows[0]!.id;
}

async function run(actor: Actor, command: Command, commandId: string = randomUUID()) {
  const result = await runCommand(db.pool, actor, commandId, command);
  return result;
}

async function nextPlan(setup: Setup) {
  return (await workerView(db.pool, setup.workspaceId, setup.picker.memberId)).plan;
}

describe("revisions", () => {
  test("reducing below what is picked records the revision and makes the picker return the excess", async () => {
    const s = await pickedOrder();
    const shirts = await lineId(s, "TS-BLK-M");
    const revised = await run(s.coordinator, { type: "REVISE_ORDER", orderId: s.orderId, ...(await at(s)), reason: "customer changed size", changes: [{ kind: "SET_QUANTITY", lineId: shirts, quantity: 1 }] });
    expect(revised).toMatchObject({ status: 200, body: { outcome: "APPLIED" } });

    const history = await db.pool.query("select revision, reason, prior_targets, new_targets from order_revisions where order_id = $1", [s.orderId]);
    expect(history.rows).toEqual([{ revision: 2, reason: "customer changed size", prior_targets: { "TS-BLK-M": 3, "CP-WHT": 2 }, new_targets: { "TS-BLK-M": 1, "CP-WHT": 2 } }]);
    expect(await nextPlan(s)).toMatchObject({ kind: "REVISION_ACK", fromRevision: 1, toRevision: 2 });

    await run(s.picker, { type: "ACK_REVISION", orderId: s.orderId, ...(await at(s)) });
    expect(await nextPlan(s)).toMatchObject({ kind: "TASK", task: { kind: "RETURN", lineId: shirts, quantity: 2 } });
    await run(s.picker, { type: "CONFIRM_TASK", orderId: s.orderId, ...(await at(s)), kind: "RETURN", lineId: shirts, quantity: 2 });
    const line = await db.pool.query("select requested_qty, picked_qty from order_lines where id = $1", [shirts]);
    expect(line.rows[0]).toEqual({ requested_qty: 1, picked_qty: 1 });
  });

  test("adding a SKU that is not in the catalogue is refused", async () => {
    const s = await pickedOrder();
    const got = await run(s.coordinator, { type: "REVISE_ORDER", orderId: s.orderId, ...(await at(s)), reason: "add", changes: [{ kind: "ADD_LINE", sku: "NOPE", quantity: 1 }] });
    expect(got).toEqual({ status: 400, body: { code: "UNKNOWN_SKU", skus: ["NOPE"] } });
  });

  test("an identical revision changes nothing", async () => {
    const s = await pickedOrder();
    const before = await at(s);
    const got = await run(s.coordinator, { type: "REVISE_ORDER", orderId: s.orderId, ...before, reason: "same", changes: [{ kind: "SET_QUANTITY", lineId: await lineId(s, "CP-WHT"), quantity: 2 }] });
    expect(got).toMatchObject({ status: 200, body: { outcome: "NO_CHANGE" } });
    expect(await at(s)).toEqual(before);
  });

  test("pickers cannot revise and coordinators cannot confirm picks", async () => {
    const s = await pickedOrder();
    const revise: Command = { type: "REVISE_ORDER", orderId: s.orderId, ...(await at(s)), reason: "x", changes: [] };
    expect(await run(s.picker, revise)).toEqual({ status: 403, body: { code: "ROLE_REQUIRED" } });
    const pick: Command = { type: "CONFIRM_TASK", orderId: s.orderId, ...(await at(s)), kind: "PICK", lineId: await lineId(s, "CP-WHT"), quantity: 1 };
    expect(await run(s.coordinator, pick)).toEqual({ status: 403, body: { code: "ROLE_REQUIRED" } });
  });
});

describe("shortage", () => {
  async function reported(): Promise<Setup> {
    const s = await pickedOrder();
    const got = await run(s.picker, { type: "REPORT_EXCEPTION", orderId: s.orderId, ...(await at(s)), exceptionType: "SHORTAGE", reportedQty: 1 });
    expect(got).toMatchObject({ status: 200 });
    return s;
  }

  test("report, reduce, acknowledge and complete", async () => {
    const s = await reported();
    const exception = await db.pool.query<{ id: string; status: string; type: string; reported_qty: number }>("select id, status, type, reported_qty from order_exceptions where order_id = $1", [s.orderId]);
    expect(exception.rows[0]).toMatchObject({ status: "OPEN", type: "SHORTAGE", reported_qty: 1 });
    expect(await nextPlan(s)).toMatchObject({ kind: "BLOCKED" });

    await run(s.coordinator, { type: "RESOLVE_EXCEPTION", orderId: s.orderId, ...(await at(s)), reason: "only one in stock", resolution: { kind: "REDUCE", quantity: 1 } });
    expect(await nextPlan(s)).toEqual({ kind: "RESOLUTION_ACK", exceptionId: exception.rows[0]!.id });

    await run(s.picker, { type: "ACK_RESOLUTION", orderId: s.orderId, ...(await at(s)), exceptionId: exception.rows[0]!.id });
    await run(s.picker, { type: "CONFIRM_TASK", orderId: s.orderId, ...(await at(s)), kind: "PICK", lineId: await lineId(s, "CP-WHT"), quantity: 1 });
    expect(await run(s.picker, { type: "COMPLETE_ORDER", orderId: s.orderId, ...(await at(s)) })).toMatchObject({ status: 200 });

    const closed = await db.pool.query("select status, resolution, resolution_reason from order_exceptions where order_id = $1", [s.orderId]);
    expect(closed.rows).toEqual([{ status: "CLOSED", resolution: "REDUCE", resolution_reason: "only one in stock" }]);
    const order = await db.pool.query("select terminal, revision from orders where id = $1", [s.orderId]);
    expect(order.rows[0]).toEqual({ terminal: "COMPLETED", revision: 2 });
  });

  test("a substitute becomes a new catalogue-backed line", async () => {
    const s = await reported();
    await run(s.coordinator, {
      type: "RESOLVE_EXCEPTION", orderId: s.orderId, ...(await at(s)), reason: "grey instead",
      resolution: { kind: "SUBSTITUTE", quantity: 0, sku: "CP-GRY", substituteQuantity: 2 },
    });
    const lines = await db.pool.query("select sku_snapshot, requested_qty, picked_qty, creation_index from order_lines where order_id = $1 order by creation_index", [s.orderId]);
    expect(lines.rows).toEqual([
      { sku_snapshot: "TS-BLK-M", requested_qty: 3, picked_qty: 3, creation_index: 0 },
      { sku_snapshot: "CP-WHT", requested_qty: 0, picked_qty: 0, creation_index: 1 },
      { sku_snapshot: "CP-GRY", requested_qty: 2, picked_qty: 0, creation_index: 2 },
    ]);
  });

  test("a second report while one is open is refused", async () => {
    const s = await reported();
    const again = await run(s.picker, { type: "REPORT_EXCEPTION", orderId: s.orderId, ...(await at(s)), exceptionType: "DAMAGED", reportedQty: null });
    expect(again).toEqual({ status: 409, body: { code: "OPEN_EXCEPTION" } });
  });
});

describe("cancellation", () => {
  test("cancel after picking: acknowledge, return everything, close", async () => {
    const s = await pickedOrder();
    await run(s.coordinator, { type: "REQUEST_CANCEL", orderId: s.orderId, ...(await at(s)), reason: "customer cancelled" });
    await run(s.picker, { type: "ACK_REVISION", orderId: s.orderId, ...(await at(s)) });
    expect(await nextPlan(s)).toMatchObject({ task: { kind: "RETURN", quantity: 3 } });
    await run(s.picker, { type: "CONFIRM_TASK", orderId: s.orderId, ...(await at(s)), kind: "RETURN", lineId: await lineId(s, "TS-BLK-M"), quantity: 3 });
    expect(await run(s.picker, { type: "CLOSE_CANCELLED", orderId: s.orderId, ...(await at(s)) })).toMatchObject({ status: 200 });
    const order = await db.pool.query("select terminal, is_cancel_requested from orders where id = $1", [s.orderId]);
    expect(order.rows[0]).toEqual({ terminal: "CANCELLED", is_cancel_requested: true });
  });
});

describe("idempotency on nested commands", () => {
  test("the same nested payload replays; a different nested value conflicts", async () => {
    const s = await pickedOrder();
    const shirts = await lineId(s, "TS-BLK-M");
    const commandId = randomUUID();
    const base = { type: "REVISE_ORDER" as const, orderId: s.orderId, ...(await at(s)), reason: "r" };
    const first = await run(s.coordinator, { ...base, changes: [{ kind: "SET_QUANTITY", lineId: shirts, quantity: 2 }] }, commandId);
    const reordered = await run(s.coordinator, { ...base, changes: [{ quantity: 2, lineId: shirts, kind: "SET_QUANTITY" }] }, commandId);
    expect(reordered).toEqual(first);
    const different = await run(s.coordinator, { ...base, changes: [{ kind: "SET_QUANTITY", lineId: shirts, quantity: 1 }] }, commandId);
    expect(different).toEqual({ status: 409, body: { code: "IDEMPOTENCY_CONFLICT" } });
  });
});

describe("what the worker view explains", () => {
  test("several revisions collapse into one before/after per changed line", async () => {
    const s = await pickedOrder();
    const shirts = await lineId(s, "TS-BLK-M");
    const caps = await lineId(s, "CP-WHT");
    await run(s.coordinator, { type: "REVISE_ORDER", orderId: s.orderId, ...(await at(s)), reason: "a", changes: [{ kind: "SET_QUANTITY", lineId: shirts, quantity: 2 }] });
    await run(s.coordinator, { type: "REVISE_ORDER", orderId: s.orderId, ...(await at(s)), reason: "b", changes: [{ kind: "SET_QUANTITY", lineId: shirts, quantity: 1 }, { kind: "SET_QUANTITY", lineId: caps, quantity: 4 }] });
    const view = await workerView(db.pool, s.workspaceId, s.picker.memberId);
    expect(view.plan).toMatchObject({ kind: "REVISION_ACK", fromRevision: 1, toRevision: 3 });
    expect(view.changes).toEqual([
      { sku: "TS-BLK-M", from: 3, to: 1, picked: 3 },
      { sku: "CP-WHT", from: 2, to: 4, picked: 0 },
    ]);
  });

  test("a resolution to acknowledge says what was decided", async () => {
    const s = await pickedOrder();
    await run(s.picker, { type: "REPORT_EXCEPTION", orderId: s.orderId, ...(await at(s)), exceptionType: "SHORTAGE", reportedQty: 1 });
    await run(s.coordinator, { type: "RESOLVE_EXCEPTION", orderId: s.orderId, ...(await at(s)), reason: "r", resolution: { kind: "REDUCE", quantity: 1 } });
    const view = await workerView(db.pool, s.workspaceId, s.picker.memberId);
    expect(view.decision).toEqual({ resolution: "REDUCE", sku: "CP-WHT", target: 1 });
    expect(view.changes).toEqual([{ sku: "CP-WHT", from: 2, to: 1, picked: 0 }]);
  });

  test("after completing, the last order is reported with its delivery state", async () => {
    const s = await pickedOrder();
    await run(s.picker, { type: "CONFIRM_TASK", orderId: s.orderId, ...(await at(s)), kind: "PICK", lineId: await lineId(s, "CP-WHT"), quantity: 2 });
    await run(s.picker, { type: "COMPLETE_ORDER", orderId: s.orderId, ...(await at(s)) });
    const view = await workerView(db.pool, s.workspaceId, s.picker.memberId);
    expect(view.lastCompleted).toMatchObject({ terminal: "COMPLETED", units: 5, delivery: "NOT_REQUIRED" });
  });
});
