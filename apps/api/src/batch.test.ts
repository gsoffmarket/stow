import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createOrder, runCommand, startBatch, workerView, type Command, type Shown } from "./fulfilment.ts";
import { createTestDatabase, type TestDatabase } from "./db/testdb.ts";

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

type Workspace = { workspaceId: string; coordinator: string; picker: string; otherPicker: string };

async function workspace(): Promise<Workspace> {
  const q = async (sql: string, params: unknown[]) => (await db.pool.query<{ id: string }>(sql, params)).rows[0]!.id;
  const workspaceId = await q("insert into workspaces (name) values ('Stockroom') returning id", []);
  const member = (role: string) => q("insert into members (workspace_id, display_name, role) values ($1, $2, $3) returning id", [workspaceId, role, role]);
  const coordinator = await member("COORDINATOR");
  const picker = await member("PICKER");
  const otherPicker = await member("PICKER");
  for (const [sku, bin, rank] of [["TS-BLK-M", "A-03", 1], ["CP-WHT", "B-11", 2]] as const) {
    await db.pool.query("insert into products (workspace_id, sku, normalized_sku, name, bin, route_rank) values ($1, $2, $2, $3, $4, $5)", [workspaceId, sku, sku, bin, rank]);
  }
  return { workspaceId, coordinator, picker, otherPicker };
}

async function queue(ws: Workspace, count: number): Promise<Shown[]> {
  const shown: Shown[] = [];
  for (let i = 0; i < count; i++) {
    const created = await createOrder(db.pool, {
      workspaceId: ws.workspaceId,
      createdBy: ws.coordinator,
      sourceKey: `test:${randomUUID()}`,
      connectionId: null,
      sourceMessageId: null,
      request: { ref: null, lines: [{ sku: "TS-BLK-M", quantity: 3 }, { sku: "CP-WHT", quantity: 2 }] },
    });
    if (!created.ok || !("orderId" in created)) throw new Error(`createOrder: ${JSON.stringify(created)}`);
    shown.push({ orderId: created.orderId, revision: 1, version: 1 });
  }
  return shown;
}

const actor = (ws: Workspace, memberId = ws.picker) => ({ workspaceId: ws.workspaceId, memberId, role: "PICKER" as const });
const start = (ws: Workspace, shown: Shown[], commandId: string = randomUUID()) => startBatch(db.pool, actor(ws), commandId, shown);
const run = (ws: Workspace, command: Command) => runCommand(db.pool, actor(ws), randomUUID(), command);

async function assigned(orderIds: string[]): Promise<{ order_id: string; tote_id: string }[]> {
  const { rows } = await db.pool.query<{ order_id: string; tote_id: string }>(
    "select order_id, tote_id from assignments where order_id = any($1) and released_at is null order by tote_id",
    [orderIds],
  );
  return rows;
}

describe("startBatch", () => {
  test("claims every order into its own tote, in the order offered", async () => {
    const ws = await workspace();
    const shown = await queue(ws, 3);
    const result = await start(ws, shown);
    expect(result).toMatchObject({ status: 200, body: { outcome: "APPLIED", orderIds: shown.map((order) => order.orderId) } });
    expect(await assigned(shown.map((order) => order.orderId))).toEqual(shown.map((order, i) => ({ order_id: order.orderId, tote_id: "ABC"[i] })));
    const events = await db.pool.query("select count(*)::int as n from fulfilment_events where event_type = 'ORDER_CLAIMED' and order_id = any($1)", [shown.map((order) => order.orderId)]);
    expect(events.rows[0]).toEqual({ n: 3 });
  });

  test("claims nothing when another picker took one of the orders first", async () => {
    const ws = await workspace();
    const shown = await queue(ws, 2);
    await runCommand(db.pool, actor(ws, ws.otherPicker), randomUUID(), { type: "CLAIM_ORDER", ...shown[1]!, toteId: "A" });
    // The claim moved the order on, so the offer the picker saw is out of date.
    expect(await start(ws, shown)).toEqual({ status: 409, body: { code: "STALE_VERSION" } });
    expect(await assigned([shown[0]!.orderId])).toEqual([]);
  });

  test("claims nothing when the screen showed an old version of an order", async () => {
    const ws = await workspace();
    const shown = await queue(ws, 2);
    const result = await start(ws, [shown[0]!, { ...shown[1]!, version: 0 }]);
    expect(result).toEqual({ status: 409, body: { code: "STALE_VERSION" } });
    expect(await assigned(shown.map((order) => order.orderId))).toEqual([]);
  });

  test("refuses a batch while the picker still carries an order", async () => {
    const ws = await workspace();
    const shown = await queue(ws, 3);
    await run(ws, { type: "CLAIM_ORDER", ...shown[0]!, toteId: "A" });
    expect(await start(ws, shown.slice(1))).toEqual({ status: 409, body: { code: "ASSIGNMENT_CONFLICT" } });
  });

  test.each([
    { name: "one order", pick: (shown: Shown[]) => shown.slice(0, 1) },
    { name: "six orders", pick: (shown: Shown[]) => shown },
    { name: "the same order twice", pick: (shown: Shown[]) => [shown[0]!, shown[0]!] },
  ])("refuses $name", async ({ pick }) => {
    const ws = await workspace();
    const shown = await queue(ws, 6);
    expect(await start(ws, pick(shown))).toEqual({ status: 400, body: { code: "BATCH_SIZE" } });
  });

  test("replays a repeated command ID and refuses one reused for other orders", async () => {
    const ws = await workspace();
    const shown = await queue(ws, 4);
    const commandId = randomUUID();
    const first = await start(ws, shown.slice(0, 2), commandId);
    expect(await start(ws, shown.slice(0, 2), commandId)).toEqual(first);
    expect(await start(ws, shown.slice(2), commandId)).toEqual({ status: 409, body: { code: "IDEMPOTENCY_CONFLICT" } });
  });
});

describe("workerView with a batch", () => {
  test("offers a batch only when at least two orders are queued", async () => {
    const ws = await workspace();
    await queue(ws, 1);
    expect((await workerView(db.pool, ws.workspaceId, ws.picker)).batchOffer).toEqual([]);
    await queue(ws, 1);
    const view = await workerView(db.pool, ws.workspaceId, ws.picker);
    expect(view.batchOffer.map((order) => order.ref)).toEqual(["ST-1001", "ST-1002"]);
    expect(view.plan.kind).toBe("OFFER");
  });

  test("walks the route across totes, then reviews each order", async () => {
    const ws = await workspace();
    const shown = await queue(ws, 2);
    await start(ws, shown);
    const steps: string[] = [];
    for (let i = 0; i < 6; i++) {
      const view = await workerView(db.pool, ws.workspaceId, ws.picker);
      const order = view.order!;
      if (view.plan.kind === "REVIEW_COMPLETE") {
        steps.push(`${order.assignment!.toteId} complete`);
        await run(ws, { type: "COMPLETE_ORDER", orderId: order.id, revision: order.revision, version: order.version });
        continue;
      }
      if (view.plan.kind !== "TASK") throw new Error(`workerView: plan ${view.plan.kind}, want TASK`);
      const task = view.plan.task;
      steps.push(`${order.assignment!.toteId} ${order.lines.find((line) => line.id === task.lineId)!.sku}`);
      await run(ws, { type: "CONFIRM_TASK", orderId: order.id, revision: task.revision, version: task.version, kind: task.kind, lineId: task.lineId, quantity: task.quantity });
    }
    expect(steps).toEqual(["A TS-BLK-M", "B TS-BLK-M", "A CP-WHT", "A complete", "B CP-WHT", "B complete"]);
  });

  test("lists every tote with its progress", async () => {
    const ws = await workspace();
    const shown = await queue(ws, 2);
    await start(ws, shown);
    const view = await workerView(db.pool, ws.workspaceId, ws.picker);
    expect(view.totes.map(({ ref, toteId, picked, requested }) => ({ ref, toteId, picked, requested }))).toEqual([
      { ref: "ST-1001", toteId: "A", picked: 0, requested: 5 },
      { ref: "ST-1002", toteId: "B", picked: 0, requested: 5 },
    ]);
  });

  test("keeps picking the other totes while one order waits on a problem", async () => {
    const ws = await workspace();
    const shown = await queue(ws, 2);
    await start(ws, shown);
    const reported = await run(ws, { type: "REPORT_EXCEPTION", ...shown[0]!, version: 2, exceptionType: "SHORTAGE", reportedQty: 0 });
    expect(reported.status).toBe(200);
    const view = await workerView(db.pool, ws.workspaceId, ws.picker);
    expect({ orderId: view.order?.id, plan: view.plan.kind }).toEqual({ orderId: shown[1]!.orderId, plan: "TASK" });
  });
});
