import { createHmac, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "./db/testdb.ts";
import { createOrder } from "./fulfilment.ts";
import { buildHttp } from "./http.ts";
import { purgeExpired } from "./settings.ts";

const botToken = "123456:test-token-for-signing-launch-data";

function launchData(userId: number): string {
  const fields: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: "U" }) };
  const checkString = Object.keys(fields).sort().map((key) => `${key}=${fields[key]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  return new URLSearchParams({ ...fields, hash: createHmac("sha256", secret).update(checkString).digest("hex") }).toString();
}

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

async function workspace(name: string, retentionDays: number | null): Promise<{ id: string; ownerId: string }> {
  const id = (await db.pool.query<{ id: string }>("insert into workspaces (name, retention_days) values ($1, $2) returning id", [name, retentionDays])).rows[0]!.id;
  const ownerId = (await db.pool.query<{ id: string }>("insert into members (workspace_id, display_name, role) values ($1, 'Owner', 'OWNER') returning id", [id])).rows[0]!.id;
  await db.pool.query("insert into products (workspace_id, sku, normalized_sku, name) values ($1, 'MUG-1', 'MUG-1', 'Mug')", [id]);
  return { id, ownerId };
}

// An order with its lines and events, then closed (or left open) as of days ago.
async function order(at: { id: string; ownerId: string }, ref: string, closedDaysAgo: number | null, openDaysAgo = 0): Promise<string> {
  const created = await createOrder(db.pool, {
    workspaceId: at.id, createdBy: at.ownerId, sourceKey: `test:${randomUUID()}`, connectionId: null, sourceMessageId: null,
    request: { ref, lines: [{ sku: "MUG-1", quantity: 1 }] },
  });
  if (!created.ok || !("orderId" in created)) throw new Error("not created");
  if (closedDaysAgo === null) {
    await db.pool.query("update orders set updated_at = now() - make_interval(days => $2) where id = $1", [created.orderId, openDaysAgo]);
  } else {
    await db.pool.query("update orders set terminal = 'CANCELLED', updated_at = now() - make_interval(days => $2) where id = $1", [created.orderId, closedDaysAgo]);
  }
  return created.orderId;
}

describe("retention", () => {
  test("purges closed orders past the window with their lines and events, and keeps the rest", async () => {
    const short = await workspace("Ninety days", 90);
    const forever = await workspace("Keep everything", null);
    const old = await order(short, "OLD-1", 100);
    await order(short, "RECENT-1", 10);
    await order(short, "OPEN-1", null, 200);
    await order(forever, "KEPT-1", 1000);

    expect(await purgeExpired(db.pool)).toBe(1);
    const refs = await db.pool.query<{ ref: string }>("select ref from orders order by ref");
    const leftovers = await db.pool.query<{ n: number }>(
      "select (select count(*) from order_lines where order_id = $1) + (select count(*) from fulfilment_events where order_id = $1) as n",
      [old],
    );
    expect({ refs: refs.rows.map((row) => row.ref), leftovers: Number(leftovers.rows[0]!.n) }).toEqual({ refs: ["KEPT-1", "OPEN-1", "RECENT-1"], leftovers: 0 });
    expect(await purgeExpired(db.pool)).toBe(0);
  });

  test("purges an old order that came from a confirmed draft, and drafts past their week", async () => {
    const short = await workspace("Drafts", 90);
    const old = await order(short, "DRAFTED-1", 100);
    const lines = JSON.stringify([{ item: "mug", quantity: 1, sku: "MUG-1", candidates: [] }]);
    await db.pool.query(
      `insert into order_drafts (workspace_id, source_key, created_by, lines, status, order_id) values ($1, 'test:confirmed', $2, $3, 'CONFIRMED', $4)`,
      [short.id, short.ownerId, lines, old],
    );
    await db.pool.query(
      `insert into order_drafts (workspace_id, source_key, created_by, lines, expires_at) values ($1, 'test:stale', $2, $3, now() - interval '1 minute'), ($1, 'test:fresh', $2, $3, default)`,
      [short.id, short.ownerId, lines],
    );

    expect(await purgeExpired(db.pool)).toBe(1);
    const left = await db.pool.query<{ source_key: string }>("select source_key from order_drafts where workspace_id = $1", [short.id]);
    expect(left.rows.map((row) => row.source_key)).toEqual(["test:fresh"]);
  });
});

describe("the settings page", () => {
  let workspaceId: string;
  let owner: Record<string, string>;
  let coordinator: Record<string, string>;

  beforeAll(async () => {
    workspaceId = (await db.pool.query<{ id: string }>("insert into workspaces (name) values ('Settings') returning id")).rows[0]!.id;
    await db.pool.query("insert into members (workspace_id, display_name, role, telegram_user_id) values ($1, 'O', 'OWNER', '900'), ($1, 'C', 'COORDINATOR', '901')", [workspaceId]);
    const signIn = async (id: number) => {
      const session = await app.inject({ method: "POST", url: "/v1/telegram/miniapp/session", payload: { initData: launchData(id) } });
      return { authorization: `Bearer ${session.json().data.token}` };
    };
    owner = await signIn(900);
    coordinator = await signIn(901);
  });

  const url = () => `/v1/workspaces/${workspaceId}/settings`;
  const change = (payload: object, headers = owner) => app.inject({ method: "POST", url: url(), headers, payload });

  test("starts in UTC keeping everything, and an owner changes both", async () => {
    expect((await app.inject({ method: "GET", url: url(), headers: coordinator })).json().data).toEqual({ timeZone: "UTC", retentionDays: null });
    expect((await change({ timeZone: "Africa/Lagos", retentionDays: 365 })).json().data).toEqual({ timeZone: "Africa/Lagos", retentionDays: 365 });
    expect((await app.inject({ method: "GET", url: url(), headers: coordinator })).json().data).toEqual({ timeZone: "Africa/Lagos", retentionDays: 365 });
  });

  test.each([
    { name: "an unknown time zone", payload: { timeZone: "Mars/Olympus", retentionDays: null }, status: 400, code: "INVALID_INPUT" },
    { name: "a retention that is not offered", payload: { timeZone: "UTC", retentionDays: 30 }, status: 400, code: "INVALID_INPUT" },
  ])("refuses $name", async ({ payload, status, code }) => {
    const refused = await change(payload);
    expect({ status: refused.statusCode, code: refused.json().error.code }).toEqual({ status, code });
  });

  test("a coordinator can read but not change settings", async () => {
    const refused = await change({ timeZone: "UTC", retentionDays: 90 }, coordinator);
    expect({ status: refused.statusCode, code: refused.json().error.code }).toEqual({ status: 403, code: "ROLE_REQUIRED" });
  });
});
