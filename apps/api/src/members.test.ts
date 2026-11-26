import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "./db/testdb.ts";
import { createOrder, runCommand } from "./fulfilment.ts";
import { buildHttp, hashToken } from "./http.ts";

const botToken = "123456:test-token-for-signing-launch-data";

function launchData(userId: number): string {
  const fields: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: "U" }) };
  const checkString = Object.keys(fields).sort().map((key) => `${key}=${fields[key]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  return new URLSearchParams({ ...fields, hash: createHmac("sha256", secret).update(checkString).digest("hex") }).toString();
}

let db: TestDatabase;
let nextTelegramId = 1000;
const apps: FastifyInstance[] = [];
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await Promise.all(apps.map((app) => app.close()));
  await db.drop();
});

type Person = { id: string; headers: Record<string, string> };

// A workspace with an owner, a coordinator and a picker, each signed in to
// the Mini App, and the picker's glasses paired. Each team has its own server,
// so the per-address sign-in limit does not carry over between tests.
async function team() {
  const app = buildHttp({ pool: db.pool, taskTokenSecret: "x".repeat(32), botToken, now: () => new Date(), corsAllowedOrigins: [], logger: false });
  apps.push(app);
  const workspaceId = (await db.pool.query<{ id: string }>("insert into workspaces (name) values ('Stockroom') returning id")).rows[0]!.id;
  await db.pool.query("insert into products (workspace_id, sku, normalized_sku, name, bin) values ($1, 'TS-BLK-M', 'TS-BLK-M', 'Black T-shirt', 'A-03')", [workspaceId]);
  const person = async (name: string, role: string): Promise<Person> => {
    const telegramId = nextTelegramId++;
    const id = (await db.pool.query<{ id: string }>("insert into members (workspace_id, display_name, role, telegram_user_id) values ($1, $2, $3, $4) returning id", [workspaceId, name, role, String(telegramId)])).rows[0]!.id;
    const session = await app.inject({ method: "POST", url: "/v1/telegram/miniapp/session", payload: { initData: launchData(telegramId) } });
    return { id, headers: { authorization: `Bearer ${session.json().data.token}` } };
  };
  const owner = await person("Ada", "OWNER");
  const coordinator = await person("Bola", "COORDINATOR");
  const picker = await person("Chi", "PICKER");
  const glasses = randomBytes(32).toString("base64url");
  await db.pool.query("insert into device_tokens (workspace_id, member_id, label, token_hash, expires_at) values ($1, $2, 'G2', $3, now() + interval '1 hour')", [workspaceId, picker.id, hashToken(glasses)]);
  return { app, workspaceId, owner, coordinator, picker, glassesHeaders: { authorization: `Bearer ${glasses}` } };
}

type Team = Awaited<ReturnType<typeof team>>;
const list = (t: Team, by: Person) => t.app.inject({ method: "GET", url: `/v1/workspaces/${t.workspaceId}/members`, headers: by.headers });
const act = async (t: Team, by: Person, member: Person, path: string, payload: object = {}) => {
  const response = await t.app.inject({ method: "POST", url: `/v1/workspaces/${t.workspaceId}/members/${member.id}/${path}`, headers: by.headers, payload });
  return { status: response.statusCode, code: response.json().error?.code as string | undefined };
};
const snapshot = (t: Team) => t.app.inject({ method: "GET", url: `/v1/workspaces/${t.workspaceId}/worker/snapshot`, headers: t.glassesHeaders });

describe("workers", () => {
  test("lists the team, owners first, with linked accounts, glasses and open orders", async () => {
    const t = await team();
    const listed = (await list(t, t.coordinator)).json().data.members;
    expect(listed.map((m: { name: string; role: string; isLinked: boolean; devices: number; isYou: boolean }) => [m.name, m.role, m.isLinked, m.devices, m.isYou])).toEqual([
      ["Ada", "OWNER", true, 0, false],
      ["Bola", "COORDINATOR", true, 0, true],
      ["Chi", "PICKER", true, 1, false],
    ]);
  });

  test("an owner changes a role; a coordinator cannot", async () => {
    const t = await team();
    expect(await act(t, t.coordinator, t.picker, "role", { role: "COORDINATOR" })).toEqual({ status: 403, code: "ROLE_REQUIRED" });
    expect(await act(t, t.owner, t.picker, "role", { role: "COORDINATOR" })).toEqual({ status: 200, code: undefined });
    const listed = (await list(t, t.owner)).json().data.members;
    expect(listed.find((m: { name: string }) => m.name === "Chi").role).toBe("COORDINATOR");
  });

  test("the last owner cannot step down until there is another owner", async () => {
    const t = await team();
    expect(await act(t, t.owner, t.owner, "role", { role: "COORDINATOR" })).toEqual({ status: 409, code: "LAST_OWNER" });
    expect(await act(t, t.owner, t.owner, "remove")).toEqual({ status: 409, code: "LAST_OWNER" });
    await act(t, t.owner, t.coordinator, "role", { role: "OWNER" });
    expect(await act(t, t.owner, t.owner, "role", { role: "COORDINATOR" })).toEqual({ status: 200, code: undefined });
  });

  test("revoking glasses signs them out on their next request", async () => {
    const t = await team();
    expect((await snapshot(t)).statusCode).toBe(200);
    expect(await act(t, t.owner, t.picker, "devices/revoke")).toEqual({ status: 200, code: undefined });
    expect((await snapshot(t)).statusCode).toBe(401);
    expect(await act(t, t.owner, t.picker, "devices/revoke")).toEqual({ status: 409, code: "NO_CHANGE" });
  });

  test("someone holding an open order cannot be removed until it is closed", async () => {
    const t = await team();
    const created = await createOrder(db.pool, { workspaceId: t.workspaceId, createdBy: t.owner.id, sourceKey: `test:${randomUUID()}`, connectionId: null, sourceMessageId: null, request: { ref: null, lines: [{ sku: "TS-BLK-M", quantity: 1 }] } });
    if (!created.ok || !("orderId" in created)) throw new Error("not created");
    await runCommand(db.pool, { workspaceId: t.workspaceId, memberId: t.picker.id, role: "PICKER" }, randomUUID(), { type: "CLAIM_ORDER", orderId: created.orderId, revision: 1, version: 1, toteId: "A" });
    expect(await act(t, t.owner, t.picker, "remove")).toEqual({ status: 409, code: "HOLDS_ORDERS" });

    // A cancelled order stays with its picker until they close it on the glasses.
    await runCommand(db.pool, { workspaceId: t.workspaceId, memberId: t.owner.id, role: "OWNER" }, randomUUID(), { type: "REQUEST_CANCEL", orderId: created.orderId, revision: 1, version: 2, reason: "test" });
    expect(await act(t, t.owner, t.picker, "remove")).toEqual({ status: 409, code: "HOLDS_ORDERS" });
    const picker = { workspaceId: t.workspaceId, memberId: t.picker.id, role: "PICKER" as const };
    await runCommand(db.pool, picker, randomUUID(), { type: "ACK_REVISION", orderId: created.orderId, revision: 2, version: 3 });
    expect((await runCommand(db.pool, picker, randomUUID(), { type: "CLOSE_CANCELLED", orderId: created.orderId, revision: 2, version: 4 })).status).toBe(200);
    expect(await act(t, t.owner, t.picker, "remove")).toEqual({ status: 200, code: undefined });
  });

  test("removal ends Mini App and glasses access and hides the person from pickers", async () => {
    const t = await team();
    expect(await act(t, t.owner, t.coordinator, "remove")).toEqual({ status: 200, code: undefined });
    expect(await act(t, t.owner, t.picker, "remove")).toEqual({ status: 200, code: undefined });
    expect((await list(t, t.coordinator)).statusCode).toBe(404);
    expect((await snapshot(t)).statusCode).toBe(401);
    const names = (await list(t, t.owner)).json().data.members.map((m: { name: string }) => m.name);
    expect(names).toEqual(["Ada"]);
    const pickers = (await t.app.inject({ method: "GET", url: `/v1/workspaces/${t.workspaceId}/pickers`, headers: t.owner.headers })).json().data.pickers;
    expect(pickers.map((p: { name: string }) => p.name)).toEqual(["Ada"]);
    expect(await act(t, t.owner, t.picker, "remove")).toEqual({ status: 404, code: "NOT_FOUND" });
  });
});
