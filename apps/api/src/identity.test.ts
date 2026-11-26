import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "./db/testdb.ts";
import { buildHttp } from "./http.ts";
import { verifyLaunchData } from "./identity.ts";

const botToken = "123456:test-token-for-signing-launch-data";
const now_s = 1_800_000_000;

// Signs launch data the way Telegram does (see identity.ts), so the tests
// exercise the real verifier rather than a stub.
function signed(fields: Record<string, string>, token = botToken): string {
  const checkString = Object.keys(fields).sort().map((key) => `${key}=${fields[key]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(checkString).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

const user = JSON.stringify({ id: 4242, first_name: "Ada", username: "ada_picks" });
const fresh = { auth_date: String(now_s - 10), query_id: "AAE", user };

describe("verifyLaunchData", () => {
  test("accepts Telegram-signed data and returns the signed user", () => {
    expect(verifyLaunchData(signed(fresh), botToken, now_s)).toEqual({ ok: true, user: { id: "4242", firstName: "Ada", username: "ada_picks" } });
  });

  test("rejects data signed for another bot", () => {
    expect(verifyLaunchData(signed(fresh, "999:other"), botToken, now_s)).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("rejects a user field edited after signing", () => {
    const tampered = signed(fresh).replace("4242", "4243");
    expect(verifyLaunchData(tampered, botToken, now_s)).toEqual({ ok: false, reason: "bad_signature" });
  });

  test.each([
    { name: "unsigned data", data: new URLSearchParams(fresh).toString(), reason: "unsigned" },
    { name: "data older than five minutes", data: signed({ ...fresh, auth_date: String(now_s - 301) }), reason: "expired" },
    { name: "data from the future", data: signed({ ...fresh, auth_date: String(now_s + 120) }), reason: "expired" },
    { name: "data without a user", data: signed({ auth_date: String(now_s) }), reason: "no_user" },
  ])("rejects $name", ({ data, reason }) => {
    expect(verifyLaunchData(data, botToken, now_s)).toEqual({ ok: false, reason });
  });
});

describe("Mini App session", () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  beforeAll(async () => {
    db = await createTestDatabase();
    app = buildHttp({ pool: db.pool, taskTokenSecret: "x".repeat(32), botToken, now: () => new Date(now_s * 1000), corsAllowedOrigins: [], logger: false });
  });
  afterAll(async () => {
    await app.close();
    await db.drop();
  });

  test("signed launch data becomes a session that lists the person's workspaces", async () => {
    const ws = await db.pool.query<{ id: string }>("insert into workspaces (name) values ('Stockroom') returning id");
    await db.pool.query("insert into members (workspace_id, display_name, role, telegram_user_id) values ($1, 'Ada', 'PICKER', '4242')", [ws.rows[0]!.id]);

    const started = await app.inject({ method: "POST", url: "/v1/telegram/miniapp/session", payload: { initData: signed(fresh) } });
    expect(started.statusCode).toBe(200);
    const { token } = started.json().data;

    const me = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${token}` } });
    expect(me.json().data).toEqual({
      telegramUserId: "4242",
      memberships: [{ workspaceId: ws.rows[0]!.id, workspaceName: "Stockroom", memberId: expect.any(String), role: "PICKER", displayName: "Ada" }],
    });
  });

  test("forged launch data and missing sessions are refused", async () => {
    const forged = await app.inject({ method: "POST", url: "/v1/telegram/miniapp/session", payload: { initData: signed(fresh).replace("4242", "1") } });
    expect(forged.statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/me" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${"a".repeat(43)}` } })).statusCode).toBe(401);
  });
});
