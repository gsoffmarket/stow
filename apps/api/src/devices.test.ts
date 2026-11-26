import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "./db/testdb.ts";
import { buildHttp } from "./http.ts";

const botToken = "123456:test-token-for-signing-launch-data";

function launchData(userId: number): string {
  const fields: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: "P" }) };
  const checkString = Object.keys(fields).sort().map((key) => `${key}=${fields[key]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  return new URLSearchParams({ ...fields, hash: createHmac("sha256", secret).update(checkString).digest("hex") }).toString();
}

let db: TestDatabase;
let app: FastifyInstance;
let workspaceId: string;
beforeAll(async () => {
  db = await createTestDatabase();
  app = buildHttp({ pool: db.pool, taskTokenSecret: "x".repeat(32), botToken, now: () => new Date(), corsAllowedOrigins: [], logger: false });
  workspaceId = (await db.pool.query<{ id: string }>("insert into workspaces (name) values ('Stockroom') returning id")).rows[0]!.id;
  await db.pool.query("insert into members (workspace_id, display_name, role, telegram_user_id) values ($1, 'Picker', 'PICKER', '100'), ($1, 'Coord', 'COORDINATOR', '200')", [workspaceId]);
});
afterAll(async () => {
  await app.close();
  await db.drop();
});

async function signIn(userId: number): Promise<Record<string, string>> {
  const session = await app.inject({ method: "POST", url: "/v1/telegram/miniapp/session", payload: { initData: launchData(userId) } });
  return { authorization: `Bearer ${session.json().data.token}` };
}

async function startPairing() {
  const started = await app.inject({ method: "POST", url: "/v1/devices/pairings", payload: { label: "Even G2" } });
  return started.json().data as { pairingId: string; code: string; secret: string };
}

const poll = (p: { pairingId: string; secret: string }) =>
  app.inject({ method: "GET", url: `/v1/devices/pairings/${p.pairingId}`, headers: { "x-pairing-secret": p.secret } });
const swap = (p: { pairingId: string; secret: string }) =>
  app.inject({ method: "POST", url: `/v1/devices/pairings/${p.pairingId}/exchange`, headers: { "x-pairing-secret": p.secret } });

describe("pairing", () => {
  test("glasses show a code, a picker approves it, the glasses get a working token once", async () => {
    const pairing = await startPairing();
    expect(pairing.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect((await poll(pairing)).json().data).toEqual({ status: "PENDING" });
    expect((await swap(pairing)).json().error.code).toBe("NOT_APPROVED");

    const typed = pairing.code.toLowerCase().replace("-", " ");
    const approved = await app.inject({ method: "POST", url: "/v1/devices/pairings/approve", headers: await signIn(100), payload: { workspaceId, code: typed } });
    expect(approved.json().data).toEqual({ label: "Even G2" });
    expect((await poll(pairing)).json().data).toEqual({ status: "APPROVED" });

    const issued = (await swap(pairing)).json().data;
    expect(issued.workspaceId).toBe(workspaceId);
    const snapshot = await app.inject({ method: "GET", url: `/v1/workspaces/${workspaceId}/worker/snapshot`, headers: { authorization: `Bearer ${issued.token}` } });
    expect(snapshot.statusCode).toBe(200);
    expect((await swap(pairing)).json().error.code).toBe("ALREADY_EXCHANGED");
  });

  test("the code alone cannot be exchanged, and polling needs the secret", async () => {
    const pairing = await startPairing();
    expect((await poll({ ...pairing, secret: "wrong" })).statusCode).toBe(404);
    expect((await swap({ ...pairing, secret: "wrong" })).statusCode).toBe(404);
  });

  test("a coordinator cannot pair glasses, and an outsider cannot approve", async () => {
    const pairing = await startPairing();
    const asCoordinator = await app.inject({ method: "POST", url: "/v1/devices/pairings/approve", headers: await signIn(200), payload: { workspaceId, code: pairing.code } });
    expect(asCoordinator.statusCode).toBe(403);
    const asStranger = await app.inject({ method: "POST", url: "/v1/devices/pairings/approve", headers: await signIn(300), payload: { workspaceId, code: pairing.code } });
    expect(asStranger.statusCode).toBe(404);
    expect((await poll(pairing)).json().data).toEqual({ status: "PENDING" });
  });

  test("an expired code cannot be approved", async () => {
    const pairing = await startPairing();
    await db.pool.query("update device_pairings set expires_at = now() - interval '1 second' where id = $1", [pairing.pairingId]);
    expect((await poll(pairing)).json().data).toEqual({ status: "EXPIRED" });
    const late = await app.inject({ method: "POST", url: "/v1/devices/pairings/approve", headers: await signIn(100), payload: { workspaceId, code: pairing.code } });
    expect(late.statusCode).toBe(410);
  });
});
