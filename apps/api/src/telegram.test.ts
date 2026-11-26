import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { BotApi, Message, Result, Update } from "@stow/telegram/botapi";
import { createTestDatabase, type TestDatabase } from "./db/testdb.ts";
import { runCommand, workerView } from "./fulfilment.ts";
import { deliverOutbox, hashCode, processInbox, receive, type Telegram } from "./telegram.ts";

// Telegram is a third-party boundary: this stand-in records calls and answers
// with whatever the test sets next.
type Call = { method: "send" | "edit"; chatId: string; text: string; replyTo?: number | undefined; messageId?: string };
let calls: Call[];
let nextSend: () => Result<Message>;
let nextEdit: () => Result<true>;
const api: BotApi = {
  getMe: async () => ({ kind: "ok", value: { id: 1, username: "stow_test_bot" } }),
  getUpdates: async () => ({ kind: "ok", value: [] }),
  sendMessage: async (chatId, text, replyTo) => {
    calls.push({ method: "send", chatId, text, replyTo });
    return nextSend();
  },
  editMessageText: async (chatId, messageId, text) => {
    calls.push({ method: "edit", chatId, text, messageId });
    return nextEdit();
  },
  answerCallbackQuery: async () => ({ kind: "ok", value: true }),
};

let db: TestDatabase;
let telegram: Telegram;
beforeAll(async () => {
  db = await createTestDatabase();
  telegram = { pool: db.pool, api, botAlias: "test", botUsername: "stow_test_bot" };
});
afterAll(async () => {
  await db.drop();
});
beforeEach(() => {
  calls = [];
  let id = 500;
  nextSend = () => ({ kind: "ok", value: { message_id: id++, chat: { id: 0, type: "group" } } });
  nextEdit = () => ({ kind: "ok", value: true });
});

let updateId = 1;
let messageId = 100;
function update(chatId: number, fromId: number, text: string, extra: Partial<Message> = {}): Update {
  return {
    update_id: updateId++,
    message: { message_id: messageId++, chat: { id: chatId, type: "supergroup" }, from: { id: fromId, is_bot: false, first_name: "C" }, text, ...extra },
  };
}

async function send(...updates: Update[]): Promise<void> {
  for (const u of updates) await receive(db.pool, "test", u);
  await processInbox(telegram);
}

async function boundWorkspace() {
  const q = async (sql: string, params: unknown[]) => (await db.pool.query<{ id: string }>(sql, params)).rows[0]!.id;
  const workspaceId = await q("insert into workspaces (name) values ('Stockroom') returning id", []);
  const coordinator = await q("insert into members (workspace_id, display_name, role) values ($1, 'Coordinator', 'COORDINATOR') returning id", [workspaceId]);
  const picker = await q("insert into members (workspace_id, display_name, role) values ($1, 'Picker 02', 'PICKER') returning id", [workspaceId]);
  for (const sku of ["TS-BLK-M", "CP-WHT"]) {
    await db.pool.query("insert into products (workspace_id, sku, normalized_sku, name, bin) values ($1, $2, $2, $2, 'A-01')", [workspaceId, sku]);
  }
  const code = randomUUID().slice(0, 8).toUpperCase();
  await db.pool.query(
    "insert into telegram_bind_challenges (workspace_id, member_id, code_hash, expires_at) values ($1, $2, $3, now() + interval '5 minutes')",
    [workspaceId, coordinator, hashCode(code)],
  );
  const chatId = -Math.floor(Math.random() * 1e12);
  const fromId = Math.floor(Math.random() * 1e9);
  await send(update(chatId, fromId, `/stow_bind ${code}`));
  calls = [];
  return { workspaceId, coordinator, picker, chatId, fromId, code };
}

const orderCount = async (workspaceId: string) =>
  (await db.pool.query<{ n: number }>("select count(*)::int as n from orders where workspace_id = $1", [workspaceId])).rows[0]!.n;

describe("binding", () => {
  test("a valid code connects the group and links the sender to the code's member", async () => {
    const ws = await boundWorkspace();
    const member = await db.pool.query("select telegram_user_id from members where id = $1", [ws.coordinator]);
    expect(member.rows[0]).toEqual({ telegram_user_id: String(ws.fromId) });
    const connection = await db.pool.query("select status from telegram_connections where chat_id = $1", [String(ws.chatId)]);
    expect(connection.rows).toEqual([{ status: "ACTIVE" }]);
  });

  test("a code works once", async () => {
    const ws = await boundWorkspace();
    await send(update(-42, ws.fromId, `/stow_bind ${ws.code}`));
    expect(calls.at(-1)?.text).toMatch(/not valid/);
  });
});

describe("order intake", () => {
  test("an order from a linked coordinator is queued and answered with a status message", async () => {
    const ws = await boundWorkspace();
    const order = update(ws.chatId, ws.fromId, "/order ST-9\nTS-BLK-M x 3\nCP-WHT x 2");
    await send(order);
    expect(await orderCount(ws.workspaceId)).toBe(1);

    await deliverOutbox(telegram);
    expect(calls).toEqual([
      { method: "send", chatId: String(ws.chatId), text: "ST-9 · QUEUED · rev 1\nTS-BLK-M: 0/3\nCP-WHT: 0/2\n2 lines / 5 units. Awaiting picker.", replyTo: order.message!.message_id },
    ]);
  });

  test("a new update and a new status message are due even if the server clock steps back", async () => {
    const ws = await boundWorkspace();
    await send(update(ws.chatId, ws.fromId, "/order\nTS-BLK-M x 1"));
    await telegram.pool.query("insert into telegram_inbox (bot_alias, update_id, payload) values ('clock-test', '1', '{}')");
    // Asking with a clock a minute behind stands in for a backwards step after the insert.
    const behind = "next_attempt_at <= now() - interval '1 minute'";
    const inbox = await telegram.pool.query(`select 1 from telegram_inbox where bot_alias = 'clock-test' and ${behind}`);
    await telegram.pool.query("delete from telegram_inbox where bot_alias = 'clock-test'");
    const outbox = await telegram.pool.query(`select 1 from telegram_outbox where workspace_id = $1 and status = 'PENDING' and ${behind}`, [ws.workspaceId]);
    expect({ inbox: inbox.rowCount, outbox: outbox.rowCount }).toEqual({ inbox: 1, outbox: 1 });
  });

  test("the same Telegram update delivered twice creates one order", async () => {
    const ws = await boundWorkspace();
    const order = update(ws.chatId, ws.fromId, "/order\nTS-BLK-M x 1");
    await send(order, order);
    expect(await orderCount(ws.workspaceId)).toBe(1);
  });

  test.each([
    { name: "an unlinked sender", from: 999, extra: {}, reply: /Only linked coordinators/ },
    { name: "an anonymous admin", from: null, extra: { sender_chat: { id: -1 } }, reply: null },
    { name: "a forwarded order", from: null, extra: { forward_origin: { type: "user" } }, reply: null },
  ])("ignores $name", async ({ from, extra, reply }) => {
    const ws = await boundWorkspace();
    await send(update(ws.chatId, from ?? ws.fromId, "/order\nTS-BLK-M x 1", extra));
    expect(await orderCount(ws.workspaceId)).toBe(0);
    if (reply) expect(calls.at(-1)?.text).toMatch(reply);
    else expect(calls).toEqual([]);
  });

  test("bad lines and unknown SKUs are answered with what to fix", async () => {
    const ws = await boundWorkspace();
    await send(update(ws.chatId, ws.fromId, "/order\nTS-BLK-M x 0"));
    expect(calls.at(-1)?.text).toBe("Order not created:\nline 1: quantity must be 1 to 10,000");
    await send(update(ws.chatId, ws.fromId, "/order\nNOPE x 1"));
    expect(calls.at(-1)?.text).toBe("Order not created. Unknown SKU: NOPE");
    expect(await orderCount(ws.workspaceId)).toBe(0);
  });

  test("commands in one batch run in the order they were sent", async () => {
    // Regression: rows came back from UPDATE ... RETURNING in arbitrary order,
    // so an /order could run before the /stow_bind just ahead of it and be dropped.
    const q = async (sql: string, params: unknown[]) => (await db.pool.query<{ id: string }>(sql, params)).rows[0]!.id;
    for (let attempt = 0; attempt < 5; attempt++) {
      const workspaceId = await q("insert into workspaces (name) values ('Batch') returning id", []);
      const coordinator = await q("insert into members (workspace_id, display_name, role) values ($1, 'C', 'COORDINATOR') returning id", [workspaceId]);
      await db.pool.query("insert into products (workspace_id, sku, normalized_sku, name) values ($1, 'A', 'A', 'A')", [workspaceId]);
      const code = randomUUID().slice(0, 8).toUpperCase();
      await db.pool.query("insert into telegram_bind_challenges (workspace_id, member_id, code_hash, expires_at) values ($1, $2, $3, now() + interval '5 minutes')", [workspaceId, coordinator, hashCode(code)]);
      const chatId = -Math.floor(Math.random() * 1e12);
      const fromId = Math.floor(Math.random() * 1e9);
      const batch = [update(chatId, fromId, `/stow_bind ${code}`), ...Array.from({ length: 8 }, (_, i) => update(chatId, fromId, `/order B${attempt}-${i}\nA x 1`))];
      await send(...batch);
      expect(await orderCount(workspaceId)).toBe(8);
    }
    while ((await deliverOutbox(telegram)) > 0);
  });

  test("plain chat is never stored or answered", async () => {
    const ws = await boundWorkspace();
    await send(update(ws.chatId, ws.fromId, "TS-BLK-M x 3 please"));
    const stored = await db.pool.query("select status, payload from telegram_inbox where update_id = $1", [String(updateId - 1)]);
    expect(stored.rows).toEqual([{ status: "IGNORED", payload: {} }]);
    expect(calls).toEqual([]);
  });
});

describe("status delivery", () => {
  async function pickedOrder() {
    const ws = await boundWorkspace();
    await send(update(ws.chatId, ws.fromId, "/order ST-7\nTS-BLK-M x 3"));
    await deliverOutbox(telegram);
    const view = await workerView(db.pool, ws.workspaceId, ws.picker);
    const orderId = view.order!.id;
    const actor = { workspaceId: ws.workspaceId, memberId: ws.picker, role: "PICKER" as const };
    await runCommand(db.pool, actor, randomUUID(), { type: "CLAIM_ORDER", orderId, revision: 1, version: 1, toteId: "A" });
    const task = await workerView(db.pool, ws.workspaceId, ws.picker);
    const lineId = task.plan.kind === "TASK" ? task.plan.task.lineId : "";
    await runCommand(db.pool, actor, randomUUID(), { type: "CONFIRM_TASK", orderId, revision: 1, version: 2, kind: "PICK", lineId, quantity: 2 });
    calls = [];
    return ws;
  }

  test("later changes edit the same message once, showing the latest state", async () => {
    const ws = await pickedOrder();
    await deliverOutbox(telegram);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "edit", chatId: String(ws.chatId), text: "ST-7 · PICKING · rev 1\nTote A · Picker 02\nTS-BLK-M: 2/3\nProgress: 2/3 confirmed." });
    const rows = await db.pool.query("select status from telegram_outbox where workspace_id = $1 order by created_at, id", [ws.workspaceId]);
    expect(rows.rows.map((row) => row.status)).toEqual(["SENT", "SENT", "SENT"]);
  });

  test("a rate limit schedules a retry instead of failing", async () => {
    const ws = await pickedOrder();
    nextEdit = () => ({ kind: "retry", after_ms: 5000 });
    await deliverOutbox(telegram);
    const row = await db.pool.query(
      "select status, last_error_code, next_attempt_at > now() + interval '3 seconds' as later from telegram_outbox where workspace_id = $1 and status <> 'SENT'",
      [ws.workspaceId],
    );
    expect(row.rows[0]).toEqual({ status: "RETRY", last_error_code: "rate_limited", later: true });
  });

  test("a first send with no answer is marked uncertain and not repeated", async () => {
    const ws = await boundWorkspace();
    nextSend = () => ({ kind: "unknown", reason: "timeout" });
    await send(update(ws.chatId, ws.fromId, "/order\nTS-BLK-M x 1"));
    calls = [];
    await deliverOutbox(telegram);
    await deliverOutbox(telegram);
    expect(calls).toHaveLength(1);
    const row = await db.pool.query("select status from telegram_outbox where workspace_id = $1", [ws.workspaceId]);
    expect(row.rows).toEqual([{ status: "UNCERTAIN" }]);
  });
});
