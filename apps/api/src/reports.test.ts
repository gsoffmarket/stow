import { createHmac, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "./db/testdb.ts";
import { createOrder, runCommand, workerView, type Command } from "./fulfilment.ts";
import { buildHttp } from "./http.ts";
import { ordersCsv, parseRange, report } from "./reports.ts";

const botToken = "123456:test-token-for-signing-launch-data";

let db: TestDatabase;
let app: FastifyInstance;
beforeAll(async () => {
  db = await createTestDatabase();
  app = buildHttp({ pool: db.pool, taskTokenSecret: "x".repeat(32), botToken, now: () => new Date(), corsAllowedOrigins: [], logger: false });
});
afterAll(async () => {
  await app.close();
  await db.drop();
});

describe("parseRange", () => {
  test.each([
    { name: "a single day", args: ["2026-11-26", "2026-11-26", "Africa/Lagos"], ok: true },
    { name: "a year", args: ["2026-01-01", "2026-12-31", "UTC"], ok: true },
    { name: "to before from", args: ["2026-11-27", "2026-11-26", "UTC"], ok: false },
    { name: "a day that does not exist", args: ["2026-02-30", "2026-03-01", "UTC"], ok: false },
    { name: "more than 366 days", args: ["2025-01-01", "2026-01-02", "UTC"], ok: false },
    { name: "an unknown time zone", args: ["2026-11-26", "2026-11-26", "Mars/Olympus"], ok: false },
    { name: "a timestamp instead of a date", args: ["2026-11-26T00:00", "2026-11-26", "UTC"], ok: false },
  ])("$name", ({ args, ok }) => {
    expect(parseRange(args[0]!, args[1]!, args[2]!) !== null).toBe(ok);
  });
});

async function workspace() {
  const q = async (sql: string, params: unknown[]) => (await db.pool.query<{ id: string }>(sql, params)).rows[0]!.id;
  const workspaceId = await q("insert into workspaces (name) values ('Stockroom') returning id", []);
  const owner = await q("insert into members (workspace_id, display_name, role, telegram_user_id) values ($1, 'Ada', 'OWNER', $2) returning id", [workspaceId, String(Math.floor(Math.random() * 1e9))]);
  const picker = await q("insert into members (workspace_id, display_name, role) values ($1, '=HYPERLINK(\"x\")', 'PICKER') returning id", [workspaceId]);
  await db.pool.query("insert into products (workspace_id, sku, normalized_sku, name, bin) values ($1, 'TS-BLK-M', 'TS-BLK-M', 'Black T-shirt', 'A-03')", [workspaceId]);
  return { workspaceId, owner, picker };
}

type Workspace = Awaited<ReturnType<typeof workspace>>;

async function order(ws: Workspace, quantity: number): Promise<string> {
  const created = await createOrder(db.pool, { workspaceId: ws.workspaceId, createdBy: ws.owner, sourceKey: `test:${randomUUID()}`, connectionId: null, sourceMessageId: null, request: { ref: null, lines: [{ sku: "TS-BLK-M", quantity }] } });
  if (!created.ok || !("orderId" in created)) throw new Error("not created");
  return created.orderId;
}

// Claims, picks and completes the picker's next order, as the glasses would.
async function pickToComplete(ws: Workspace): Promise<void> {
  const actor = { workspaceId: ws.workspaceId, memberId: ws.picker, role: "PICKER" as const };
  for (let step = 0; step < 4; step++) {
    const { order, plan } = await workerView(db.pool, ws.workspaceId, ws.picker);
    if (!order) return;
    const at = { orderId: order.id, revision: order.revision, version: order.version };
    const command: Command =
      plan.kind === "OFFER" ? { type: "CLAIM_ORDER", ...at, toteId: "A" }
      : plan.kind === "TASK" ? { type: "CONFIRM_TASK", ...at, kind: plan.task.kind, lineId: plan.task.lineId, quantity: plan.task.quantity }
      : { type: "COMPLETE_ORDER", ...at };
    expect((await runCommand(db.pool, actor, randomUUID(), command)).status).toBe(200);
    if (command.type === "COMPLETE_ORDER") return;
  }
}

// Moves every event of an order to one instant, standing in for when it happened.
async function happenedAt(orderId: string, at: string): Promise<void> {
  await db.pool.query("update fulfilment_events set occurred_at = $2 where order_id = $1", [orderId, at]);
  await db.pool.query("update orders set created_at = $2 where id = $1", [orderId, at]);
}

describe("report", () => {
  test("counts by calendar day in the viewer's time zone", async () => {
    const ws = await workspace();
    // 23:30 UTC on 25 Nov is 00:30 on 26 Nov in Lagos (UTC+1).
    const lateNight = await order(ws, 1);
    await happenedAt(lateNight, "2026-11-25T23:30:00Z");
    const lagos = (day: string) => report(db.pool, ws.workspaceId, parseRange(day, day, "Africa/Lagos")!);
    expect((await lagos("2026-11-26")).orders.created).toBe(1);
    expect((await lagos("2026-11-25")).orders.created).toBe(0);
    const utc = await report(db.pool, ws.workspaceId, parseRange("2026-11-25", "2026-11-25", "UTC")!);
    expect(utc.orders.created).toBe(1);
    expect((await lagos("2026-11-26")).range).toMatchObject({ startsAt: "2026-11-25T23:00:00.000Z", endsAt: "2026-11-26T23:00:00.000Z" });
  });

  test("counts completed orders and confirmed units on the day they closed, per picker", async () => {
    const ws = await workspace();
    const first = await order(ws, 3);
    await pickToComplete(ws);
    await happenedAt(first, "2026-11-20T10:00:00Z");
    await order(ws, 2);
    await pickToComplete(ws);
    const day = (d: string) => report(db.pool, ws.workspaceId, parseRange(d, d, "UTC")!);
    const today = new Date().toISOString().slice(0, 10);
    expect(await day("2026-11-20")).toMatchObject({ orders: { completed: 1 }, unitsConfirmed: 3, pickers: [{ name: '=HYPERLINK("x")', completed: 1, units: 3 }] });
    expect(await day(today)).toMatchObject({ orders: { completed: 1 }, unitsConfirmed: 2 });
  });

  test("counts an order cancelled before anyone claimed it", async () => {
    const ws = await workspace();
    const orderId = await order(ws, 1);
    const coordinator = { workspaceId: ws.workspaceId, memberId: ws.owner, role: "OWNER" as const };
    expect((await runCommand(db.pool, coordinator, randomUUID(), { type: "REQUEST_CANCEL", orderId, revision: 1, version: 1, reason: "test" })).status).toBe(200);
    const today = new Date().toISOString().slice(0, 10);
    expect((await report(db.pool, ws.workspaceId, parseRange(today, today, "UTC")!)).orders).toEqual({ created: 1, completed: 0, cancelled: 1 });
  });
});

describe("ordersCsv", () => {
  test("exports one row per order in UTC, neutralising cells a spreadsheet would run", async () => {
    const ws = await workspace();
    await order(ws, 3);
    await pickToComplete(ws);
    const today = new Date().toISOString().slice(0, 10);
    const [header, row, end] = (await ordersCsv(db.pool, ws.workspaceId, parseRange(today, today, "UTC")!)).split("\r\n");
    expect(header).toBe("ref,status,source,created_at_utc,closed_at_utc,picker,lines,units_requested,units_confirmed,revision,problems");
    expect(row).toMatch(/^ST-1001,COMPLETED,other,\d{4}-\d{2}-\d{2}T[\d:.]+Z,\d{4}-\d{2}-\d{2}T[\d:.]+Z,"'=HYPERLINK\(""x""\)",1,3,3,1,0$/);
    expect(end).toBe("");
  });
});

describe("reports over HTTP", () => {
  function launchData(userId: string): string {
    const fields: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: Number(userId), first_name: "U" }) };
    const checkString = Object.keys(fields).sort().map((key) => `${key}=${fields[key]}`).join("\n");
    const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
    return new URLSearchParams({ ...fields, hash: createHmac("sha256", secret).update(checkString).digest("hex") }).toString();
  }

  test("serves the report and a CSV download, and refuses a bad range", async () => {
    const ws = await workspace();
    const telegramId = (await db.pool.query<{ telegram_user_id: string }>("select telegram_user_id from members where id = $1", [ws.owner])).rows[0]!.telegram_user_id;
    const session = await app.inject({ method: "POST", url: "/v1/telegram/miniapp/session", payload: { initData: launchData(telegramId) } });
    const headers = { authorization: `Bearer ${session.json().data.token}` };
    const base = `/v1/workspaces/${ws.workspaceId}/reports`;

    const ok = await app.inject({ method: "GET", url: `${base}?from=2026-11-01&to=2026-11-30&tz=Africa%2FLagos`, headers });
    expect(ok.json().data.orders).toEqual({ created: 0, completed: 0, cancelled: 0 });
    const csv = await app.inject({ method: "GET", url: `${base}/orders.csv?from=2026-11-01&to=2026-11-30&tz=UTC`, headers });
    expect({ type: csv.headers["content-type"], disposition: csv.headers["content-disposition"] }).toEqual({
      type: "text/csv; charset=utf-8",
      disposition: 'attachment; filename="stow-orders-2026-11-01-to-2026-11-30.csv"',
    });
    const bad = await app.inject({ method: "GET", url: `${base}?from=2026-11-30&to=2026-11-01&tz=UTC`, headers });
    expect({ status: bad.statusCode, code: bad.json().error.code }).toEqual({ status: 400, code: "INVALID_RANGE" });
  });
});
