import { createHmac, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "./db/testdb.ts";
import { saveDraft } from "./drafts.ts";
import { createOrder, runCommand, workerView, type Actor } from "./fulfilment.ts";
import { buildHttp, hashToken } from "./http.ts";

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

describe("assigning from the console", () => {
  async function queuedOrder() {
    const created = await createOrder(db.pool, {
      workspaceId,
      createdBy: (await db.pool.query<{ id: string }>("select id from members where telegram_user_id = '100'")).rows[0]!.id,
      sourceKey: `test:${randomUUID()}`,
      connectionId: null,
      sourceMessageId: null,
      request: { ref: null, lines: [{ sku: "TS-BLK-M", quantity: 1 }] },
    });
    if (!created.ok || !("orderId" in created)) throw new Error("not created");
    return created.orderId;
  }
  const newPicker = async (name: string) =>
    (await db.pool.query<{ id: string }>("insert into members (workspace_id, display_name, role) values ($1, $2, 'PICKER') returning id", [workspaceId, name])).rows[0]!.id;
  const assignTo = async (orderId: string, memberId: string) => {
    const { order } = (await app.inject({ method: "GET", url: `/v1/workspaces/${workspaceId}/orders/${orderId}`, headers: coordinatorHeaders })).json().data;
    return app.inject({
      method: "POST", url: `/v1/workspaces/${workspaceId}/console/commands`, headers: coordinatorHeaders,
      payload: { commandId: randomUUID(), type: "ASSIGN_ORDER", orderId, expectedRevision: order.revision, expectedVersion: order.version, payload: { memberId } },
    });
  };

  test("lists pickers, assigns one, and only that picker is offered the order", async () => {
    const orderId = await queuedOrder();
    const chosen = await newPicker("Picker 07");
    const other = await newPicker("Picker 08");
    const listed = (await app.inject({ method: "GET", url: `/v1/workspaces/${workspaceId}/pickers`, headers: coordinatorHeaders })).json().data.pickers;
    expect(listed).toEqual(expect.arrayContaining([{ id: chosen, name: "Picker 07", openOrders: 0 }]));

    expect((await assignTo(orderId, chosen)).statusCode).toBe(200);
    const { order } = (await app.inject({ method: "GET", url: `/v1/workspaces/${workspaceId}/orders/${orderId}`, headers: coordinatorHeaders })).json().data;
    expect({ picker: order.picker, hold: order.hold }).toEqual({ picker: "Picker 07", hold: "AWAITING_PICKER" });

    const mine = await workerView(db.pool, workspaceId, chosen);
    expect({ order: mine.order?.id, plan: mine.plan.kind }).toEqual({ order: orderId, plan: "OFFER" });
    expect((await workerView(db.pool, workspaceId, other)).order?.id).not.toBe(orderId);

    const claimed = await runCommand(db.pool, { workspaceId, memberId: chosen, role: "PICKER" }, randomUUID(), { type: "CLAIM_ORDER", orderId, revision: 1, version: 2, toteId: "A" });
    expect(claimed.status).toBe(200);
    const after = (await app.inject({ method: "GET", url: `/v1/workspaces/${workspaceId}/orders/${orderId}`, headers: coordinatorHeaders })).json().data.order;
    expect({ hold: after.hold, toteId: after.toteId }).toEqual({ hold: "NONE", toteId: "A" });
  });

  test("moves an unstarted order to another picker, leaving one live assignment", async () => {
    const orderId = await queuedOrder();
    await assignTo(orderId, await newPicker("Picker 09"));
    const second = await newPicker("Picker 10");
    expect((await assignTo(orderId, second)).statusCode).toBe(200);
    const live = await db.pool.query("select worker_id from assignments where order_id = $1 and released_at is null", [orderId]);
    expect(live.rows).toEqual([{ worker_id: second }]);
  });

  test("refuses a member who is not a picker, and a picker cannot assign", async () => {
    const orderId = await queuedOrder();
    const coordinatorId = (await db.pool.query<{ id: string }>("select id from members where telegram_user_id = '100'")).rows[0]!.id;
    const refused = await assignTo(orderId, coordinatorId);
    expect({ status: refused.statusCode, code: refused.json().error.code }).toEqual({ status: 400, code: "NOT_A_PICKER" });
    const byPicker = await app.inject({ method: "GET", url: `/v1/workspaces/${workspaceId}/pickers`, headers: pickerHeaders });
    expect(byPicker.statusCode).toBe(404);
  });
});

describe("creating an order from the console", () => {
  const create = (payload: object, headers = coordinatorHeaders) => app.inject({ method: "POST", url: `/v1/workspaces/${workspaceId}/orders`, headers, payload });

  test("queues the order with catalogue snapshots and posts nothing to Telegram", async () => {
    const created = await create({ commandId: randomUUID(), ref: "WEB-1", lines: [{ sku: "ts-blk-m", quantity: 2 }, { sku: "CP-WHT", quantity: 1 }] });
    expect(created.statusCode).toBe(200);
    const { orderId, ref } = created.json().data;
    expect(ref).toBe("WEB-1");
    const lines = await db.pool.query("select sku_snapshot as sku, name_snapshot as name, requested_qty as requested from order_lines where order_id = $1 order by creation_index", [orderId]);
    expect(lines.rows).toEqual([{ sku: "TS-BLK-M", name: "Black T-shirt", requested: 2 }, { sku: "CP-WHT", name: "White cap", requested: 1 }]);
    const source = await db.pool.query("select source_key like 'miniapp:%' as from_miniapp, connection_id from orders where id = $1", [orderId]);
    expect(source.rows).toEqual([{ from_miniapp: true, connection_id: null }]);
    const outbox = await db.pool.query("select count(*)::int as n from telegram_outbox where order_id = $1 and status <> 'NOT_REQUIRED'", [orderId]);
    expect(outbox.rows).toEqual([{ n: 0 }]);
  });

  test("returns the same order for a retried submit and refuses the ID reused with other lines", async () => {
    const commandId = randomUUID();
    const first = await create({ commandId, ref: null, lines: [{ sku: "TS-BLK-M", quantity: 1 }] });
    const again = await create({ commandId, ref: null, lines: [{ sku: "TS-BLK-M", quantity: 1 }] });
    expect(again.json().data).toEqual(first.json().data);
    const changed = await create({ commandId, ref: null, lines: [{ sku: "TS-BLK-M", quantity: 2 }] });
    expect({ status: changed.statusCode, code: changed.json().error.code }).toEqual({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
  });

  test.each([
    { name: "an unknown SKU", lines: [{ sku: "NOPE", quantity: 1 }], status: 400, code: "UNKNOWN_SKU" },
    { name: "the same SKU twice", lines: [{ sku: "CP-WHT", quantity: 1 }, { sku: "cp-wht", quantity: 1 }], status: 400, code: "INVALID_INPUT" },
    { name: "a zero quantity", lines: [{ sku: "CP-WHT", quantity: 0 }], status: 400, code: "INVALID_INPUT" },
    { name: "no lines", lines: [], status: 400, code: "INVALID_INPUT" },
  ])("refuses $name", async ({ lines, status, code }) => {
    const refused = await create({ commandId: randomUUID(), ref: null, lines });
    expect({ status: refused.statusCode, code: refused.json().error.code }).toEqual({ status, code });
  });

  test("refuses a reference already in use, and a picker cannot create", async () => {
    await create({ commandId: randomUUID(), ref: "WEB-9", lines: [{ sku: "CP-WHT", quantity: 1 }] });
    const taken = await create({ commandId: randomUUID(), ref: "WEB-9", lines: [{ sku: "CP-WHT", quantity: 1 }] });
    expect({ status: taken.statusCode, code: taken.json().error.code }).toEqual({ status: 409, code: "REF_TAKEN" });
    expect((await create({ commandId: randomUUID(), ref: null, lines: [{ sku: "CP-WHT", quantity: 1 }] }, pickerHeaders)).statusCode).toBe(404);
  });
});

describe("drafts in the console", () => {
  test("lists an open draft, confirms it into one order, and a repeated SKU or a picker is refused", async () => {
    // Its own coordinator, so the create rate limit is not shared with the tests above.
    const coord = (await db.pool.query<{ id: string }>("insert into members (workspace_id, display_name, role, telegram_user_id) values ($1, 'Drafts', 'COORDINATOR', '400') returning id", [workspaceId])).rows[0]!.id;
    const session = await app.inject({ method: "POST", url: "/v1/telegram/miniapp/session", payload: { initData: launchData(400) } });
    const coordinatorHeaders = { authorization: `Bearer ${session.json().data.token}` };
    const saved = await saveDraft(db.pool, {
      workspaceId, createdBy: coord, sourceKey: `test:${randomUUID()}`, connectionId: null, sourceMessageId: null, ref: "DRAFT-1",
      lines: [{ item: "blue mug", quantity: 2, match: { kind: "UNKNOWN" } }],
    });
    const base = `/v1/workspaces/${workspaceId}/drafts`;

    const listed = await app.inject({ method: "GET", url: base, headers: coordinatorHeaders });
    expect(listed.json().data.drafts).toMatchObject([{ id: saved, ref: "DRAFT-1", createdBy: "Drafts", lines: [{ item: "blue mug", quantity: 2, sku: null, candidates: [] }] }]);
    expect((await app.inject({ method: "GET", url: `${base}/${saved}`, headers: pickerHeaders })).statusCode).toBe(404);

    const twice = await app.inject({ method: "POST", url: `${base}/${saved}/confirm`, headers: coordinatorHeaders, payload: { lines: [{ sku: "CP-WHT", quantity: 1 }, { sku: "cp-wht", quantity: 1 }] } });
    expect({ status: twice.statusCode, code: twice.json().error.code }).toEqual({ status: 400, code: "INVALID_INPUT" });
    const confirmed = await app.inject({ method: "POST", url: `${base}/${saved}/confirm`, headers: coordinatorHeaders, payload: { lines: [{ sku: "CP-WHT", quantity: 2 }] } });
    expect(confirmed.json().data).toMatchObject({ ref: "DRAFT-1" });
    expect((await app.inject({ method: "GET", url: base, headers: coordinatorHeaders })).json().data.drafts).toEqual([]);
    expect((await app.inject({ method: "POST", url: `${base}/${saved}/discard`, headers: coordinatorHeaders })).statusCode).toBe(404);
  });
});

describe("searching and paging the order list", () => {
  let otherWorkspace: string;
  let headers: Record<string, string>;
  type Page = { orders: { ref: string }[]; next: string | null };
  const list = async (query: string): Promise<Page> => (await get(`/v1/workspaces/${otherWorkspace}/orders?${query}`, headers)).json().data;

  beforeAll(async () => {
    otherWorkspace = (await db.pool.query<{ id: string }>("insert into workspaces (name) values ('Paging') returning id")).rows[0]!.id;
    const coordinatorId = (await db.pool.query<{ id: string }>("insert into members (workspace_id, display_name, role, telegram_user_id) values ($1, 'Pager', 'COORDINATOR', '300') returning id", [otherWorkspace])).rows[0]!.id;
    await db.pool.query("insert into products (workspace_id, sku, normalized_sku, name) values ($1, 'MUG-1', 'MUG-1', 'Mug'), ($1, 'PEN_2', 'PEN_2', 'Pen')", [otherWorkspace]);
    for (let n = 1; n <= 52; n++) {
      await createOrder(db.pool, {
        workspaceId: otherWorkspace, createdBy: coordinatorId, sourceKey: `test:${randomUUID()}`, connectionId: null, sourceMessageId: null,
        request: { ref: `PG-${n}`, lines: [{ sku: n === 7 ? "PEN_2" : "MUG-1", quantity: 1 }] },
      });
    }
    const session = await app.inject({ method: "POST", url: "/v1/telegram/miniapp/session", payload: { initData: launchData(300) } });
    headers = { authorization: `Bearer ${session.json().data.token}` };
  });

  test("pages through every order once, newest first", async () => {
    const first = await list("view=active");
    const second = await list(`view=active&cursor=${first.next}`);
    const refs = [...first.orders, ...second.orders].map((order) => order.ref);
    expect({ first: first.orders.length, second: second.orders.length, next: second.next, unique: new Set(refs).size, newest: refs[0] }).toEqual({ first: 50, second: 2, next: null, unique: 52, newest: "PG-52" });
  });

  test.each([
    { name: "part of a reference", q: "pg-5", refs: ["PG-52", "PG-51", "PG-50", "PG-5"] },
    { name: "a SKU on a line", q: "pen", refs: ["PG-7"] },
    { name: "an underscore as itself, not a wildcard", q: "PG_5", refs: [] },
    { name: "nothing", q: "zzz", refs: [] },
  ])("finds orders by $name", async ({ q, refs }) => {
    expect((await list(`view=active&q=${encodeURIComponent(q)}`)).orders.map((order) => order.ref)).toEqual(refs);
  });

  test("refuses a cursor it did not issue", async () => {
    const refused = await get(`/v1/workspaces/${otherWorkspace}/orders?view=active&cursor=bm9wZQ`, headers);
    expect({ status: refused.statusCode, code: refused.json().error.code }).toEqual({ status: 400, code: "INVALID_CURSOR" });
  });
});

describe("sessions", () => {
  type Listed = { label: string; picker: string; isConnected: boolean; lastSeenAt: string | null; orders: { ref: string; toteId: string | null }[] };
  const listSessions = async (): Promise<Listed[]> => (await get(`/v1/workspaces/${workspaceId}/sessions`)).json().data.sessions;

  test("records presence when the glasses poll, at most every 30 seconds", async () => {
    const { picker } = await pickedOrder();
    const token = randomUUID().replaceAll("-", "");
    await db.pool.query("insert into device_tokens (workspace_id, member_id, label, token_hash, expires_at) values ($1, $2, 'Seen G2', $3, now() + interval '1 hour')", [workspaceId, picker.memberId, hashToken(token)]);
    const poll = () => app.inject({ method: "GET", url: `/v1/workspaces/${workspaceId}/worker/snapshot`, headers: { authorization: `Bearer ${token}` } });
    const seen = async () => (await db.pool.query<{ at: Date }>("select last_seen_at as at from device_tokens where token_hash = $1", [hashToken(token)])).rows[0]!.at;

    expect((await poll()).statusCode).toBe(200);
    const first = await seen();
    await poll();
    expect({ first: first !== null, unchanged: (await seen()).getTime() === first.getTime() }).toEqual({ first: true, unchanged: true });
  });

  test("shows a connected picker's order and tote, and a silent one as last seen, still holding it", async () => {
    const { ref, picker } = await pickedOrder();
    await db.pool.query("insert into device_tokens (workspace_id, member_id, label, token_hash, expires_at, last_seen_at) values ($1, $2, 'G2', $3, now() + interval '1 hour', now())", [workspaceId, picker.memberId, hashToken(randomUUID())]);
    const holding = (listed: Listed[]) => listed.find((session) => session.orders.some((order) => order.ref === ref));
    expect(holding(await listSessions())).toMatchObject({ isConnected: true, orders: [{ ref, toteId: "A" }] });

    await db.pool.query("update device_tokens set last_seen_at = now() - interval '5 minutes' where member_id = $1", [picker.memberId]);
    const silent = holding(await listSessions());
    expect({ isConnected: silent?.isConnected, hasLastSeen: silent?.lastSeenAt !== null, orders: silent?.orders }).toEqual({ isConnected: false, hasLastSeen: true, orders: [{ ref, toteId: "A" }] });
  });

  test("leaves out revoked glasses and is closed to pickers", async () => {
    const { picker } = await pickedOrder();
    await db.pool.query("insert into device_tokens (workspace_id, member_id, label, token_hash, expires_at, revoked_at) values ($1, $2, 'Revoked G2', $3, now() + interval '1 hour', now())", [workspaceId, picker.memberId, hashToken(randomUUID())]);
    expect((await listSessions()).some((session) => session.label === "Revoked G2")).toBe(false);
    expect((await get(`/v1/workspaces/${workspaceId}/sessions`, pickerHeaders)).statusCode).toBe(404);
  });
});
