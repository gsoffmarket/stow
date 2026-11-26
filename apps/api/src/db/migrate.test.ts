import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { migrate } from "./migrate.ts";
import { createTestDatabase, type TestDatabase } from "./testdb.ts";

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

async function workspaceWithMember(name: string): Promise<{ workspaceId: string; memberId: string }> {
  const ws = await db.pool.query<{ id: string }>("insert into workspaces (name) values ($1) returning id", [name]);
  const workspaceId = ws.rows[0]!.id;
  const member = await db.pool.query<{ id: string }>(
    "insert into members (workspace_id, display_name, role) values ($1, 'Owner', 'OWNER') returning id",
    [workspaceId],
  );
  return { workspaceId, memberId: member.rows[0]!.id };
}

describe("migrate", () => {
  test("a second run applies nothing", async () => {
    const client = await db.pool.connect();
    try {
      expect(await migrate(client)).toEqual([]);
    } finally {
      client.release();
    }
  });

  test("rejects a negative picked quantity", async () => {
    const { workspaceId, memberId } = await workspaceWithMember("Negative");
    const product = await db.pool.query<{ id: string }>(
      "insert into products (workspace_id, sku, normalized_sku, name) values ($1, 'A', 'A', 'Item') returning id",
      [workspaceId],
    );
    const order = await db.pool.query<{ id: string }>(
      "insert into orders (workspace_id, ref, created_by) values ($1, 'ST-1', $2) returning id",
      [workspaceId, memberId],
    );
    const insertLine = db.pool.query(
      `insert into order_lines (workspace_id, order_id, product_id, sku_snapshot, name_snapshot, route_rank_snapshot,
         creation_index, requested_qty, picked_qty) values ($1, $2, $3, 'A', 'Item', 0, 0, 1, -1)`,
      [workspaceId, order.rows[0]!.id, product.rows[0]!.id],
    );
    await expect(insertLine).rejects.toThrow(/order_lines_picked_qty_check/);
  });

  test("refuses an order created by a member of another workspace", async () => {
    const first = await workspaceWithMember("First");
    const second = await workspaceWithMember("Second");
    const crossTenant = db.pool.query("insert into orders (workspace_id, ref, created_by) values ($1, 'ST-1', $2)", [
      first.workspaceId,
      second.memberId,
    ]);
    await expect(crossTenant).rejects.toThrow(/foreign key/);
  });

  test("allows only one live assignment per order", async () => {
    const { workspaceId, memberId } = await workspaceWithMember("Assign");
    const order = await db.pool.query<{ id: string }>(
      "insert into orders (workspace_id, ref, created_by) values ($1, 'ST-1', $2) returning id",
      [workspaceId, memberId],
    );
    const assign = () =>
      db.pool.query("insert into assignments (workspace_id, order_id, worker_id, ack_revision) values ($1, $2, $3, 1)", [
        workspaceId,
        order.rows[0]!.id,
        memberId,
      ]);
    await assign();
    await expect(assign()).rejects.toThrow(/assignments_one_active/);
  });
});
