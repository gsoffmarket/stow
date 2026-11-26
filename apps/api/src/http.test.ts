import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "./db/testdb.ts";
import { createOrder } from "./fulfilment.ts";
import { buildHttp, hashToken } from "./http.ts";

let db: TestDatabase;
let app: FastifyInstance;
beforeAll(async () => {
  db = await createTestDatabase();
  app = buildHttp({ pool: db.pool, taskTokenSecret: "x".repeat(32), botToken: null, now: () => new Date(), corsAllowedOrigins: ["http://glasses.test"], logger: false });
});
afterAll(async () => {
  await app.close();
  await db.drop();
});

async function workspaceWithDevice() {
  const q = async (sql: string, params: unknown[]) => (await db.pool.query<{ id: string }>(sql, params)).rows[0]!.id;
  const workspaceId = await q("insert into workspaces (name) values ('Stockroom') returning id", []);
  const coordinator = await q("insert into members (workspace_id, display_name, role) values ($1, 'C', 'COORDINATOR') returning id", [workspaceId]);
  const picker = await q("insert into members (workspace_id, display_name, role) values ($1, 'P', 'PICKER') returning id", [workspaceId]);
  await db.pool.query("insert into products (workspace_id, sku, normalized_sku, name, bin) values ($1, 'TS-BLK-M', 'TS-BLK-M', 'Black T-shirt', 'A-03')", [workspaceId]);
  const token = randomBytes(32).toString("base64url");
  await db.pool.query(
    "insert into device_tokens (workspace_id, member_id, label, token_hash, expires_at) values ($1, $2, 'G2', $3, now() + interval '1 hour')",
    [workspaceId, picker, hashToken(token)],
  );
  const created = await createOrder(db.pool, {
    workspaceId,
    createdBy: coordinator,
    sourceKey: `test:${randomUUID()}`,
    connectionId: null,
    sourceMessageId: null,
    request: { ref: null, lines: [{ sku: "TS-BLK-M", quantity: 3 }] },
  });
  if (!created.ok || !("orderId" in created)) throw new Error("order not created");
  const auth = { authorization: `Bearer ${token}` };
  return { workspaceId, orderId: created.orderId, auth };
}

const snapshot = (workspaceId: string, headers: Record<string, string>) =>
  app.inject({ method: "GET", url: `/v1/workspaces/${workspaceId}/worker/snapshot`, headers });
const command = (workspaceId: string, headers: Record<string, string>, payload: object) =>
  app.inject({ method: "POST", url: `/v1/workspaces/${workspaceId}/commands`, headers, payload });

describe("worker API", () => {
  test("offer, claim, then a partial pick with the issued task token", async () => {
    const { workspaceId, orderId, auth } = await workspaceWithDevice();
    const offer = await snapshot(workspaceId, auth);
    expect(offer.json()).toMatchObject({ data: { plan: { kind: "OFFER" }, order: { id: orderId, version: "1" } } });

    const claimed = await command(workspaceId, auth, {
      commandId: randomUUID(), type: "CLAIM_ORDER", orderId, expectedRevision: 1, expectedVersion: "1", payload: { toteId: "A" },
    });
    expect(claimed.json()).toMatchObject({ data: { outcome: "APPLIED", version: "2", delivery: "PENDING" } });

    const task = (await snapshot(workspaceId, auth)).json().data.plan;
    expect(task).toMatchObject({ kind: "TASK", task: { kind: "PICK", quantity: 3, bin: "A-03", toteId: "A" }, progress: { confirmed: 0, requested: 3 } });

    const confirmed = await command(workspaceId, auth, {
      commandId: randomUUID(), type: "CONFIRM_TASK", orderId, expectedRevision: 1, expectedVersion: "2",
      payload: { taskToken: task.taskToken, kind: "PICK", lineId: task.task.lineId, quantity: 2 },
    });
    expect(confirmed.statusCode).toBe(200);
    const after = (await snapshot(workspaceId, auth)).json().data.plan;
    expect(after).toMatchObject({ task: { quantity: 1 }, progress: { confirmed: 2 } });
  });

  test("a task token for a different line is refused as a changed task", async () => {
    const { workspaceId, orderId, auth } = await workspaceWithDevice();
    await command(workspaceId, auth, { commandId: randomUUID(), type: "CLAIM_ORDER", orderId, expectedRevision: 1, expectedVersion: "1", payload: { toteId: null } });
    const task = (await snapshot(workspaceId, auth)).json().data.plan;
    const forged = await command(workspaceId, auth, {
      commandId: randomUUID(), type: "CONFIRM_TASK", orderId, expectedRevision: 1, expectedVersion: "2",
      payload: { taskToken: task.taskToken, kind: "PICK", lineId: randomUUID(), quantity: 1 },
    });
    expect(forged.statusCode).toBe(409);
    expect(forged.json().error.code).toBe("TASK_CHANGED");
  });

  test("rejects missing tokens, other workspaces and unknown fields", async () => {
    const { workspaceId, auth } = await workspaceWithDevice();
    expect((await snapshot(workspaceId, {})).statusCode).toBe(401);
    expect((await snapshot(randomUUID(), auth)).statusCode).toBe(404);
    const extra = await command(workspaceId, auth, {
      commandId: randomUUID(), type: "COMPLETE_ORDER", orderId: randomUUID(), expectedRevision: 1, expectedVersion: "1", payload: {}, admin: true,
    });
    expect(extra.statusCode).toBe(400);
  });

  test("answers CORS preflight only for allowed origins", async () => {
    const allowed = await app.inject({ method: "OPTIONS", url: "/v1/workspaces/x/commands", headers: { origin: "http://glasses.test" } });
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://glasses.test");
    const other = await app.inject({ method: "OPTIONS", url: "/v1/workspaces/x/commands", headers: { origin: "http://evil.test" } });
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("batch API", () => {
  test("offers queued orders, starts a batch from the offer and shows the totes", async () => {
    const { workspaceId, auth } = await workspaceWithDevice();
    const coordinator = (await db.pool.query<{ id: string }>("select id from members where workspace_id = $1 and role = 'COORDINATOR'", [workspaceId])).rows[0]!.id;
    await createOrder(db.pool, {
      workspaceId, createdBy: coordinator, sourceKey: `test:${randomUUID()}`, connectionId: null, sourceMessageId: null,
      request: { ref: null, lines: [{ sku: "TS-BLK-M", quantity: 1 }] },
    });
    const offer = (await snapshot(workspaceId, auth)).json().data.batchOffer as { orderId: string; revision: number; version: string }[];
    expect(offer).toHaveLength(2);

    const orders = offer.map((order) => ({ orderId: order.orderId, expectedRevision: order.revision, expectedVersion: order.version }));
    const started = await app.inject({ method: "POST", url: `/v1/workspaces/${workspaceId}/batches`, headers: auth, payload: { commandId: randomUUID(), orders } });
    expect(started.json()).toMatchObject({ data: { outcome: "APPLIED", orderIds: offer.map((order) => order.orderId) } });

    const view = (await snapshot(workspaceId, auth)).json().data;
    expect(view.totes.map((tote: { toteId: string }) => tote.toteId)).toEqual(["A", "B"]);
    expect(view.batchOffer).toEqual([]);
    expect(view.plan).toMatchObject({ kind: "TASK", task: { toteId: "A" } });
  });

  test("answers a batch of one with a problem code", async () => {
    const { workspaceId, orderId, auth } = await workspaceWithDevice();
    const orders = [{ orderId, expectedRevision: 1, expectedVersion: "1" }];
    const refused = await app.inject({ method: "POST", url: `/v1/workspaces/${workspaceId}/batches`, headers: auth, payload: { commandId: randomUUID(), orders } });
    expect({ status: refused.statusCode, code: refused.json().error.code }).toEqual({ status: 400, code: "BATCH_SIZE" });
  });
});
