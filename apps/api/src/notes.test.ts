// Notes from the group to the glasses and quick replies back (PRD §10.8).

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { BotApi, Message, Result, Update } from "@stow/telegram/botapi";
import { createTestDatabase, type TestDatabase } from "./db/testdb.ts";
import { runCommand, workerView, type Actor } from "./fulfilment.ts";
import { markRead, sendReply } from "./messages.ts";
import { deliverOutbox, hashCode, processInbox, receive, type Telegram } from "./telegram.ts";

type Call = { method: string; text: string; replyTo?: number | undefined; messageId?: string };
let calls: Call[];
let nextId = 9000;
const api: BotApi = {
  getMe: async () => ({ kind: "ok", value: { id: 1, username: "stow_test_bot" } }),
  getUpdates: async () => ({ kind: "ok", value: [] }),
  sendMessage: async (_chat, text, replyTo) => {
    calls.push({ method: "send", text, replyTo });
    return { kind: "ok", value: { message_id: nextId++, chat: { id: 0, type: "group" } } } as Result<Message>;
  },
  editMessageText: async (_chat, messageId, text) => {
    calls.push({ method: "edit", text, messageId });
    return { kind: "ok", value: true };
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
});

let updateId = 1;
function say(chatId: number, fromId: number, text: string, replyTo?: number): Update {
  return {
    update_id: updateId++,
    message: {
      message_id: nextId++,
      chat: { id: chatId, type: "supergroup" },
      from: { id: fromId, is_bot: false, first_name: "C" },
      text,
      ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}),
    },
  };
}

async function send(update: Update): Promise<void> {
  await receive(db.pool, "test", update);
  await processInbox(telegram);
}

// A bound group with an order whose status message is posted and claimed by the picker.
async function scene() {
  const q = async (sql: string, params: unknown[]) => (await db.pool.query<{ id: string }>(sql, params)).rows[0]!.id;
  const workspaceId = await q("insert into workspaces (name) values ('Stockroom') returning id", []);
  const coordinatorId = await q("insert into members (workspace_id, display_name, role) values ($1, 'Coordinator', 'COORDINATOR') returning id", [workspaceId]);
  const pickerId = await q("insert into members (workspace_id, display_name, role) values ($1, 'Picker 02', 'PICKER') returning id", [workspaceId]);
  const otherId = await q("insert into members (workspace_id, display_name, role) values ($1, 'Picker 03', 'PICKER') returning id", [workspaceId]);
  await db.pool.query("insert into products (workspace_id, sku, normalized_sku, name, bin) values ($1, 'CP-WHT', 'CP-WHT', 'White cap', 'B-11')", [workspaceId]);
  const code = randomUUID().slice(0, 8).toUpperCase();
  await db.pool.query("insert into telegram_bind_challenges (workspace_id, member_id, code_hash, expires_at) values ($1, $2, $3, now() + interval '5 minutes')", [workspaceId, coordinatorId, hashCode(code)]);
  const chatId = -Math.floor(Math.random() * 1e12);
  const fromId = Math.floor(Math.random() * 1e9);
  await send(say(chatId, fromId, `/stow_bind ${code}`));
  await send(say(chatId, fromId, "/order\nCP-WHT x 2"));
  const picker: Actor = { workspaceId, memberId: pickerId, role: "PICKER" };
  const orderId = (await workerView(db.pool, workspaceId, pickerId)).order!.id;
  await runCommand(db.pool, picker, randomUUID(), { type: "CLAIM_ORDER", orderId, revision: 1, version: 1, toteId: "A" });
  await deliverOutbox(telegram);
  const status = await db.pool.query<{ message_id: string }>("select message_id from telegram_message_refs where order_id = $1 and purpose = 'STATUS'", [orderId]);
  calls = [];
  return { workspaceId, chatId, fromId, picker, other: { workspaceId, memberId: otherId, role: "PICKER" as const }, orderId, statusMessage: Number(status.rows[0]!.message_id) };
}

const view = (s: Awaited<ReturnType<typeof scene>>) => workerView(db.pool, s.workspaceId, s.picker.memberId);

describe("coordinator notes", () => {
  test("a coordinator's reply to the status message appears on the glasses without changing the order", async () => {
    const s = await scene();
    const before = (await view(s)).order!.version;
    await send(say(s.chatId, s.fromId, "White caps are on the top shelf", s.statusMessage));
    const after = await view(s);
    expect(after.note).toMatchObject({ body: "White caps are on the top shelf", author: "Coordinator" });
    expect(after.order!.version).toBe(before);

    await deliverOutbox(telegram);
    expect(calls.at(-1)).toMatchObject({ method: "edit", messageId: String(s.statusMessage) });
    expect(calls.at(-1)!.text.split("\n").at(-1)).toBe("Note sent to the picker.");
  });

  test("marking it read clears it from the glasses and tells the group", async () => {
    const s = await scene();
    await send(say(s.chatId, s.fromId, "/note " + (await ref(s.orderId)) + " Use tote B"));
    const note = (await view(s)).note!;
    expect(await markRead(db.pool, s.picker, note.id)).toBe(true);
    expect((await view(s)).note).toBeNull();
    await deliverOutbox(telegram);
    expect(calls.at(-1)!.text.split("\n").at(-1)).toBe("Note read by the picker.");
    expect(await markRead(db.pool, s.other, note.id)).toBe(false);
  });

  test("replies from non-coordinators and plain chat are never read", async () => {
    const s = await scene();
    await send(say(s.chatId, s.fromId + 1, "I am not linked", s.statusMessage));
    await send(say(s.chatId, s.fromId, "just chatting"));
    expect((await view(s)).note).toBeNull();
    const stored = await db.pool.query("select count(*)::int as n from telegram_inbox where payload <> '{}'");
    expect(stored.rows[0]).toEqual({ n: 0 });
  });
});

describe("picker replies", () => {
  test("a quick reply is posted once under the order's status message", async () => {
    const s = await scene();
    const clientId = randomUUID();
    expect(await sendReply(db.pool, s.picker, s.orderId, clientId, "FOUND")).toBe("SENT");
    expect(await sendReply(db.pool, s.picker, s.orderId, clientId, "FOUND")).toBe("SENT");
    await deliverOutbox(telegram);
    const posted = calls.filter((call) => call.text.endsWith("Found them"));
    expect(posted).toEqual([{ method: "send", text: `Picker 02 · ${await ref(s.orderId)}: Found them`, replyTo: s.statusMessage }]);
  });

  test("only the assigned picker can reply, and only with a known quick reply", async () => {
    const s = await scene();
    expect(await sendReply(db.pool, s.other, s.orderId, randomUUID(), "ON_IT")).toBe("NOT_ASSIGNED");
    expect(await sendReply(db.pool, s.picker, s.orderId, randomUUID(), "DROP TABLE")).toBe("UNKNOWN_REPLY");
  });
});

async function ref(orderId: string): Promise<string> {
  return (await db.pool.query<{ ref: string }>("select ref from orders where id = $1", [orderId])).rows[0]!.ref;
}
