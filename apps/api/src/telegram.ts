// The Telegram side of the loop, in three steps that each survive a crash:
//
//   receive       store every update in telegram_inbox before acting on it,
//                 deduplicated by update_id (Telegram delivers at least once);
//   processInbox  turn stored commands into orders, binding or replies;
//   deliverOutbox send or edit each order's status message from the outbox
//                 rows that fulfilment wrote in the same transaction as the change.
//
// Only explicit commands are read. Plain chat, messages from bots, anonymous
// admins posting as the group, and forwards are ignored before parsing.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import type { BotApi, Button, CallbackQuery, Message, Result, Update } from "@stow/telegram/botapi";
import { parseCommand, parseOrder, parseRefAndText, parseRevise, type Command as BotCommand, type OrderError } from "@stow/telegram/commands";
import { reducedTarget, renderException, renderReply, renderStatus, type ExceptionNotice } from "@stow/telegram/status";
import { postNote } from "./messages.ts";
import { createOrder, loadOrder, runCommand, transaction, type Command, type CommandResult, type RevisionChange, type Role } from "./fulfilment.ts";

export type Telegram = { readonly pool: pg.Pool; readonly api: BotApi; readonly botAlias: string; readonly botUsername: string };

/** StoredMessage is the minimum kept from a command message; other updates keep nothing. */
type StoredMessage = { kind?: "message"; chatId: string; chatType: string; fromId: string; fromName: string; messageId: number; text: string };

/** StoredNote is a coordinator's reply to one of Stow's status messages. */
type StoredNote = { kind: "note"; chatId: string; fromId: string; replyTo: number; text: string };

/** StoredPress is the minimum kept from a button press under one of the bot's messages. */
type StoredPress = { kind: "press"; callbackId: string; chatId: string; fromId: string; messageId: number; data: string };

const preview_s = 120;

const batchSize = 10;
const lease_s = 30;
const maxAttempts = 8;
const backoff_s = [1, 2, 5, 10, 30, 60, 120, 300];

/** receive stores an update once. Updates that are not commands are kept only as a dedupe marker. */
export async function receive(pool: pg.Pool, botAlias: string, update: Update): Promise<void> {
  const message = commandMessage(update.message) ?? buttonPress(update.callback_query) ?? (await replyToStatus(pool, update.message));
  await pool.query(
    `insert into telegram_inbox (bot_alias, update_id, status, payload) values ($1, $2, $3, $4)
     on conflict (bot_alias, update_id) do nothing`,
    [botAlias, String(update.update_id), message ? "PENDING" : "IGNORED", message ?? {}],
  );
}

function commandMessage(message: Message | undefined): StoredMessage | null {
  if (!message?.text?.startsWith("/") || !message.from || message.from.is_bot) return null;
  // An anonymous admin or a forward does not identify the person acting.
  if (message.sender_chat || message.forward_origin) return null;
  return {
    chatId: String(message.chat.id),
    chatType: message.chat.type,
    fromId: String(message.from.id),
    fromName: message.from.first_name.slice(0, 80) || "Member",
    messageId: message.message_id,
    text: message.text,
  };
}

// A plain-text reply is kept only when it answers one of Stow's own status
// messages in a bound chat; every other message is ignored unread.
async function replyToStatus(pool: pg.Pool, message: Message | undefined): Promise<StoredNote | null> {
  const replyTo = message?.reply_to_message?.message_id;
  if (!message?.text || !replyTo || !message.from || message.from.is_bot || message.sender_chat || message.forward_origin) return null;
  const { rowCount } = await pool.query(
    `select 1 from telegram_message_refs r join telegram_connections c on c.id = r.connection_id and c.status = 'ACTIVE'
     where c.chat_id = $1 and r.message_id = $2 and r.purpose = 'STATUS'`,
    [String(message.chat.id), String(replyTo)],
  );
  if (!rowCount) return null;
  return { kind: "note", chatId: String(message.chat.id), fromId: String(message.from.id), replyTo, text: message.text.slice(0, 280) };
}

function buttonPress(press: CallbackQuery | undefined): StoredPress | null {
  if (!press?.data || !press.message || press.from.is_bot) return null;
  return { kind: "press", callbackId: press.id, chatId: String(press.message.chat.id), fromId: String(press.from.id), messageId: press.message.message_id, data: press.data };
}

/** processInbox handles up to one batch of pending commands and returns how many it took. */
export async function processInbox(telegram: Telegram): Promise<number> {
  const { rows } = await telegram.pool.query<{ id: string; update_id: string; payload: StoredMessage | StoredPress | StoredNote; attempts: number }>(
    `update telegram_inbox set attempts = attempts + 1, next_attempt_at = now() + interval '${lease_s} seconds'
     where id in (select id from telegram_inbox where status = 'PENDING' and next_attempt_at <= now()
                  order by update_id::numeric limit ${batchSize} for update skip locked)
     returning id, update_id, payload, attempts`,
  );
  // RETURNING does not keep the subquery's order, and order matters: a
  // /stow_bind must be handled before the /order sent right after it.
  rows.sort((a, b) => Number(a.update_id) - Number(b.update_id));
  for (const row of rows) {
    try {
      await handle(telegram, row.payload);
    } catch (error) {
      // Leave it for another attempt after the lease, up to a limit.
      if (row.attempts >= 5) {
        await telegram.pool.query("update telegram_inbox set status = 'FAILED', error_code = 'handler_error', payload = '{}' where id = $1", [row.id]);
      }
      throw new Error(`telegram update ${row.id}: ${(error as Error).message}`, { cause: error });
    }
    // The payload is no longer needed once handled; keep only the dedupe key.
    await telegram.pool.query("update telegram_inbox set status = 'DONE', payload = '{}' where id = $1", [row.id]);
  }
  return rows.length;
}

async function handle(telegram: Telegram, message: StoredMessage | StoredPress | StoredNote): Promise<void> {
  if (message.kind === "press") return press(telegram, message);
  if (message.kind === "note") return noteFromReply(telegram, message);
  const command = parseCommand(message.text, telegram.botUsername);
  if (!command) return;
  const reply = (text: string) => telegram.api.sendMessage(message.chatId, text, message.messageId);
  switch (command.name) {
    case "start":
      await reply(await welcome(telegram, message, command.args));
      return;
    case "help":
      await reply(helpText);
      return;
    case "setup":
      await reply(await setup(telegram.pool, message, command.args));
      return;
    case "stow_connect":
      await reply(await connect(telegram.pool, message));
      return;
    case "invite":
      await reply(await invite(telegram, message, command.args));
      return;
    case "stow_bind":
      await reply(await bind(telegram.pool, message, command.args));
      return;
    case "order": {
      const answer = await intake(telegram, message, command);
      if (answer) await reply(answer);
      return;
    }
    case "note": {
      const answer = await noteCommand(telegram, message, command.args);
      if (answer) await reply(answer);
      return;
    }
    case "revise":
    case "cancel":
    case "resolve":
      await preview(telegram, message, command);
      return;
  }
}

const helpText = [
  "Stow turns orders in this group into picking instructions on Even G2.",
  "",
  "Owners, in a private chat with the bot: /setup NAME creates your workspace, /invite picker or /invite coordinator makes a join link.",
  "In your work group: /stow_connect connects it to your workspace.",
  "",
  "/order [REF] then one line per item:",
  "SKU x QTY",
  "",
  "/revise REF SKU QTY sets a new target (0 removes it).",
  "/cancel REF reason cancels an order.",
  "/resolve REF SKU QTY substitutes a SKU for the reported item.",
  "/note REF text, or a reply to an order's status message, shows a note on the picker's glasses.",
  "Every change is previewed first and applied only when you confirm.",
  "",
  "Stow only reads commands sent to it. It does not read other messages.",
].join("\n");

const isPrivate = (message: StoredMessage) => message.chatType === "private";
const inviteHash = (token: string) => createHash("sha256").update(token).digest("hex");

// /start in a private chat: either an invite link being opened, or a person
// finding the bot for the first time.
async function welcome(telegram: Telegram, message: StoredMessage, payload: string): Promise<string> {
  if (!isPrivate(message)) return helpText;
  const invite = /^inv_([A-Za-z0-9_-]{32})$/.exec(payload)?.[1];
  if (invite) return join(telegram.pool, message, invite);
  const { rows } = await telegram.pool.query<{ name: string; role: string }>(
    "select w.name, m.role from members m join workspaces w on w.id = m.workspace_id where m.telegram_user_id = $1 order by w.name",
    [message.fromId],
  );
  if (rows.length === 0) return "Welcome to Stow. To start a workspace for your team, send:\n/setup Your stockroom name\n\nIf someone invited you, open the link they sent.";
  return [`You are in ${rows.length === 1 ? "one workspace" : `${rows.length} workspaces`}:`, ...rows.map((row) => `${row.name} (${row.role.toLowerCase()})`)].join("\n");
}

// /setup NAME in a private chat creates a workspace with the sender as owner.
async function setup(pool: pg.Pool, message: StoredMessage, name: string): Promise<string> {
  if (!isPrivate(message)) return "Send /setup in a private chat with me, not in a group.";
  const trimmed = name.trim().slice(0, 80);
  if (!trimmed) return "Give the workspace a name, for example:\n/setup Lagos stockroom";
  const owned = await pool.query("select 1 from members where telegram_user_id = $1 and role = 'OWNER' limit 1", [message.fromId]);
  if (owned.rowCount) return "You already own a workspace. Send /start to see it.";
  await transaction(pool, async (client) => {
    const workspace = await client.query<{ id: string }>("insert into workspaces (name) values ($1) returning id", [trimmed]);
    await client.query("insert into members (workspace_id, display_name, role, telegram_user_id) values ($1, $2, 'OWNER', $3)", [
      workspace.rows[0]!.id,
      message.fromName,
      message.fromId,
    ]);
  });
  return `Created ${trimmed}. Next:\n1. Add me to your work group and send /stow_connect there.\n2. Send /invite picker here for each picker.`;
}

// /stow_connect in a group, by the owner of exactly one workspace. Telegram
// has already proven who sent it, so no code is needed.
async function connect(pool: pg.Pool, message: StoredMessage): Promise<string> {
  if (message.chatType !== "group" && message.chatType !== "supergroup") return "Send /stow_connect in your work group.";
  const owned = await pool.query<{ workspace_id: string; id: string; name: string }>(
    "select m.workspace_id, m.id, w.name from members m join workspaces w on w.id = m.workspace_id where m.telegram_user_id = $1 and m.role = 'OWNER'",
    [message.fromId],
  );
  const workspace = owned.rows[0];
  if (!workspace) return "Only a workspace owner can connect a group. Send /setup to me in a private chat first.";
  const bound = await pool.query("select 1 from telegram_connections where chat_id = $1 and status = 'ACTIVE'", [message.chatId]);
  if (bound.rowCount) return "This group is already connected to Stow.";
  await pool.query("insert into telegram_connections (workspace_id, chat_id, status, bound_by) values ($1, $2, 'ACTIVE', $3)", [
    workspace.workspace_id,
    message.chatId,
    workspace.id,
  ]);
  return `Connected to ${workspace.name}. Orders sent here with /order now go to Stow.`;
}

// /invite picker|coordinator in a private chat, by an owner: a one-time
// link that opens this bot and adds whoever opens it.
async function invite(telegram: Telegram, message: StoredMessage, args: string): Promise<string> {
  if (!isPrivate(message)) return "Send /invite in a private chat with me, so the link is not shared with the group.";
  const role = args.trim().toUpperCase();
  if (role !== "PICKER" && role !== "COORDINATOR") return "Use /invite picker or /invite coordinator.";
  const owner = await telegram.pool.query<{ workspace_id: string; id: string }>(
    "select workspace_id, id from members where telegram_user_id = $1 and role = 'OWNER' limit 1",
    [message.fromId],
  );
  if (!owner.rows[0]) return "Only a workspace owner can invite people.";
  const token = randomBytes(24).toString("base64url");
  await telegram.pool.query(
    "insert into member_invites (workspace_id, token_hash, role, created_by, expires_at) values ($1, $2, $3, $4, now() + interval '24 hours')",
    [owner.rows[0].workspace_id, inviteHash(token), role, owner.rows[0].id],
  );
  return `Send this link to your ${role.toLowerCase()}. It works once, for 24 hours:\nhttps://t.me/${telegram.botUsername}?start=inv_${token}`;
}

async function join(pool: pg.Pool, message: StoredMessage, token: string): Promise<string> {
  return transaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string; workspace_id: string; role: string; name: string; expired: boolean; consumed: boolean }>(
      `select i.id, i.workspace_id, i.role, w.name, i.expires_at < now() as expired, i.consumed_at is not null as consumed
       from member_invites i join workspaces w on w.id = i.workspace_id where i.token_hash = $1 for update of i`,
      [inviteHash(token)],
    );
    const found = rows[0];
    if (!found || found.consumed) return "This invite link is not valid. Ask for a new one.";
    if (found.expired) return "This invite link has expired. Ask for a new one.";
    const already = await client.query("select 1 from members where workspace_id = $1 and telegram_user_id = $2", [found.workspace_id, message.fromId]);
    if (already.rowCount) return `You are already in ${found.name}.`;
    await client.query("update member_invites set consumed_at = now() where id = $1", [found.id]);
    await client.query("insert into members (workspace_id, display_name, role, telegram_user_id) values ($1, $2, $3, $4)", [
      found.workspace_id,
      message.fromName,
      found.role,
      message.fromId,
    ]);
    const next = found.role === "PICKER" ? "Open Stow on your Even G2 and enter the code it shows in the Stow app here." : "You can now send orders in the work group.";
    return `Welcome to ${found.name} as ${found.role.toLowerCase()}. ${next}`;
  });
}

/** hashCode is how bind codes are stored and looked up. */
export function hashCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

// Binding links this group to the code's workspace and links the sender's
// Telegram account to the member who created the code.
async function bind(pool: pg.Pool, message: StoredMessage, code: string): Promise<string> {
  if (message.chatType !== "group" && message.chatType !== "supergroup") return "Send /stow_bind in the work group you want Stow to use.";
  return transaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string; workspace_id: string; member_id: string }>(
      `select id, workspace_id, member_id from telegram_bind_challenges
       where code_hash = $1 and consumed_at is null and expires_at > now() for update`,
      [hashCode(code)],
    );
    const challenge = rows[0];
    if (!challenge) return "That code is not valid. Create a new one and try again.";
    const active = await client.query("select 1 from telegram_connections where chat_id = $1 and status = 'ACTIVE'", [message.chatId]);
    if (active.rowCount) return "This group is already connected to Stow.";
    await client.query("update telegram_bind_challenges set consumed_at = now() where id = $1", [challenge.id]);
    await client.query("update members set telegram_user_id = $3 where workspace_id = $1 and id = $2", [
      challenge.workspace_id,
      challenge.member_id,
      message.fromId,
    ]);
    await client.query(
      "insert into telegram_connections (workspace_id, chat_id, status, bound_by) values ($1, $2, 'ACTIVE', $3)",
      [challenge.workspace_id, message.chatId, challenge.member_id],
    );
    return "Connected. Orders sent here with /order now go to Stow.";
  });
}

async function intake(telegram: Telegram, message: StoredMessage, command: NonNullable<ReturnType<typeof parseCommand>>): Promise<string | null> {
  const { rows } = await telegram.pool.query<{ workspace_id: string; connection_id: string; member_id: string | null; role: string | null }>(
    `select c.workspace_id, c.id as connection_id, m.id as member_id, m.role
     from telegram_connections c
     left join members m on m.workspace_id = c.workspace_id and m.telegram_user_id = $2
     where c.chat_id = $1 and c.status = 'ACTIVE'`,
    [message.chatId, message.fromId],
  );
  const access = rows[0];
  if (!access) return null;
  if (!access.member_id || (access.role !== "OWNER" && access.role !== "COORDINATOR")) {
    return "Only linked coordinators can send orders to Stow.";
  }
  const parsed = parseOrder(command);
  if (!parsed.ok) return `Order not created:\n${parsed.errors.map(describe).join("\n")}`;
  const created = await createOrder(telegram.pool, {
    workspaceId: access.workspace_id,
    createdBy: access.member_id,
    sourceKey: `telegram:${telegram.botAlias}:${message.chatId}:${message.messageId}`,
    connectionId: access.connection_id,
    sourceMessageId: String(message.messageId),
    request: parsed.order,
  });
  if (created.ok) return null; // The status message from the outbox is the confirmation.
  if ("unknownSkus" in created) return `Order not created. Unknown SKU: ${created.unknownSkus.join(", ")}`;
  return "Order not created: that reference is already used.";
}

function describe(error: OrderError): string {
  const where = error.line ? `line ${error.line}: ` : "";
  const what: Record<OrderError["code"], string> = {
    INVALID_REF: "the reference may use letters, digits, - and _ (up to 40)",
    NO_LINES: "add one line per item, like SKU-1 x 2",
    TOO_MANY_LINES: "at most 100 lines per order",
    BAD_LINE: "write it as SKU x QTY with a whole number",
    QUANTITY_OUT_OF_RANGE: "quantity must be 1 to 10,000",
    DUPLICATE_SKU: "this SKU is already in the order; send one line per SKU",
    ORDER_TOO_LARGE: "at most 20,000 units per order",
  };
  return `${where}${what[error.code]}`;
}

type ChatMember = { workspaceId: string; connectionId: string; memberId: string; role: Role };

// The Stow member behind a Telegram sender in a bound chat, if any.
async function chatMember(pool: pg.Pool, chatId: string, fromId: string): Promise<ChatMember | null> {
  const { rows } = await pool.query<{ workspace_id: string; connection_id: string; member_id: string; role: Role }>(
    `select c.workspace_id, c.id as connection_id, m.id as member_id, m.role
     from telegram_connections c join members m on m.workspace_id = c.workspace_id and m.telegram_user_id = $2
     where c.chat_id = $1 and c.status = 'ACTIVE'`,
    [chatId, fromId],
  );
  const row = rows[0];
  return row ? { workspaceId: row.workspace_id, connectionId: row.connection_id, memberId: row.member_id, role: row.role } : null;
}

const isCoordinator = (member: ChatMember | null): member is ChatMember => member?.role === "OWNER" || member?.role === "COORDINATOR";

/**
 * preview answers /revise, /cancel and /resolve with exactly what would
 * change and Confirm / Discard buttons. The command is stored with the order
 * version it was previewed against, so confirming after the order moved is
 * refused rather than applied to a state the coordinator never saw.
 */
async function preview(telegram: Telegram, message: StoredMessage, command: BotCommand): Promise<void> {
  const reply = (text: string, buttons?: Button[][]) => telegram.api.sendMessage(message.chatId, text, message.messageId, buttons);
  const member = await chatMember(telegram.pool, message.chatId, message.fromId);
  if (!isCoordinator(member)) {
    if (member || (await isBound(telegram.pool, message.chatId))) await reply("Only linked coordinators can change orders.");
    return;
  }
  const ref = command.name === "revise" ? parseRevise(command) : parseRefAndText(command.args);
  if (!ref || ("ok" in ref && !ref.ok)) {
    await reply(usage[command.name as keyof typeof usage]);
    return;
  }
  const orderRef = "ok" in ref ? ref.ref : ref.ref;
  const order = await orderByRef(telegram.pool, member.workspaceId, orderRef);
  if (!order) {
    await reply(`No order ${orderRef} in this workspace.`);
    return;
  }
  const expected = { orderId: order.id, revision: order.revision, version: order.version };
  let planned: { command: Command; text: string } | string;
  if (command.name === "revise" && "ok" in ref && ref.ok) planned = planRevision(order, expected, ref.lines);
  else if (command.name === "cancel" && !("ok" in ref)) planned = planCancel(order, expected, ref.text);
  else planned = planSubstitute(order, expected, "ok" in ref ? "" : ref.text);
  if (typeof planned === "string") {
    await reply(planned);
    return;
  }
  const token = randomBytes(12).toString("base64url");
  await telegram.pool.query(
    `insert into telegram_actions (workspace_id, token, member_id, chat_id, command, summary, expires_at)
     values ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))`,
    [member.workspaceId, token, member.memberId, message.chatId, planned.command, planned.text, preview_s],
  );
  await reply(planned.text, [[{ text: "Confirm", data: `a:${token}` }, { text: "Discard", data: `d:${token}` }]]);
}

// A reply to an order's status message becomes a note on the picker's
// glasses. Only coordinators' replies count; the status message then says
// whether the note was read, so no extra chat message is needed.
async function noteFromReply(telegram: Telegram, note: StoredNote): Promise<void> {
  const member = await chatMember(telegram.pool, note.chatId, note.fromId);
  if (!isCoordinator(member)) return;
  const { rows } = await telegram.pool.query<{ order_id: string }>(
    "select order_id from telegram_message_refs where connection_id = $1 and message_id = $2 and purpose = 'STATUS'",
    [member.connectionId, String(note.replyTo)],
  );
  if (rows[0]) await postNote(telegram.pool, member.workspaceId, rows[0].order_id, member.memberId, note.text);
}

async function noteCommand(telegram: Telegram, message: StoredMessage, args: string): Promise<string | null> {
  const member = await chatMember(telegram.pool, message.chatId, message.fromId);
  if (!isCoordinator(member)) return member || (await isBound(telegram.pool, message.chatId)) ? "Only linked coordinators can send notes." : null;
  const parsed = parseRefAndText(args);
  if (!parsed?.text) return "Use /note REF text, or reply to the order's status message.";
  const { rows } = await telegram.pool.query<{ id: string }>("select id from orders where workspace_id = $1 and ref = $2", [member.workspaceId, parsed.ref]);
  if (!rows[0]) return `No order ${parsed.ref} in this workspace.`;
  const posted = await postNote(telegram.pool, member.workspaceId, rows[0].id, member.memberId, parsed.text);
  return posted === "CLOSED" ? `${parsed.ref} is closed; notes go to open orders only.` : null;
}

const usage = {
  revise: "Use /revise REF SKU QTY, or /revise REF followed by one SKU x QTY line per item.",
  cancel: "Use /cancel REF reason.",
  resolve: "Use /resolve REF SKU QTY to substitute a SKU for the reported item.",
};

async function isBound(pool: pg.Pool, chatId: string): Promise<boolean> {
  const { rowCount } = await pool.query("select 1 from telegram_connections where chat_id = $1 and status = 'ACTIVE'", [chatId]);
  return (rowCount ?? 0) > 0;
}

async function orderByRef(pool: pg.Pool, workspaceId: string, ref: string) {
  const { rows } = await pool.query<{ id: string }>("select id from orders where workspace_id = $1 and ref = $2", [workspaceId, ref]);
  if (!rows[0]) return null;
  return transaction(pool, (client) => loadOrder(client, workspaceId, rows[0]!.id, "read"));
}

type LoadedOrder = NonNullable<Awaited<ReturnType<typeof orderByRef>>>;
type ExpectedState = { orderId: string; revision: number; version: number };

function planRevision(order: LoadedOrder, expected: ExpectedState, lines: { sku: string; quantity: number }[]): { command: Command; text: string } | string {
  if (order.terminal) return `${order.ref} is ${order.terminal.toLowerCase()} and cannot change.`;
  const changes: RevisionChange[] = [];
  const shown: string[] = [];
  for (const { sku, quantity } of lines) {
    const line = order.lines.find((candidate) => candidate.sku === sku);
    if (line) {
      changes.push({ kind: "SET_QUANTITY", lineId: line.id, quantity });
      const excess = line.picked - quantity;
      shown.push(`${sku}: ${line.requested} → ${quantity}${excess > 0 ? ` (${line.picked} picked, return ${excess})` : ""}`);
    } else {
      if (quantity === 0) return `${sku} is not in ${order.ref}; nothing to remove.`;
      changes.push({ kind: "ADD_LINE", sku, quantity });
      shown.push(`${sku}: new × ${quantity}`);
    }
  }
  return {
    command: { type: "REVISE_ORDER", ...expected, reason: "Revised in Telegram", changes },
    text: [`${order.ref} · revise to rev ${order.revision + 1}?`, ...shown].join("\n"),
  };
}

function planCancel(order: LoadedOrder, expected: ExpectedState, reason: string): { command: Command; text: string } | string {
  if (order.terminal) return `${order.ref} is already ${order.terminal.toLowerCase()}.`;
  const inTote = order.lines.reduce((sum, line) => sum + line.picked, 0);
  const returns = inTote > 0 ? `${inTote} picked units must be returned first.` : "Nothing has been picked.";
  return {
    command: { type: "REQUEST_CANCEL", ...expected, reason: reason || "Cancelled in Telegram" },
    text: [`Cancel ${order.ref}?`, reason ? `Reason: ${reason}` : "", returns].filter(Boolean).join("\n"),
  };
}

function planSubstitute(order: LoadedOrder, expected: ExpectedState, args: string): { command: Command; text: string } | string {
  const exception = order.exception;
  if (exception?.status !== "OPEN" || !exception.lineId) return `${order.ref} has no open problem to resolve.`;
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s+([0-9]{1,5})$/.exec(args.trim());
  if (!match) return usage.resolve;
  const line = order.lines.find((candidate) => candidate.id === exception.lineId)!;
  const sku = match[1]!.toUpperCase();
  const quantity = Number(match[2]);
  return {
    command: {
      type: "RESOLVE_EXCEPTION",
      ...expected,
      reason: `Substitute ${sku}`,
      resolution: { kind: "SUBSTITUTE", quantity: line.picked, sku, substituteQuantity: quantity },
    },
    text: [`${order.ref} · substitute?`, `${line.sku}: ${line.requested} → ${line.picked} (keep what is picked)`, `${sku}: new × ${quantity}`].join("\n"),
  };
}

// A button press: confirm or discard a preview, or answer an exception.
async function press(telegram: Telegram, pressed: StoredPress): Promise<void> {
  const answer = (text: string) => telegram.api.answerCallbackQuery(pressed.callbackId, text);
  const [kind, value = "", option = ""] = pressed.data.split(":");
  if (kind === "a" || kind === "d") {
    const action = await takeAction(telegram.pool, value, pressed);
    if (typeof action === "string") {
      await answer(action);
      return;
    }
    // The edit drops the buttons, so the preview cannot be answered twice.
    if (kind === "d") {
      await answer("Discarded.");
      await telegram.api.editMessageText(pressed.chatId, String(pressed.messageId), `${action.summary}\n\nDiscarded.`);
      return;
    }
    const result = await runCommand(telegram.pool, action.actor, action.id, action.command);
    const outcome = describeResult(result);
    await answer(outcome);
    await telegram.api.editMessageText(pressed.chatId, String(pressed.messageId), `${action.summary}\n\n${outcome}`);
    return;
  }
  if (kind === "x") return decide(telegram, pressed, value, option, answer);
  await answer("This button is no longer valid.");
}

type Action = { id: string; actor: { workspaceId: string; memberId: string; role: Role }; command: Command; summary: string };

// Claims a preview for this press: same chat, same person who asked, not
// expired, not answered. The action's ID becomes the command ID, so a
// redelivered press cannot apply the change twice.
async function takeAction(pool: pg.Pool, token: string, pressed: StoredPress): Promise<Action | string> {
  return transaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string; workspace_id: string; member_id: string; chat_id: string; command: Command; summary: string; expired: boolean; consumed: boolean; telegram_user_id: string | null; role: Role }>(
      `select a.id, a.workspace_id, a.member_id, a.chat_id, a.command, a.summary, a.expires_at < now() as expired, a.consumed_at is not null as consumed,
              m.telegram_user_id, m.role
       from telegram_actions a join members m on m.workspace_id = a.workspace_id and m.id = a.member_id
       where a.token = $1 for update of a`,
      [token],
    );
    const action = rows[0];
    if (!action || action.chat_id !== pressed.chatId) return "This preview is not valid here.";
    if (action.telegram_user_id !== pressed.fromId) return "Only the coordinator who asked can confirm this.";
    if (action.consumed) return "Already answered.";
    if (action.expired) return "This preview expired. Send the command again.";
    await client.query("update telegram_actions set consumed_at = now() where id = $1", [action.id]);
    return { id: action.id, actor: { workspaceId: action.workspace_id, memberId: action.member_id, role: action.role }, command: action.command, summary: action.summary };
  });
}

function describeResult(result: CommandResult): string {
  if (result.status === 200) return result.body.outcome === "NO_CHANGE" ? "Nothing changed." : "Applied. The picker will see it on the glasses.";
  if (result.status === 409 && (result.body.code === "STALE_VERSION" || result.body.code === "REVISION_REQUIRED")) {
    return "Not applied: the order changed since this preview. Send the command again.";
  }
  if (result.status === 400) return "skus" in result.body ? `Not applied: unknown SKU ${result.body.skus.join(", ")}.` : "Not applied: that member is not a picker.";
  if (result.status === 403) return "Not applied: your role cannot do this.";
  if (result.status === 404) return "Not applied: order not found.";
  return `Not applied: ${result.body.code.toLowerCase().replace(/_/g, " ")}.`;
}

// Resume / Reduce / Cancel under an exception message. The press itself is
// the coordinator's explicit decision on that exact exception; the engine
// refuses it if the exception is no longer open.
async function decide(telegram: Telegram, pressed: StoredPress, compactId: string, option: string, answer: (text: string) => Promise<unknown>): Promise<void> {
  const member = await chatMember(telegram.pool, pressed.chatId, pressed.fromId);
  if (!isCoordinator(member)) {
    await answer("Only linked coordinators can decide.");
    return;
  }
  const exceptionId = expandId(compactId);
  const { rows } = await telegram.pool.query<{ order_id: string }>(
    "select order_id from order_exceptions where workspace_id = $1 and id = $2 and status = 'OPEN'",
    [member.workspaceId, exceptionId],
  );
  if (!rows[0]) {
    await answer("Already decided.");
    return;
  }
  const order = await transaction(telegram.pool, (client) => loadOrder(client, member.workspaceId, rows[0]!.order_id, "read"));
  if (!order?.exception?.lineId) return;
  const line = order.lines.find((candidate) => candidate.id === order.exception!.lineId)!;
  const resolution =
    option === "R" ? ({ kind: "RESUME" } as const)
    : option === "D" ? ({ kind: "REDUCE", quantity: reducedTarget({ picked: line.picked, reportedQty: order.exception.reportedQty, requested: line.requested }) } as const)
    : ({ kind: "CANCEL" } as const);
  const result = await runCommand(telegram.pool, member, randomUUID(), {
    type: "RESOLVE_EXCEPTION",
    orderId: order.id,
    revision: order.revision,
    version: order.version,
    reason: "Decided in Telegram",
    resolution,
  });
  await answer(describeResult(result));
}

// UUIDs travel in button data without dashes to stay under 64 bytes.
const compactId = (id: string) => id.replace(/-/g, "");
const expandId = (hex: string) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;

type DueRow = {
  id: string;
  workspace_id: string;
  order_id: string;
  chat_id: string;
  connection_id: string;
  attempts: number;
  kind: "STATUS" | "EXCEPTION" | "REPLY";
  payload: { exceptionId?: string; messageId?: string; force?: boolean };
  created_at: Date;
};

/** deliverOutbox sends or edits status and exception messages for up to one batch of queued changes. */
export async function deliverOutbox(telegram: Telegram): Promise<number> {
  await recoverExpiredLeases(telegram.pool);
  const { rows } = await telegram.pool.query<DueRow>(
    `update telegram_outbox t set status = 'SENDING', attempts = t.attempts + 1, lease_until = now() + interval '${lease_s} seconds', updated_at = now()
     from telegram_connections c
     where c.id = t.connection_id and t.id in (
       select id from telegram_outbox where status in ('PENDING', 'RETRY') and next_attempt_at <= now()
       order by created_at, id limit ${batchSize} for update skip locked)
     returning t.id, t.workspace_id, t.order_id, c.chat_id, t.connection_id, t.attempts, t.kind, t.payload, t.created_at`,
  );
  // RETURNING does not keep the subquery's order; deliver oldest first.
  rows.sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || (a.id < b.id ? -1 : 1));
  for (const row of rows) {
    if (row.kind === "EXCEPTION") await deliverException(telegram, row);
    else if (row.kind === "REPLY") await deliverReply(telegram, row);
    else await deliverStatus(telegram, row);
  }
  return rows.length;
}

// A worker that died mid-send leaves rows SENDING. An edit can safely run
// again; a first send cannot, because it may already be in the chat.
async function recoverExpiredLeases(pool: pg.Pool): Promise<void> {
  await pool.query(
    `update telegram_outbox t set status = case when r.message_id is null then 'UNCERTAIN' else 'RETRY' end, updated_at = now()
     from telegram_outbox o left join telegram_message_refs r on r.order_id = o.order_id and r.connection_id = o.connection_id and r.purpose = o.kind
     where t.id = o.id and t.status = 'SENDING' and t.lease_until < now()`,
  );
}

// Opens the bot's main Mini App on this order. Telegram does not allow
// Mini App buttons in groups, so this is a t.me link; it needs the Main Mini
// App set in BotFather, and opens the bot's chat otherwise.
function orderLink(botUsername: string, orderId: string): string {
  return `https://t.me/${botUsername}?startapp=order_${orderId}`;
}

async function deliverStatus(telegram: Telegram, row: DueRow): Promise<void> {
  const state = await statusOf(telegram.pool, row.workspace_id, row.order_id, row.connection_id);
  if (!row.payload.force && state.renderedVersion !== null && state.renderedVersion >= state.version) {
    // An earlier row already showed this state or a newer one.
    return settle(telegram.pool, row.id, "SENT", null);
  }
  const text = renderStatus(state.status);
  const open = [[{ text: "Open in Stow", url: orderLink(telegram.botUsername, row.order_id) }]];
  const result = state.messageId
    ? await telegram.api.editMessageText(row.chat_id, state.messageId, text, open)
    : await telegram.api.sendMessage(row.chat_id, text, state.sourceMessageId ? Number(state.sourceMessageId) : undefined, open);
  await finish(telegram.pool, row, result, state.messageId, async (messageId) => {
    await telegram.pool.query(
      `insert into telegram_message_refs (workspace_id, connection_id, order_id, purpose, message_id, last_rendered_version)
       values ($1, $2, $3, 'STATUS', $4, $5)
       on conflict (connection_id, order_id, purpose) do update set last_rendered_version = greatest(telegram_message_refs.last_rendered_version, excluded.last_rendered_version)`,
      [row.workspace_id, row.connection_id, row.order_id, messageId, state.version],
    );
  });
}

// A picker's quick reply, posted under the order's status message so the
// group sees which order it is about.
async function deliverReply(telegram: Telegram, row: DueRow): Promise<void> {
  const { rows } = await telegram.pool.query<{ body: string; picker: string; ref: string; status_message: string | null; source_message_id: string | null }>(
    `select n.body, m.display_name as picker, o.ref, r.message_id as status_message, o.source_message_id
     from order_messages n join members m on m.id = n.author_member_id join orders o on o.id = n.order_id
     left join telegram_message_refs r on r.order_id = o.id and r.connection_id = $3 and r.purpose = 'STATUS'
     where n.workspace_id = $1 and n.id = $2`,
    [row.workspace_id, row.payload.messageId, row.connection_id],
  );
  const reply = rows[0]!;
  const anchor = reply.status_message ?? reply.source_message_id;
  const result = await telegram.api.sendMessage(row.chat_id, renderReply(reply.picker, reply.ref, reply.body), anchor ? Number(anchor) : undefined);
  await finish(telegram.pool, row, result, null, async () => {});
}

const decisions: Record<string, (target: number) => string> = {
  RESUME: () => "carry on as ordered",
  REDUCE: (target) => `reduce to ${target}`,
  SUBSTITUTE: () => "substitute",
  CANCEL: () => "cancel the order",
};

// One message per exception: sent with the decision buttons when reported,
// then edited to show the decision, without buttons, once resolved.
async function deliverException(telegram: Telegram, row: DueRow): Promise<void> {
  const exceptionId = row.payload.exceptionId!;
  const { rows } = await telegram.pool.query<{
    status: string; type: ExceptionNotice["type"]; reported_qty: number | null; resolution: string | null;
    sku: string; requested: number; picked: number; ref: string; picker: string; source_message_id: string | null;
  }>(
    `select e.status, e.type, e.reported_qty, e.resolution, l.sku_snapshot as sku, l.requested_qty as requested, l.picked_qty as picked,
            o.ref, m.display_name as picker, o.source_message_id
     from order_exceptions e
     join orders o on o.id = e.order_id
     join order_lines l on l.id = e.line_id
     join members m on m.workspace_id = e.workspace_id and m.id = e.reporter_id
     where e.workspace_id = $1 and e.id = $2`,
    [row.workspace_id, exceptionId],
  );
  const found = rows[0]!;
  const notice: ExceptionNotice = {
    ref: found.ref,
    type: found.type,
    sku: found.sku,
    requested: found.requested,
    picked: found.picked,
    reportedQty: found.reported_qty,
    picker: found.picker,
    decision: found.resolution ? decisions[found.resolution]!(found.requested) : null,
  };
  const id = compactId(exceptionId);
  const buttons: Button[][] | undefined =
    found.status === "OPEN"
      ? [
          [{ text: "Resume", data: `x:${id}:R` }, { text: `Reduce to ${reducedTarget(notice)}`, data: `x:${id}:D` }],
          [{ text: "Cancel order", data: `x:${id}:C` }],
        ]
      : undefined;
  const existing = await telegram.pool.query<{ message_id: string }>(
    "select message_id from telegram_message_refs where connection_id = $1 and order_id = $2 and purpose = 'EXCEPTION' and exception_id = $3",
    [row.connection_id, row.order_id, exceptionId],
  );
  const messageId = existing.rows[0]?.message_id ?? null;
  const text = renderException(notice);
  const result = messageId
    ? await telegram.api.editMessageText(row.chat_id, messageId, text, buttons)
    : await telegram.api.sendMessage(row.chat_id, text, found.source_message_id ? Number(found.source_message_id) : undefined, buttons);
  await finish(telegram.pool, row, result, messageId, async (sentId) => {
    await telegram.pool.query(
      `insert into telegram_message_refs (workspace_id, connection_id, order_id, purpose, message_id, last_rendered_version, exception_id)
       values ($1, $2, $3, 'EXCEPTION', $4, 0, $5)
       on conflict (connection_id, order_id, purpose) do update set message_id = excluded.message_id, exception_id = excluded.exception_id`,
      [row.workspace_id, row.connection_id, row.order_id, sentId, exceptionId],
    );
  });
}

// Settles an outbox row from Telegram's answer. An unknown answer to a first
// send is final (UNCERTAIN): the message may already be in the chat.
async function finish(
  pool: pg.Pool,
  row: DueRow,
  result: Result<Message | true>,
  existingMessageId: string | null,
  onSent: (messageId: string) => Promise<void>,
): Promise<void> {
  if (result.kind === "ok") {
    const messageId = typeof result.value === "object" ? String(result.value.message_id) : existingMessageId!;
    await onSent(messageId);
    return settle(pool, row.id, "SENT", null, messageId);
  }
  if (result.kind === "rejected") return settle(pool, row.id, "FAILED", `telegram_${result.code}`);
  if (result.kind === "unknown" && !existingMessageId) return settle(pool, row.id, "UNCERTAIN", result.reason);
  if (row.attempts >= maxAttempts) return settle(pool, row.id, "FAILED", "max_attempts");
  const wait_ms = result.kind === "retry" ? result.after_ms : backoff_s[Math.min(row.attempts - 1, backoff_s.length - 1)]! * 1000;
  await pool.query(
    "update telegram_outbox set status = 'RETRY', next_attempt_at = now() + make_interval(secs => $2), last_error_code = $3, updated_at = now() where id = $1",
    [row.id, wait_ms / 1000, result.kind === "retry" ? "rate_limited" : result.reason],
  );
}

async function settle(pool: pg.Pool, id: string, status: "SENT" | "FAILED" | "UNCERTAIN", error: string | null, messageId?: string): Promise<void> {
  await pool.query(
    "update telegram_outbox set status = $2, last_error_code = $3, provider_message_id = coalesce($4, provider_message_id), lease_until = null, updated_at = now() where id = $1",
    [id, status, error, messageId ?? null],
  );
}

async function statusOf(pool: pg.Pool, workspaceId: string, orderId: string, connectionId: string) {
  const order = await pool.query<{
    ref: string; revision: number; version: string; terminal: "COMPLETED" | "CANCELLED" | null; source_message_id: string | null;
    picker: string | null; tote_id: string | null; ack_revision: number | null; is_accepted: boolean | null; is_paused: boolean; is_cancel_requested: boolean; is_release_requested: boolean; is_blocked: boolean;
    note: "UNREAD" | "READ" | null;
  }>(
    `select o.ref, o.revision, o.version, o.terminal, o.source_message_id, m.display_name as picker, a.tote_id, a.ack_revision, a.is_accepted,
            o.is_paused, o.is_cancel_requested, o.is_release_requested,
            exists (select 1 from order_exceptions e where e.order_id = o.id and e.status = 'OPEN') as is_blocked,
            (select case when n.read_at is null then 'UNREAD' else 'READ' end from order_messages n
             where n.order_id = o.id and n.direction = 'TO_PICKER' order by n.created_at desc limit 1) as note
     from orders o
     left join assignments a on a.order_id = o.id and a.released_at is null
     left join members m on m.workspace_id = o.workspace_id and m.id = a.worker_id
     where o.workspace_id = $1 and o.id = $2`,
    [workspaceId, orderId],
  );
  const lines = await pool.query<{ sku_snapshot: string; requested_qty: number; picked_qty: number }>(
    "select sku_snapshot, requested_qty, picked_qty from order_lines where workspace_id = $1 and order_id = $2 order by creation_index",
    [workspaceId, orderId],
  );
  const ref = await pool.query<{ message_id: string; last_rendered_version: string }>(
    "select message_id, last_rendered_version from telegram_message_refs where connection_id = $1 and order_id = $2 and purpose = 'STATUS'",
    [connectionId, orderId],
  );
  const row = order.rows[0]!;
  return {
    version: Number(row.version),
    sourceMessageId: row.source_message_id,
    messageId: ref.rows[0]?.message_id ?? null,
    renderedVersion: ref.rows[0] ? Number(ref.rows[0].last_rendered_version) : null,
    status: {
      ref: row.ref,
      revision: row.revision,
      terminal: row.terminal,
      picker: row.picker,
      toteId: row.tote_id,
      hold: holdOf(row),
      note: row.note ?? ("NONE" as const),
      lines: lines.rows.map((line) => ({ sku: line.sku_snapshot, requested: line.requested_qty, picked: line.picked_qty })),
    },
  };
}

// The one thing holding an order up, in the order the picker would meet it.
function holdOf(row: { is_accepted: boolean | null; is_blocked: boolean; is_cancel_requested: boolean; is_release_requested: boolean; is_paused: boolean; ack_revision: number | null; revision: number }) {
  if (row.is_blocked) return "BLOCKED" as const;
  if (row.is_accepted === false || (row.ack_revision !== null && row.ack_revision !== row.revision)) return "AWAITING_PICKER_ACK" as const;
  if (row.is_cancel_requested) return "CANCELLING" as const;
  if (row.is_release_requested) return "RELEASING" as const;
  if (row.is_paused) return "PAUSED" as const;
  return "NONE" as const;
}

/**
 * runTelegram long-polls for updates and, separately, drains the outbox every
 * half second, until the signal aborts. Delivery has its own loop so a status
 * edit never waits behind a 20-second long poll. Polling is for local
 * development; hosted deployments use a webhook instead, never both for one bot.
 */
export async function runTelegram(telegram: Telegram, signal: AbortSignal, log: (msg: string, data?: object) => void): Promise<void> {
  await Promise.all([receiveLoop(telegram, signal, log), deliveryLoop(telegram, signal, log)]);
}

async function receiveLoop(telegram: Telegram, signal: AbortSignal, log: (msg: string, data?: object) => void): Promise<void> {
  let offset = 0;
  while (!signal.aborted) {
    const updates = await telegram.api.getUpdates(offset, 20);
    if (updates.kind !== "ok") {
      log("telegram getUpdates failed", { kind: updates.kind });
      await sleep(updates.kind === "retry" ? updates.after_ms : 2_000);
      continue;
    }
    for (const update of updates.value) {
      await receive(telegram.pool, telegram.botAlias, update);
      offset = Math.max(offset, update.update_id + 1);
    }
    try {
      await processInbox(telegram);
    } catch (error) {
      log("telegram inbox failed", { error: (error as Error).message });
    }
  }
}

async function deliveryLoop(telegram: Telegram, signal: AbortSignal, log: (msg: string, data?: object) => void): Promise<void> {
  while (!signal.aborted) {
    try {
      await deliverOutbox(telegram);
    } catch (error) {
      log("telegram outbox failed", { error: (error as Error).message });
    }
    await sleep(500);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
