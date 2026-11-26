import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createOrder, runPickerCommand, workerView, type PickerCommand } from "./fulfilment.ts";
import { createTestDatabase, type TestDatabase } from "./db/testdb.ts";

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

type Workspace = { workspaceId: string; coordinator: string; picker: string; otherPicker: string; connectionId: string };

async function workspace(): Promise<Workspace> {
  const q = async (sql: string, params: unknown[]) => (await db.pool.query<{ id: string }>(sql, params)).rows[0]!.id;
  const workspaceId = await q("insert into workspaces (name) values ('Stockroom') returning id", []);
  const member = (role: string) =>
    q("insert into members (workspace_id, display_name, role) values ($1, $2, $3) returning id", [workspaceId, role, role]);
  const coordinator = await member("COORDINATOR");
  const picker = await member("PICKER");
  const otherPicker = await member("PICKER");
  for (const [sku, bin, rank] of [["TS-BLK-M", "A-03", 1], ["CP-WHT", "B-11", 2]] as const) {
    await db.pool.query(
      "insert into products (workspace_id, sku, normalized_sku, name, bin, route_rank) values ($1, $2, $2, $3, $4, $5)",
      [workspaceId, sku, `${sku} name`, bin, rank],
    );
  }
  const connectionId = await q(
    "insert into telegram_connections (workspace_id, chat_id, status, bound_by) values ($1, $2, 'ACTIVE', $3) returning id",
    [workspaceId, `-100${Math.floor(Math.random() * 1e9)}`, coordinator],
  );
  return { workspaceId, coordinator, picker, otherPicker, connectionId };
}

async function newOrder(ws: Workspace, sourceKey = `telegram:${randomUUID()}`) {
  const created = await createOrder(db.pool, {
    workspaceId: ws.workspaceId,
    createdBy: ws.coordinator,
    sourceKey,
    connectionId: ws.connectionId,
    sourceMessageId: null,
    request: { ref: null, lines: [{ sku: "TS-BLK-M", quantity: 3 }, { sku: "CP-WHT", quantity: 2 }] },
  });
  if (!created.ok || !("orderId" in created)) throw new Error(`createOrder: ${JSON.stringify(created)}`);
  return created;
}

const run = (ws: Workspace, worker: string, command: PickerCommand, commandId: string = randomUUID()) =>
  runPickerCommand(db.pool, { workspaceId: ws.workspaceId, workerId: worker }, commandId, command);

async function picked(orderId: string): Promise<number[]> {
  const { rows } = await db.pool.query<{ picked_qty: number }>(
    "select picked_qty from order_lines where order_id = $1 order by creation_index",
    [orderId],
  );
  return rows.map((row) => row.picked_qty);
}

describe("createOrder", () => {
  test("queues the order with catalogue snapshots, an event and a status message", async () => {
    const ws = await workspace();
    const created = await newOrder(ws);
    expect(created).toMatchObject({ ref: "ST-1001", isNew: true });

    const events = await db.pool.query("select seq, event_type from fulfilment_events where order_id = $1", [created.orderId]);
    expect(events.rows).toEqual([{ seq: "1", event_type: "ORDER_CREATED" }]);
    const outbox = await db.pool.query("select kind, status from telegram_outbox where order_id = $1", [created.orderId]);
    expect(outbox.rows).toEqual([{ kind: "STATUS", status: "PENDING" }]);
  });

  test("returns the same order when the same Telegram message is processed twice", async () => {
    const ws = await workspace();
    const first = await newOrder(ws, "telegram:bot:-1:42");
    const second = await newOrder(ws, "telegram:bot:-1:42");
    expect(second).toEqual({ ...first, isNew: false });
  });

  test("refuses SKUs that are not in the active catalogue", async () => {
    const ws = await workspace();
    const got = await createOrder(db.pool, {
      workspaceId: ws.workspaceId,
      createdBy: ws.coordinator,
      sourceKey: "telegram:unknown",
      connectionId: ws.connectionId,
    sourceMessageId: null,
      request: { ref: null, lines: [{ sku: "TS-BLK-M", quantity: 1 }, { sku: "NOPE", quantity: 1 }] },
    });
    expect(got).toEqual({ ok: false, unknownSkus: ["NOPE"] });
  });
});

describe("runPickerCommand", () => {
  test("claim then confirm records the pick, the events and a status update per change", async () => {
    const ws = await workspace();
    const { orderId } = await newOrder(ws);
    const claimed = await run(ws, ws.picker, { type: "CLAIM_ORDER", orderId, revision: 1, version: 1, toteId: "A" });
    expect(claimed).toMatchObject({ status: 200, body: { version: "2" } });

    const view = await workerView(db.pool, ws.workspaceId, ws.picker);
    expect(view.plan).toMatchObject({ kind: "TASK", task: { kind: "PICK", quantity: 3, version: 2 } });
    const lineId = view.plan.kind === "TASK" ? view.plan.task.lineId : "";

    const confirmed = await run(ws, ws.picker, { type: "CONFIRM_TASK", orderId, revision: 1, version: 2, kind: "PICK", lineId, quantity: 3 });
    expect(confirmed).toMatchObject({ status: 200, body: { outcome: "APPLIED", version: "3" } });
    expect(await picked(orderId)).toEqual([3, 0]);
    const outbox = await db.pool.query("select count(*)::int as n from telegram_outbox where order_id = $1", [orderId]);
    expect(outbox.rows[0]).toEqual({ n: 3 });
  });

  test("a replayed command returns the first result and changes nothing", async () => {
    const ws = await workspace();
    const { orderId } = await newOrder(ws);
    await run(ws, ws.picker, { type: "CLAIM_ORDER", orderId, revision: 1, version: 1, toteId: "A" });
    const view = await workerView(db.pool, ws.workspaceId, ws.picker);
    const lineId = view.plan.kind === "TASK" ? view.plan.task.lineId : "";
    const confirmTwo: PickerCommand = { type: "CONFIRM_TASK", orderId, revision: 1, version: 2, kind: "PICK", lineId, quantity: 2 };
    const commandId = randomUUID();

    const first = await run(ws, ws.picker, confirmTwo, commandId);
    const replay = await run(ws, ws.picker, confirmTwo, commandId);
    expect(replay).toEqual(first);
    expect(await picked(orderId)).toEqual([2, 0]);

    const changed = await run(ws, ws.picker, { ...confirmTwo, quantity: 1 }, commandId);
    expect(changed).toEqual({ status: 409, body: { code: "IDEMPOTENCY_CONFLICT" } });
  });

  test("a stale version is refused without touching the order", async () => {
    const ws = await workspace();
    const { orderId } = await newOrder(ws);
    await run(ws, ws.picker, { type: "CLAIM_ORDER", orderId, revision: 1, version: 1, toteId: "A" });
    const view = await workerView(db.pool, ws.workspaceId, ws.picker);
    const lineId = view.plan.kind === "TASK" ? view.plan.task.lineId : "";

    const stale = await run(ws, ws.picker, { type: "CONFIRM_TASK", orderId, revision: 1, version: 1, kind: "PICK", lineId, quantity: 1 });
    expect(stale).toEqual({ status: 409, body: { code: "STALE_VERSION" } });
    expect(await picked(orderId)).toEqual([0, 0]);
  });

  test("two workers claiming at once: exactly one gets the order", async () => {
    const ws = await workspace();
    const { orderId } = await newOrder(ws);
    const claimBy = (worker: string) => run(ws, worker, { type: "CLAIM_ORDER", orderId, revision: 1, version: 1, toteId: null });
    const results = await Promise.all([claimBy(ws.picker), claimBy(ws.otherPicker)]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const live = await db.pool.query("select count(*)::int as n from assignments where order_id = $1 and released_at is null", [orderId]);
    expect(live.rows[0]).toEqual({ n: 1 });
  });

  test("an unknown order is not found", async () => {
    const ws = await workspace();
    const got = await run(ws, ws.picker, { type: "COMPLETE_ORDER", orderId: randomUUID(), revision: 1, version: 1 });
    expect(got).toEqual({ status: 404, body: { code: "NOT_FOUND" } });
  });
});

describe("workerView", () => {
  test("offers the oldest queued order, then shows the worker's own task", async () => {
    const ws = await workspace();
    expect((await workerView(db.pool, ws.workspaceId, ws.picker)).plan).toEqual({ kind: "QUEUE_EMPTY" });
    const { orderId } = await newOrder(ws);
    expect(await workerView(db.pool, ws.workspaceId, ws.picker)).toMatchObject({ order: { id: orderId }, plan: { kind: "OFFER" } });
  });
});
