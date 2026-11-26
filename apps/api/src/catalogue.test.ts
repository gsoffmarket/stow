import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { catalogueCsv, commit, parseCatalogue, preview } from "./catalogue.ts";
import { createTestDatabase, type TestDatabase } from "./db/testdb.ts";
import { createOrder } from "./fulfilment.ts";

describe("parseCatalogue", () => {
  test("reads quoted fields with commas, quotes and line breaks, and skips blank lines", () => {
    const csv = '﻿sku,name,bin,route_rank\nts-blk-m,"Black T-shirt, size ""M""",A-03,1\n\nCP-WHT,"White\ncap",,\n';
    expect(parseCatalogue(csv)).toEqual({
      errors: [],
      rows: [
        { line: 2, sku: "TS-BLK-M", name: 'Black T-shirt, size "M"', bin: "A-03", routeRank: 1 },
        { line: 4, sku: "CP-WHT", name: "White\ncap", bin: null, routeRank: 0 },
      ],
    });
  });

  test("reports every row error with its line and writes nothing", () => {
    const csv = "sku,name,route_rank\nA,Apple,1\nA,Again,2\n,Missing,3\nB,,x\n";
    expect(parseCatalogue(csv)).toEqual({
      rows: [],
      errors: [
        { line: 3, field: "sku", problem: "repeats line 2" },
        { line: 4, field: "sku", problem: "use 1–64 letters, digits, dot, dash or underscore" },
        { line: 5, field: "name", problem: "needs 1–120 characters" },
        { line: 5, field: "route_rank", problem: "must be a whole number" },
      ],
    });
  });

  test("needs sku and name and refuses unknown columns", () => {
    expect(parseCatalogue("name,colour\nApple,red\n").errors).toEqual([
      { line: 1, field: "header", problem: "needs sku and name columns" },
      { line: 1, field: "colour", problem: "unknown column" },
    ]);
  });
});

describe("import", () => {
  let db: TestDatabase;
  let workspaceId: string;
  beforeAll(async () => {
    db = await createTestDatabase();
    workspaceId = (await db.pool.query<{ id: string }>("insert into workspaces (name) values ('Stockroom') returning id")).rows[0]!.id;
  });
  afterAll(async () => {
    await db.drop();
  });

  test("new products are added; changes to existing ones need explicit permission", async () => {
    expect(await commit(db.pool, workspaceId, "sku,name,bin\nA,Apple,A-01\nB,Banana,B-01\n", false)).toEqual({ ok: true, added: 2, updated: 0, unchanged: 0 });

    const next = "sku,name,bin\nA,Apple,A-01\nB,Banana (ripe),B-02\nC,Cherry,C-01\n";
    expect((await preview(db.pool, workspaceId, next)).rows.map((row) => [row.sku, row.fate])).toEqual([["A", "UNCHANGED"], ["B", "UPDATE"], ["C", "NEW"]]);
    expect(await commit(db.pool, workspaceId, next, false)).toEqual({ ok: false, code: "UPDATES_NOT_ALLOWED", skus: ["B"] });
    const count = await db.pool.query("select count(*)::int as n from products where workspace_id = $1", [workspaceId]);
    expect(count.rows[0]).toEqual({ n: 2 });

    expect(await commit(db.pool, workspaceId, next, true)).toEqual({ ok: true, added: 1, updated: 1, unchanged: 1 });
  });

  test("an import with errors writes nothing", async () => {
    const result = await commit(db.pool, workspaceId, "sku,name\nZ1,Zed\nZ1,Zed again\n", true);
    expect(result).toMatchObject({ ok: false, code: "IMPORT_ERRORS" });
    const z = await db.pool.query("select 1 from products where workspace_id = $1 and sku = 'Z1'", [workspaceId]);
    expect(z.rowCount).toBe(0);
  });

  test("renaming a product does not change orders already placed", async () => {
    const owner = (await db.pool.query<{ id: string }>("insert into members (workspace_id, display_name, role) values ($1, 'O', 'OWNER') returning id", [workspaceId])).rows[0]!.id;
    await commit(db.pool, workspaceId, "sku,name,bin\nD,Date,D-01\n", true);
    const created = await createOrder(db.pool, { workspaceId, createdBy: owner, sourceKey: `t:${randomUUID()}`, connectionId: null, sourceMessageId: null, request: { ref: null, lines: [{ sku: "D", quantity: 1 }] } });
    await commit(db.pool, workspaceId, "sku,name,bin\nD,Dried date,D-09\n", true);
    const line = await db.pool.query("select name_snapshot, bin_snapshot from order_lines where order_id = $1", ["orderId" in created ? created.orderId : ""]);
    expect(line.rows[0]).toEqual({ name_snapshot: "Date", bin_snapshot: "D-01" });
  });

  test("exports the active catalogue in the columns import reads, defusing formulas", async () => {
    const other = (await db.pool.query<{ id: string }>("insert into workspaces (name) values ('Export') returning id")).rows[0]!.id;
    await commit(db.pool, other, 'sku,name,bin,route_rank\nE1,"Eggs, large",E-01,2\nE2,=HYPERLINK("x"),,1\n', false);
    const csv = await catalogueCsv(db.pool, other);
    expect(csv).toBe('sku,name,bin,route_rank\r\nE2,"\'=HYPERLINK(""x"")",,1\r\nE1,"Eggs, large",E-01,2\r\n');
    expect(parseCatalogue(csv).rows.map((row) => [row.sku, row.name, row.bin, row.routeRank])).toEqual([
      ["E2", "'=HYPERLINK(\"x\")", null, 1],
      ["E1", "Eggs, large", "E-01", 2],
    ]);
  });
});
