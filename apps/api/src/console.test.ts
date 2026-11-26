import { createHmac, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "./db/testdb.ts";
import { createOrder, runCommand, workerView, type Actor } from "./fulfilment.ts";
import { buildHttp } from "./http.ts";

const botToken = "123456:test-token-for-signing-launch-data";

function launchData(userId: number): string {
  const fields: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: "U" }) };
  const checkString = Object.keys(fields).sort().map((key) => `${key}=${fields[key]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  return new URLSearchParams({ ...fields, hash: createHmac("sha256", secret).update(checkString).digest("hex") }).toString();
}

let db: TestDatabase;
let app: FastifyInstance;
let workspaceId: string;
let coordinatorHeaders: Record<string, string>;
let pickerHeaders: Record<string, string>;

beforeAll(async () => {
  db = await createTestDatabase();
  app = buildHttp({ pool: db.pool, taskTokenSecret: "x".repeat(32), botToken, now: () => new Date(), corsAllowedOrigins: [], logger: false });
  workspaceId = (await db.pool.query<{ id: string }>("insert into workspaces (name) values ('Stockroom') returning id")).rows[0]!.id;
  await db.pool.query(
    "insert into members (workspace_id, display_name, role, telegram_user_id) values ($1, 'Coord', 'COORDINATOR', '100'), ($1, 'Picker 01', 'PICKER', '200')",
    [workspaceId],
  );
  await db.pool.query("insert into products (workspace_id, sku, normalized_sku, name, bin) values ($1, 'TS-BLK-M', 'TS-BLK-M', 'Black T-shirt', 'A-03'), ($1, 'CP-WHT', 'CP-WHT', 'White cap', 'B-11')", [workspaceId]);
  const signIn = async (id: number) => {
    const session = await app.inject({ method: "POST", url: "/v1/telegram/miniapp/session", payload: { initData: launchData(id) } });
    return { authorization: `Bearer ${session.json().data.token}` };
  };
  coordinatorHeaders = await signIn(100);
  pickerHeaders = await signIn(200);
});
afterAll(async () => {
  await app.close();
  await db.drop();
});

// An order claimed by a fresh picker with 3 shirts picked. Each order gets its
// own picker because a worker's view shows their oldest live order.
async function pickedOrder(): Promise<{ orderId: string; ref: string; picker: Actor }> {
  const pickerId = (await db.pool.query<{ id: string }>("insert into members (workspace_id, display_name, role) values ($1, 'Picker 02', 'PICKER') returning id", [workspaceId])).rows[0]!.id;
  const picker: Actor = { workspaceId, memberId: pickerId, role: "PICKER" };
  const created = await createOrder(db.pool, {
    workspaceId,
    createdBy: (await db.pool.query<{ id: string }>("select id from members where telegram_user_id = '100'")).rows[0]!.id,
    sourceKey: `test:${randomUUID()}`,
    connectionId: null,
    sourceMessageId: null,
    request: { ref: null, lines: [{ sku: "TS-BLK-M", quantity: 3 }, { sku: "CP-WHT", quantity: 2 }] },
  });
  if (!created.ok || !("orderId" in created)) throw new Error("not created");
  await runCommand(db.pool, picker, randomUUID(), { type: "CLAIM_ORDER", orderId: created.orderId, revision: 1, version: 1, toteId: "A" });
  const view = await workerView(db.pool, workspaceId, picker.memberId);
  const lineId = view.plan.kind === "TASK" ? view.plan.task.lineId : "";
  await runCommand(db.pool, picker, randomUUID(), { type: "CONFIRM_TASK", orderId: created.orderId, revision: 1, version: 2, kind: "PICK", lineId, quantity: 3 });
  return { orderId: created.orderId, ref: created.ref, picker };
}

const get = (url: string, headers = coordinatorHeaders) => app.inject({ method: "GET", url, headers });
const post = (url: string, payload: object, headers = coordinatorHeaders) => app.inject({ method: "POST", url, headers, payload });

describe("coordinator console", () => {
  test("lists active orders with picker, tote and progress", async () => {
    const { ref } = await pickedOrder();
    const list = (await get(`/v1/workspaces/${workspaceId}/orders?view=active`)).json().data;
    expect(list.orders.find((order: { ref: string }) => order.ref === ref)).toMatchObject({ hold: "NONE", picker: "Picker 02", toteId: "A", confirmed: 3, requested: 5, lines: 2 });
  });

  test("detail shows lines and a readable timeline; revising goes through the engine", async () => {
    const { orderId } = await pickedOrder();
    const detail = (await get(`/v1/workspaces/${workspaceId}/orders/${orderId}`)).json().data;
    expect(detail.lines.map((line: { sku: string; picked: number }) => [line.sku, line.picked])).toEqual([["TS-BLK-M", 3], ["CP-WHT", 0]]);
    expect(detail.timeline[0]).toMatchObject({ type: "PICK_CONFIRMED", actor: "Picker 02", detail: "TS-BLK-M × 3" });

    const shirts = detail.lines[0].id;
    const revise = {
      commandId: randomUUID(), type: "REVISE_ORDER", orderId, expectedRevision: 1, expectedVersion: detail.order.version,
      payload: { reason: "Customer changed size", changes: [{ kind: "SET_QUANTITY", lineId: shirts, quantity: 1 }, { kind: "ADD_LINE", sku: "cp-wht", quantity: 1 }] },
    };
    expect((await post(`/v1/workspaces/${workspaceId}/console/commands`, revise)).json().error.code).toBe("DUPLICATE_SKU");

    const valid = { ...revise, commandId: randomUUID(), payload: { ...revise.payload, changes: [revise.payload.changes[0]] } };
    expect((await post(`/v1/workspaces/${workspaceId}/console/commands`, valid)).json().data).toMatchObject({ outcome: "APPLIED" });
    const after = (await get(`/v1/workspaces/${workspaceId}/orders/${orderId}`)).json().data;
    expect(after.order).toMatchObject({ revision: 2, hold: "AWAITING_PICKER" });

    const stale = { ...valid, commandId: randomUUID() };
    expect((await post(`/v1/workspaces/${workspaceId}/console/commands`, stale)).statusCode).toBe(409);
  });

  test("a note from the console reaches the picker", async () => {
    const { orderId, picker } = await pickedOrder();
    expect((await post(`/v1/workspaces/${workspaceId}/orders/${orderId}/notes`, { body: "Use tote B" })).statusCode).toBe(200);
    expect((await workerView(db.pool, workspaceId, picker.memberId)).note).toMatchObject({ body: "Use tote B" });
    const detail = (await get(`/v1/workspaces/${workspaceId}/orders/${orderId}`)).json().data;
    expect(detail.messages).toEqual([{ direction: "TO_PICKER", body: "Use tote B", author: "Coord", at: expect.any(String), isRead: false }]);
  });

  test("pickers and strangers cannot use the console", async () => {
    expect((await get(`/v1/workspaces/${workspaceId}/orders`, pickerHeaders)).statusCode).toBe(404);
    expect((await get(`/v1/workspaces/${randomUUID()}/orders`)).statusCode).toBe(404);
    expect((await get(`/v1/workspaces/${workspaceId}/orders`, {})).statusCode).toBe(401);
  });
});
