// Telegram is a third-party boundary, so these tests run the real client
// against a local HTTP server that answers the way Telegram does.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createBotApi } from "./botapi.ts";

let server: Server;
let baseUrl: string;
let reply: (method: string, body: Record<string, unknown>) => { status: number; json?: object; delay_ms?: number };
const seen: { method: string; body: Record<string, unknown> }[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const method = request.url!.split("/").at(-1)!;
      const body = JSON.parse(raw || "{}");
      seen.push({ method, body });
      const answer = reply(method, body);
      setTimeout(() => {
        response.writeHead(answer.status, { "content-type": "application/json" });
        response.end(JSON.stringify(answer.json ?? {}));
      }, answer.delay_ms ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const api = () => createBotApi("123:test-token", baseUrl, 300);

describe("createBotApi", () => {
  test("sends plain text as a reply and returns the message", async () => {
    reply = () => ({ status: 200, json: { ok: true, result: { message_id: 77, chat: { id: -100, type: "group" } } } });
    const got = await api().sendMessage("-100", "ST-1 · QUEUED", 5);
    expect(got).toMatchObject({ kind: "ok", value: { message_id: 77 } });
    expect(seen.at(-1)).toMatchObject({ method: "sendMessage", body: { chat_id: "-100", reply_parameters: { message_id: 5 } } });
    expect(seen.at(-1)!.body).not.toHaveProperty("parse_mode");
  });

  test("a 429 becomes a retry after Telegram's retry_after", async () => {
    reply = () => ({ status: 429, json: { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 7 } } });
    expect(await api().sendMessage("-100", "x")).toEqual({ kind: "retry", after_ms: 7000 });
  });

  test("a removed bot is a rejection, not a retry", async () => {
    reply = () => ({ status: 403, json: { ok: false, error_code: 403, description: "Forbidden: bot was kicked from the group chat" } });
    expect(await api().sendMessage("-100", "x")).toEqual({ kind: "rejected", code: 403, description: "Forbidden: bot was kicked from the group chat" });
  });

  test("a timeout or server error leaves the outcome unknown", async () => {
    reply = () => ({ status: 200, json: { ok: true, result: {} }, delay_ms: 1000 });
    expect(await api().sendMessage("-100", "x")).toEqual({ kind: "unknown", reason: "timeout" });
    reply = () => ({ status: 502 });
    expect(await api().sendMessage("-100", "x")).toEqual({ kind: "unknown", reason: "http 502" });
  });

  test("editing to identical text counts as success", async () => {
    reply = () => ({ status: 400, json: { ok: false, error_code: 400, description: "Bad Request: message is not modified" } });
    expect(await api().editMessageText("-100", "77", "same")).toEqual({ kind: "ok", value: true });
  });
});

describe("inline buttons", () => {
  test("sends a keyboard and refuses callback data over 64 bytes", async () => {
    reply = () => ({ status: 200, json: { ok: true, result: { message_id: 1, chat: { id: -1, type: "group" } } } });
    await api().sendMessage("-1", "pick one", undefined, [[{ text: "Confirm", data: "c:abc" }]]);
    expect(seen.at(-1)!.body).toMatchObject({ reply_markup: { inline_keyboard: [[{ text: "Confirm", callback_data: "c:abc" }]] } });
    await expect(api().sendMessage("-1", "x", undefined, [[{ text: "Big", data: "x".repeat(65) }]])).rejects.toThrow(/over 64 bytes/);
  });

  test("an edit without buttons clears the keyboard", async () => {
    reply = () => ({ status: 200, json: { ok: true, result: true } });
    await api().editMessageText("-1", "5", "decided");
    expect(seen.at(-1)!.body).toMatchObject({ reply_markup: { inline_keyboard: [] } });
  });
});
