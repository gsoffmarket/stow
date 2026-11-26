// A small client for the four Telegram Bot API methods Stow uses. It exists
// instead of a framework because the outbox needs to know exactly what a
// failure means:
//
//   ok        Telegram accepted the call.
//   retry     Telegram said "not now" (429, with its retry_after); safe to retry.
//   rejected  Telegram refused the call (bad request, bot removed); retrying won't help.
//   unknown   No clear answer (timeout, connection drop, 5xx). A send may or
//             may not have happened, so the caller must not blindly resend.
//
// The bot token is part of every request URL, so errors never carry the URL.

export type Result<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "retry"; readonly after_ms: number }
  | { readonly kind: "rejected"; readonly code: number; readonly description: string }
  | { readonly kind: "unknown"; readonly reason: string };

/** Message is the part of a Telegram message Stow reads. */
export type Message = {
  readonly message_id: number;
  readonly chat: { readonly id: number; readonly type: string; readonly title?: string };
  readonly from?: { readonly id: number; readonly is_bot: boolean; readonly first_name: string; readonly username?: string };
  readonly sender_chat?: unknown;
  readonly forward_origin?: unknown;
  readonly text?: string;
  readonly reply_to_message?: { readonly message_id: number; readonly from?: { readonly id: number } };
};

/** CallbackQuery is a press of an inline button under one of the bot's messages. */
export type CallbackQuery = {
  readonly id: string;
  readonly from: { readonly id: number; readonly is_bot: boolean };
  readonly message?: { readonly message_id: number; readonly chat: { readonly id: number } };
  readonly data?: string;
};

/** Update is a raw Telegram update; only messages and button presses are handled. */
export type Update = { readonly update_id: number; readonly message?: Message; readonly callback_query?: CallbackQuery };

/** Button is one inline keyboard button; data comes back in the callback (max 64 bytes). */
export type Button = { readonly text: string; readonly data: string };

export type BotApi = {
  getMe(): Promise<Result<{ id: number; username: string }>>;
  getUpdates(offset: number, wait_s: number): Promise<Result<Update[]>>;
  sendMessage(chatId: string, text: string, replyTo?: number, buttons?: readonly Button[][]): Promise<Result<Message>>;
  editMessageText(chatId: string, messageId: string, text: string, buttons?: readonly Button[][]): Promise<Result<true>>;
  answerCallbackQuery(callbackId: string, text: string): Promise<Result<true>>;
};

function keyboard(buttons: readonly Button[][] | undefined): object {
  if (!buttons) return {};
  for (const button of buttons.flat()) {
    if (new TextEncoder().encode(button.data).length > 64) throw new Error(`button data over 64 bytes: ${button.data.length} characters`);
  }
  return { reply_markup: { inline_keyboard: buttons.map((row) => row.map((button) => ({ text: button.text, callback_data: button.data }))) } };
}

/** createBotApi binds the client to one bot. baseUrl is overridable for tests. */
export function createBotApi(token: string, baseUrl = "https://api.telegram.org", timeout_ms = 10_000): BotApi {
  async function call<T>(method: string, body: object, deadline_ms = timeout_ms): Promise<Result<T>> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(deadline_ms),
      });
    } catch (error) {
      return { kind: "unknown", reason: (error as Error).name === "TimeoutError" ? "timeout" : "network" };
    }
    if (response.status >= 500) return { kind: "unknown", reason: `http ${response.status}` };
    let payload: { ok: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      return { kind: "unknown", reason: "unreadable response" };
    }
    if (payload.ok) return { kind: "ok", value: payload.result as T };
    if (payload.error_code === 429) return { kind: "retry", after_ms: (payload.parameters?.retry_after ?? 1) * 1000 };
    return { kind: "rejected", code: payload.error_code ?? response.status, description: payload.description ?? "" };
  }

  return {
    getMe: () => call("getMe", {}),
    getUpdates: (offset, wait_s) => call("getUpdates", { offset, timeout: wait_s, allowed_updates: ["message", "callback_query"] }, (wait_s + 10) * 1000),
    sendMessage: async (chatId, text, replyTo, buttons) =>
      call("sendMessage", {
        chat_id: chatId,
        text,
        link_preview_options: { is_disabled: true },
        ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
        ...keyboard(buttons),
      }),
    answerCallbackQuery: async (callbackId, text) => {
      const result = await call<unknown>("answerCallbackQuery", { callback_query_id: callbackId, text: text.slice(0, 200) });
      return result.kind === "ok" ? { kind: "ok", value: true } : result;
    },
    async editMessageText(chatId, messageId, text, buttons) {
      // An edit without buttons removes any the message had.
      const markup = buttons ? keyboard(buttons) : { reply_markup: { inline_keyboard: [] } };
      const result = await call<unknown>("editMessageText", { chat_id: chatId, message_id: Number(messageId), text, link_preview_options: { is_disabled: true }, ...markup });
      // Editing to identical text is an error in Telegram but a success for us:
      // the chat already shows what we wanted.
      if (result.kind === "rejected" && result.description.includes("message is not modified")) return { kind: "ok", value: true };
      return result.kind === "ok" ? { kind: "ok", value: true } : result;
    },
  };
}
