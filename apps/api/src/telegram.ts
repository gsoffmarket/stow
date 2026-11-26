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

import { createHash } from "node:crypto";
import type pg from "pg";
import type { BotApi, Message, Update } from "@stow/telegram/botapi";
import { parseCommand, parseOrder, type OrderError } from "@stow/telegram/commands";
import { renderStatus } from "@stow/telegram/status";
import { createOrder, transaction } from "./fulfilment.ts";

export type Telegram = { readonly pool: pg.Pool; readonly api: BotApi; readonly botAlias: string; readonly botUsername: string };

/** StoredMessage is the minimum kept from a command message; other updates keep nothing. */
type StoredMessage = { chatId: string; chatType: string; fromId: string; messageId: number; text: string };

const batchSize = 10;
const lease_s = 30;
const maxAttempts = 8;
const backoff_s = [1, 2, 5, 10, 30, 60, 120, 300];

/** receive stores an update once. Updates that are not commands are kept only as a dedupe marker. */
export async function receive(pool: pg.Pool, botAlias: string, update: Update): Promise<void> {
  const message = commandMessage(update.message);
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
  return { chatId: String(message.chat.id), chatType: message.chat.type, fromId: String(message.from.id), messageId: message.message_id, text: message.text };
}

/** processInbox handles up to one batch of pending commands and returns how many it took. */
export async function processInbox(telegram: Telegram): Promise<number> {
  const { rows } = await telegram.pool.query<{ id: string; payload: StoredMessage; attempts: number }>(
    `update telegram_inbox set attempts = attempts + 1, next_attempt_at = now() + interval '${lease_s} seconds'
     where id in (select id from telegram_inbox where status = 'PENDING' and next_attempt_at <= now()
                  order by update_id::numeric limit ${batchSize} for update skip locked)
     returning id, payload, attempts`,
  );
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

async function handle(telegram: Telegram, message: StoredMessage): Promise<void> {
  const command = parseCommand(message.text, telegram.botUsername);
  if (!command) return;
  const reply = (text: string) => telegram.api.sendMessage(message.chatId, text, message.messageId);
  switch (command.name) {
    case "start":
    case "help":
      await reply(helpText);
      return;
    case "stow_bind":
      await reply(await bind(telegram.pool, message, command.args));
      return;
    case "order": {
      const answer = await intake(telegram, message, command);
      if (answer) await reply(answer);
      return;
    }
  }
}

const helpText = [
  "Stow turns orders in this group into picking instructions on Even G2.",
  "",
  "/order [REF] then one line per item:",
  "SKU x QTY",
  "",
  "Stow only reads commands sent to it. It does not read other messages.",
].join("\n");

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

type DueRow = { id: string; workspace_id: string; order_id: string; chat_id: string; connection_id: string; attempts: number };

/** deliverOutbox sends or edits status messages for up to one batch of queued changes. */
export async function deliverOutbox(telegram: Telegram): Promise<number> {
  await recoverExpiredLeases(telegram.pool);
  const { rows } = await telegram.pool.query<DueRow>(
    `update telegram_outbox t set status = 'SENDING', attempts = t.attempts + 1, lease_until = now() + interval '${lease_s} seconds', updated_at = now()
     from telegram_connections c
     where c.id = t.connection_id and t.id in (
       select id from telegram_outbox where status in ('PENDING', 'RETRY') and next_attempt_at <= now()
       order by created_at, id limit ${batchSize} for update skip locked)
     returning t.id, t.workspace_id, t.order_id, c.chat_id, t.connection_id, t.attempts`,
  );
  for (const row of rows) await deliver(telegram, row);
  return rows.length;
}

// A worker that died mid-send leaves rows SENDING. An edit can safely run
// again; a first send cannot, because it may already be in the chat.
async function recoverExpiredLeases(pool: pg.Pool): Promise<void> {
  await pool.query(
    `update telegram_outbox t set status = case when r.message_id is null then 'UNCERTAIN' else 'RETRY' end, updated_at = now()
     from telegram_outbox o left join telegram_message_refs r on r.order_id = o.order_id and r.connection_id = o.connection_id and r.purpose = 'STATUS'
     where t.id = o.id and t.status = 'SENDING' and t.lease_until < now()`,
  );
}

async function deliver(telegram: Telegram, row: DueRow): Promise<void> {
  const state = await statusOf(telegram.pool, row.workspace_id, row.order_id, row.connection_id);
  if (state.renderedVersion !== null && state.renderedVersion >= state.version) {
    // An earlier row already showed this state or a newer one.
    return settle(telegram.pool, row.id, "SENT", null);
  }
  const text = renderStatus(state.status);
  const result = state.messageId
    ? await telegram.api.editMessageText(row.chat_id, state.messageId, text)
    : await telegram.api.sendMessage(row.chat_id, text, state.sourceMessageId ? Number(state.sourceMessageId) : undefined);

  if (result.kind === "ok") {
    const messageId = typeof result.value === "object" ? String(result.value.message_id) : state.messageId!;
    await telegram.pool.query(
      `insert into telegram_message_refs (workspace_id, connection_id, order_id, purpose, message_id, last_rendered_version)
       values ($1, $2, $3, 'STATUS', $4, $5)
       on conflict (connection_id, order_id, purpose) do update set last_rendered_version = greatest(telegram_message_refs.last_rendered_version, excluded.last_rendered_version)`,
      [row.workspace_id, row.connection_id, row.order_id, messageId, state.version],
    );
    return settle(telegram.pool, row.id, "SENT", null, messageId);
  }
  if (result.kind === "rejected") return settle(telegram.pool, row.id, "FAILED", `telegram_${result.code}`);
  if (result.kind === "unknown" && !state.messageId) return settle(telegram.pool, row.id, "UNCERTAIN", result.reason);
  if (row.attempts >= maxAttempts) return settle(telegram.pool, row.id, "FAILED", "max_attempts");
  const wait_ms = result.kind === "retry" ? result.after_ms : backoff_s[Math.min(row.attempts - 1, backoff_s.length - 1)]! * 1000;
  await telegram.pool.query(
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
  const order = await pool.query<{ ref: string; revision: number; version: string; terminal: "COMPLETED" | "CANCELLED" | null; source_message_id: string | null; picker: string | null; tote_id: string | null }>(
    `select o.ref, o.revision, o.version, o.terminal, o.source_message_id, m.display_name as picker, a.tote_id
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
      lines: lines.rows.map((line) => ({ sku: line.sku_snapshot, requested: line.requested_qty, picked: line.picked_qty })),
    },
  };
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
