// Coordinator decisions in Telegram: previews confirmed with a button, and
// shortage messages answered with Resume / Reduce / Cancel.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { BotApi, Button, Message, Result, Update } from "@stow/telegram/botapi";
import { createTestDatabase, type TestDatabase } from "./db/testdb.ts";
import { runCommand, workerView, type Actor } from "./fulfilment.ts";
import { deliverOutbox, hashCode, processInbox, receive, type Telegram } from "./telegram.ts";

type Call = { method: string; text: string; buttons?: Button[][] | undefined; messageId?: string };
let calls: Call[];
let nextId = 1000;
const api: BotApi = {
  getMe: async () => ({ kind: "ok", value: { id: 1, username: "stow_test_bot" } }),
  getUpdates: async () => ({ kind: "ok", value: [] }),
  sendMessage: async (_chat, text, _replyTo, buttons) => {
    calls.push({ method: "send", text, buttons: buttons?.map((row) => [...row]) });
    return { kind: "ok", value: { message_id: nextId++, chat: { id: 0, type: "group" } } } as Result<Message>;
  },
  editMessageText: async (_chat, messageId, text, buttons) => {
    calls.push({ method: "edit", text, buttons: buttons?.map((row) => [...row]), messageId });
    return { kind: "ok", value: true };
  },
  answerCallbackQuery: async (_id, text) => {
    calls.push({ method: "answer", text });
    return { kind: "ok", value: true };
  },
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
const message = (chatId: number, fromId: number, text: string): Update => ({
  update_id: updateId++,
  message: { message_id: nextId++, chat: { id: chatId, type: "supergroup" }, from: { id: fromId, is_bot: false, first_name: "C" }, text },
});
const pressOn = (chatId: number, fromId: number, data: string, messageId = 1): Update => ({
  update_id: updateId++,
  callback_query: { id: randomUUID(), from: { id: fromId, is_bot: false }, message: { message_id: messageId, chat: { id: chatId } }, data },
});

async function send(...updates: Update[]): Promise<void> {
  for (const u of updates) await receive(db.pool, "test", u);
  await processInbox(telegram);
}

// A bound group, an order ST-n of 3 shirts and 2 caps, claimed and 3 shirts picked.
async function scene() {
  const q = async (sql: string, params: unknown[]) => (await db.pool.query<{ id: string }>(sql, params)).rows[0]!.id;
  const workspaceId = await q("insert into workspaces (name) values ('Stockroom') returning id", []);
  const coordinatorId = await q("insert into members (workspace_id, display_name, role) values ($1, 'Coordinator', 'COORDINATOR') returning id", [workspaceId]);
  const pickerId = await q("insert into members (workspace_id, display_name, role) values ($1, 'Picker 02', 'PICKER') returning id", [workspaceId]);
  for (const sku of ["TS-BLK-M", "CP-WHT", "CP-GRY"]) {
    await db.pool.query("insert into products (workspace_id, sku, normalized_sku, name, bin) values ($1, $2, $2, $2, 'A-01')", [workspaceId, sku]);
  }
  const code = randomUUID().slice(0, 8).toUpperCase();
  await db.pool.query("insert into telegram_bind_challenges (workspace_id, member_id, code_hash, expires_at) values ($1, $2, $3, now() + interval '5 minutes')", [workspaceId, coordinatorId, hashCode(code)]);
  const chatId = -Math.floor(Math.random() * 1e12);
  const fromId = Math.floor(Math.random() * 1e9);
  await send(message(chatId, fromId, `/stow_bind ${code}`), message(chatId, fromId, "/order\nTS-BLK-M x 3\nCP-WHT x 2"));
  const picker: Actor = { workspaceId, memberId: pickerId, role: "PICKER" };
  const view = await workerView(db.pool, workspaceId, pickerId);
  const orderId = view.order!.id;
  await runCommand(db.pool, picker, randomUUID(), { type: "CLAIM_ORDER", orderId, revision: 1, version: 1, toteId: "A" });
  const task = await workerView(db.pool, workspaceId, pickerId);
  const lineId = task.plan.kind === "TASK" ? task.plan.task.lineId : "";
  await runCommand(db.pool, picker, randomUUID(), { type: "CONFIRM_TASK", orderId, revision: 1, version: 2, kind: "PICK", lineId, quantity: 3 });
  await deliverOutbox(telegram);
  calls = [];
  return { workspaceId, chatId, fromId, picker, orderId, ref: view.order!.ref };
}

const buttonData = (call: Call | undefined, label: string) =>
  call?.buttons?.flat().flatMap((button) => ("data" in button && button.text.startsWith(label) ? [button.data] : []))[0] ?? "";

async function order(orderId: string) {
  const { rows } = await db.pool.query("select revision, is_cancel_requested from orders where id = $1", [orderId]);
  const lines = await db.pool.query("select sku_snapshot as sku, requested_qty as requested from order_lines where order_id = $1 order by creation_index", [orderId]);
  return { ...rows[0], lines: lines.rows };
}

describe("status message", () => {
  test("carries a link that opens the order in the Mini App", async () => {
    const s = await scene();
    await runCommand(db.pool, s.picker, randomUUID(), { type: "PAUSE_ORDER", orderId: s.orderId, revision: 1, version: 3 });
    await deliverOutbox(telegram);
    const edit = calls.find((call) => call.method === "edit");
    expect(edit?.buttons).toEqual([[{ text: "Open in Stow", url: `https://t.me/stow_test_bot?startapp=order_${s.orderId}` }]]);
  });
});

describe("revise in Telegram", () => {
  test("previews the change with the return it causes, and applies it on Confirm", async () => {
    const s = await scene();
    await send(message(s.chatId, s.fromId, `/revise ${s.ref} TS-BLK-M 1`));
    expect(calls[0]).toMatchObject({ method: "send", text: `${s.ref} · revise to rev 2?\nTS-BLK-M: 3 → 1 (3 picked, return 2)` });
    expect((await order(s.orderId)).revision).toBe(1);

    await send(pressOn(s.chatId, s.fromId, buttonData(calls[0], "Confirm")));
    expect(calls.find((call) => call.method === "answer")?.text).toBe("Applied. The picker will see it on the glasses.");
    expect(calls.find((call) => call.method === "edit")?.buttons).toBeUndefined();
    expect(await order(s.orderId)).toMatchObject({ revision: 2, lines: [{ sku: "TS-BLK-M", requested: 1 }, { sku: "CP-WHT", requested: 2 }] });

    calls = [];
    await deliverOutbox(telegram);
    expect(calls[0]?.text.split("\n")[0]).toBe(`${s.ref} · AWAITING PICKER · rev 2`);
  });

  test("a confirm after the order changed is refused", async () => {
    const s = await scene();
    await send(message(s.chatId, s.fromId, `/revise ${s.ref} CP-WHT 4`));
    const confirm = buttonData(calls[0], "Confirm");
    await runCommand(db.pool, s.picker, randomUUID(), { type: "PAUSE_ORDER", orderId: s.orderId, revision: 1, version: 3 });
    calls = [];
    await send(pressOn(s.chatId, s.fromId, confirm));
    expect(calls[0]?.text).toBe("Not applied: the order changed since this preview. Send the command again.");
    expect((await order(s.orderId)).revision).toBe(1);
  });

  test("only the coordinator who asked can confirm, and only once", async () => {
    const s = await scene();
    await send(message(s.chatId, s.fromId, `/revise ${s.ref} CP-WHT 4`));
    const confirm = buttonData(calls[0], "Confirm");
    calls = [];
    await send(pressOn(s.chatId, s.fromId + 1, confirm));
    expect(calls[0]?.text).toBe("Only the coordinator who asked can confirm this.");
    await send(pressOn(s.chatId, s.fromId, confirm), pressOn(s.chatId, s.fromId, confirm));
    expect(calls.filter((call) => call.method === "answer").map((call) => call.text).slice(1)).toEqual(["Applied. The picker will see it on the glasses.", "Already answered."]);
  });

  test("adding a SKU and discarding leaves the order alone", async () => {
    const s = await scene();
    await send(message(s.chatId, s.fromId, `/revise ${s.ref} CP-GRY 2`));
    expect(calls[0]?.text).toBe(`${s.ref} · revise to rev 2?\nCP-GRY: new × 2`);
    await send(pressOn(s.chatId, s.fromId, buttonData(calls[0], "Discard")));
    expect((await order(s.orderId)).lines).toHaveLength(2);
  });
});

describe("cancel in Telegram", () => {
  test("says how many picked units must come back, then cancels on Confirm", async () => {
    const s = await scene();
    await send(message(s.chatId, s.fromId, `/cancel ${s.ref} customer cancelled`));
    expect(calls[0]?.text).toBe(`Cancel ${s.ref}?\nReason: customer cancelled\n3 picked units must be returned first.`);
    await send(pressOn(s.chatId, s.fromId, buttonData(calls[0], "Confirm")));
    expect(await order(s.orderId)).toMatchObject({ is_cancel_requested: true, revision: 2 });
  });
});

describe("shortage in Telegram", () => {
  async function reported() {
    const s = await scene();
    const view = await workerView(db.pool, s.workspaceId, s.picker.memberId);
    await runCommand(db.pool, s.picker, randomUUID(), { type: "REPORT_EXCEPTION", orderId: s.orderId, revision: 1, version: Number(view.order!.version), exceptionType: "SHORTAGE", reportedQty: 1 });
    await deliverOutbox(telegram);
    return s;
  }

  test("asks the coordinator with Resume, Reduce and Cancel buttons", async () => {
    await reported();
    const notice = calls.find((call) => call.text.includes("SHORTAGE"))!;
    expect(notice.text.split("\n").slice(1)).toEqual(["CP-WHT · 0/2 picked · 1 more found", "Reported by Picker 02.", "Awaiting your decision."]);
    expect(notice.buttons?.flat().map((button) => button.text)).toEqual(["Resume", "Reduce to 1", "Cancel order"]);
  });

  test("Reduce lowers the target and the message shows the decision without buttons", async () => {
    const s = await reported();
    const notice = calls.find((call) => call.text.includes("SHORTAGE"))!;
    calls = [];
    await send(pressOn(s.chatId, s.fromId, buttonData(notice, "Reduce")));
    expect(calls[0]?.text).toBe("Applied. The picker will see it on the glasses.");
    expect((await order(s.orderId)).lines[1]).toEqual({ sku: "CP-WHT", requested: 1 });

    calls = [];
    await deliverOutbox(telegram);
    const edited = calls.find((call) => call.text.includes("SHORTAGE"))!;
    expect(edited).toMatchObject({ method: "edit" });
    expect(edited.text.split("\n").at(-1)).toBe("Decision: reduce to 1");
    expect(edited.buttons).toBeUndefined();
  });

  test("a second press after the decision does nothing", async () => {
    const s = await reported();
    const resume = buttonData(calls.find((call) => call.text.includes("SHORTAGE")), "Resume");
    await send(pressOn(s.chatId, s.fromId, resume));
    calls = [];
    await send(pressOn(s.chatId, s.fromId, resume));
    expect(calls).toEqual([{ method: "answer", text: "Already decided." }]);
  });
});
