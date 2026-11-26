// A team gets going without anyone touching the database: an owner creates
// a workspace in a private chat, connects the group, and invites people.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { BotApi, Message, Result, Update } from "@stow/telegram/botapi";
import { createTestDatabase, type TestDatabase } from "./db/testdb.ts";
import { disconnectGroup, listGroups } from "./connections.ts";
import { processInbox, receive, type Telegram } from "./telegram.ts";

let replies: string[];
let nextId = 1;
const api: BotApi = {
  getMe: async () => ({ kind: "ok", value: { id: 1, username: "stow_test_bot" } }),
  getUpdates: async () => ({ kind: "ok", value: [] }),
  sendMessage: async (_chat, text) => {
    replies.push(text);
    return { kind: "ok", value: { message_id: nextId++, chat: { id: 0, type: "private" } } } as Result<Message>;
  },
  editMessageText: async () => ({ kind: "ok", value: true }),
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
  replies = [];
});

let updateId = 1;
function say(from: number, name: string, text: string, chat: { id: number; type: string; title?: string } = { id: from, type: "private" }): Update {
  return { update_id: updateId++, message: { message_id: nextId++, chat, from: { id: from, is_bot: false, first_name: name }, text } };
}

async function send(update: Update): Promise<string> {
  await receive(db.pool, "test", update);
  await processInbox(telegram);
  return replies.at(-1) ?? "";
}

const people = (name: string) =>
  db.pool.query("select m.display_name, m.role, m.telegram_user_id from members m join workspaces w on w.id = m.workspace_id where w.name = $1 order by m.role", [name]);

describe("onboarding through the bot", () => {
  test("setup, connect a group, invite a picker who joins with the link", async () => {
    const owner = 5001;
    expect(await send(say(owner, "Tolu", "/start"))).toMatch(/^Welcome to Stow/);
    expect(await send(say(owner, "Tolu", "/setup Lagos stockroom"))).toMatch(/^Created Lagos stockroom/);
    expect((await people("Lagos stockroom")).rows).toEqual([{ display_name: "Tolu", role: "OWNER", telegram_user_id: "5001" }]);

    const group = { id: -100777, type: "supergroup" };
    expect(await send(say(owner, "Tolu", "/stow_connect", group))).toBe("Connected to Lagos stockroom. Orders sent here with /order now go to Stow.");

    const link = (await send(say(owner, "Tolu", "/invite picker"))).match(/start=(inv_[A-Za-z0-9_-]{32})/)?.[1];
    expect(link).toBeDefined();
    expect(await send(say(6002, "Ada", `/start ${link}`))).toBe(
      "Welcome to Lagos stockroom as picker. Open Stow on your Even G2 and enter the code it shows in the Stow app here.",
    );
    expect((await people("Lagos stockroom")).rows).toContainEqual({ display_name: "Ada", role: "PICKER", telegram_user_id: "6002" });

    expect(await send(say(6003, "Eve", `/start ${link}`))).toBe("This invite link is not valid. Ask for a new one.");
    expect(await send(say(6002, "Ada", "/start"))).toBe("You are in one workspace:\nLagos stockroom (picker)");
  });

  test("setup and invites only work in a private chat, connect only in a group", async () => {
    const group = { id: -100888, type: "supergroup" };
    expect(await send(say(5100, "Sam", "/setup Shop", group))).toBe("Send /setup in a private chat with me, not in a group.");
    expect(await send(say(5100, "Sam", "/stow_connect"))).toBe("Send /stow_connect in your work group.");
    await send(say(5100, "Sam", "/setup Shop"));
    expect(await send(say(5100, "Sam", "/invite picker", group))).toMatch(/^Send \/invite in a private chat/);
  });

  test("only owners can connect groups or invite, and one owner owns one workspace", async () => {
    expect(await send(say(5200, "Kim", "/stow_connect", { id: -100999, type: "group" }))).toMatch(/^Only a workspace owner/);
    expect(await send(say(5200, "Kim", "/invite picker"))).toBe("Only a workspace owner can invite people.");
    await send(say(5200, "Kim", "/setup First"));
    expect(await send(say(5200, "Kim", "/setup Second"))).toBe("You already own a workspace. Send /start to see it.");
  });

  test("an expired invite is refused", async () => {
    await send(say(5300, "Lee", "/setup Expiring"));
    const link = (await send(say(5300, "Lee", "/invite coordinator"))).match(/start=(inv_[A-Za-z0-9_-]{32})/)![1];
    await db.pool.query("update member_invites set expires_at = now() - interval '1 second'");
    expect(await send(say(6300, "Max", `/start ${link}`))).toBe("This invite link has expired. Ask for a new one.");
  });
});

describe("the Telegram page", () => {
  test("lists a group by name, and after a disconnect the group is ignored until it reconnects", async () => {
    await send(say(5400, "Ife", "/setup Ikeja stockroom"));
    const group = { id: -100555, type: "supergroup", title: "Ikeja dispatch" };
    await send(say(5400, "Ife", "/stow_connect", group));
    const owner = (await db.pool.query<{ workspace_id: string; id: string }>("select workspace_id, id from members where telegram_user_id = '5400'")).rows[0]!;
    const actor = { workspaceId: owner.workspace_id, memberId: owner.id, role: "OWNER" as const };
    const listed = await listGroups(db.pool, actor.workspaceId);
    expect(listed).toMatchObject({ groups: [{ title: "Ikeja dispatch", connectedBy: "Ife", openOrders: 0 }], delivery: { undelivered: 0 } });

    expect(await disconnectGroup(db.pool, { ...actor, role: "COORDINATOR" }, listed.groups[0]!.id)).toEqual({ ok: false, code: "ROLE_REQUIRED" });
    expect(await disconnectGroup(db.pool, actor, listed.groups[0]!.id)).toEqual({ ok: true });
    expect(await disconnectGroup(db.pool, actor, listed.groups[0]!.id)).toEqual({ ok: false, code: "NOT_FOUND" });
    expect((await listGroups(db.pool, actor.workspaceId)).groups).toEqual([]);

    replies = [];
    await send(say(5400, "Ife", "/order\nX x 1", group));
    expect(replies).toEqual([]);
    expect(await send(say(5400, "Ife", "/stow_connect", group))).toBe("Connected to Ikeja stockroom. Orders sent here with /order now go to Stow.");
  });
});
