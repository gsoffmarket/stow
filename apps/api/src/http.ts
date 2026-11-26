// The HTTP surface for the glasses. Two routes carry Gate A: the worker
// snapshot (what to show) and the command endpoint (what the worker did).
//
// Devices send an opaque bearer token; only its SHA-256 is stored. Tasks in a
// snapshot carry a task token, an HMAC over exactly what was shown, so a
// command can only confirm a task the server actually issued.

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { limits as orderLimits, outstandingPick, outstandingReturn, type Order, type Task } from "@stow/order-engine";
import { createOrderOnce, runCommand, startBatch, workerView, type Command, type Role } from "./fulfilment.ts";
import * as devices from "./devices.ts";
import { markRead, postNote, quickReplies, sendReply } from "./messages.ts";
import { listOrders, orderDetail, pickers, sessions, setup, type Cursor } from "./console.ts";
import * as catalogue from "./catalogue.ts";
import * as connections from "./connections.ts";
import * as members from "./members.ts";
import * as reports from "./reports.ts";
import * as workspaceSettings from "./settings.ts";
import { Limiter, limits, type Limit } from "./limits.ts";
import { memberships, sessionUser, startSession, verifyLaunchData } from "./identity.ts";
import type { Actor } from "./fulfilment.ts";

export type HttpOptions = {
  readonly pool: pg.Pool;
  readonly taskTokenSecret: string;
  /** Needed to verify Mini App launch data; Mini App routes answer 503 without it. */
  readonly botToken: string | null;
  readonly now: () => Date;
  readonly corsAllowedOrigins: readonly string[];
  readonly logger: boolean;
  /** True behind the Caddy proxy, so limits key on the caller's address rather than the proxy's. */
  readonly trustProxy?: boolean;
};

type Device = { readonly workspaceId: string; readonly memberId: string; readonly role: Role };

const uuid = z.uuid();
const counter = z.string().regex(/^[0-9]{1,18}$/).transform(Number);
const expected = { orderId: uuid, expectedRevision: z.number().int().min(1), expectedVersion: counter };
const reason = z.string().trim().min(1).max(280);
const consoleCommandBody = z.discriminatedUnion("type", [
  z.strictObject({
    commandId: uuid,
    type: z.literal("REVISE_ORDER"),
    ...expected,
    payload: z.strictObject({
      reason,
      changes: z
        .array(
          z.discriminatedUnion("kind", [
            z.strictObject({ kind: z.literal("SET_QUANTITY"), lineId: uuid, quantity: z.number().int().min(0).max(10_000) }),
            z.strictObject({ kind: z.literal("ADD_LINE"), sku: z.string().trim().toUpperCase().min(1).max(64), quantity: z.number().int().min(1).max(10_000) }),
          ]),
        )
        .min(1)
        .max(100),
    }),
  }),
  z.strictObject({ commandId: uuid, type: z.literal("REQUEST_CANCEL"), ...expected, payload: z.strictObject({ reason }) }),
  z.strictObject({ commandId: uuid, type: z.literal("ASSIGN_ORDER"), ...expected, payload: z.strictObject({ memberId: uuid }) }),
  z.strictObject({
    commandId: uuid,
    type: z.literal("RESOLVE_EXCEPTION"),
    ...expected,
    payload: z.strictObject({
      reason,
      resolution: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("RESUME") }),
        z.strictObject({ kind: z.literal("REDUCE"), quantity: z.number().int().min(0).max(10_000) }),
        z.strictObject({
          kind: z.literal("SUBSTITUTE"),
          quantity: z.number().int().min(0).max(10_000),
          sku: z.string().trim().toUpperCase().min(1).max(64),
          substituteQuantity: z.number().int().min(1).max(10_000),
        }),
        z.strictObject({ kind: z.literal("CANCEL") }),
      ]),
    }),
  }),
]);

// The same limits as /order in Telegram: one line per SKU, bounded quantities.
const newOrderBody = z.strictObject({
  commandId: uuid,
  ref: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/).nullable(),
  lines: z
    .array(z.strictObject({ sku: z.string().trim().min(1).max(64).transform((sku) => sku.normalize("NFKC").toUpperCase()), quantity: z.number().int().min(1).max(orderLimits.unitsPerLine) }))
    .min(1)
    .max(orderLimits.lines)
    .refine((lines) => new Set(lines.map((line) => line.sku)).size === lines.length, "each SKU once")
    .refine((lines) => lines.reduce((sum, line) => sum + line.quantity, 0) <= orderLimits.unitsPerOrder, "too many units"),
});

const commandBody = z.discriminatedUnion("type", [
  z.strictObject({ commandId: uuid, type: z.literal("CLAIM_ORDER"), ...expected, payload: z.strictObject({ toteId: z.string().min(1).max(16).nullable() }) }),
  z.strictObject({
    commandId: uuid,
    type: z.literal("CONFIRM_TASK"),
    ...expected,
    payload: z.strictObject({
      taskToken: z.string().min(1).max(200),
      kind: z.enum(["PICK", "RETURN"]),
      lineId: uuid,
      quantity: z.number().int().min(1).max(10_000),
    }),
  }),
  z.strictObject({ commandId: uuid, type: z.enum(["COMPLETE_ORDER", "ACK_REVISION", "PAUSE_ORDER", "RESUME_ORDER", "CLOSE_CANCELLED", "PREPARE_RELEASE", "CANCEL_RELEASE", "RELEASE_ORDER"]), ...expected, payload: z.strictObject({}) }),
  z.strictObject({ commandId: uuid, type: z.literal("ACK_RESOLUTION"), ...expected, payload: z.strictObject({ exceptionId: uuid }) }),
  z.strictObject({
    commandId: uuid,
    type: z.literal("REPORT_EXCEPTION"),
    ...expected,
    payload: z.strictObject({
      type: z.enum(["SHORTAGE", "DAMAGED", "LOCATION_MISMATCH", "RETURN_BLOCKED", "OTHER"]),
      reportedQty: z.number().int().min(0).max(10_000).nullable(),
    }),
  }),
]);

/** buildHttp assembles the API without listening, so tests can inject requests. */
export function buildHttp(options: HttpOptions): FastifyInstance {
  const limiter = new Limiter();
  // Answers 429 with Retry-After and returns false when key is over its limit.
  const allow = (request: FastifyRequest, reply: FastifyReply, key: string, limit: Limit): boolean => {
    const result = limiter.take(key, limit);
    if (result.ok) return true;
    reply.header("retry-after", String(result.retryAfter_s));
    fail(reply, request, 429, "RATE_LIMITED");
    return false;
  };

  const app = Fastify({
    trustProxy: options.trustProxy ?? false,
    bodyLimit: 64 * 1024,
    genReqId: () => randomUUID(),
    logger: options.logger ? { redact: ["req.headers.authorization"] } : false,
  });

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && options.corsAllowedOrigins.includes(origin)) {
      reply.header("access-control-allow-origin", origin).header("vary", "origin");
      reply.header("access-control-allow-headers", "authorization, content-type, x-pairing-secret");
      reply.header("access-control-allow-methods", "GET, POST");
    }
    if (request.method === "OPTIONS") return reply.code(204).send();
  });

  app.setErrorHandler((error: { statusCode?: number }, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) request.log.error({ err: error }, "request failed");
    const code = status === 413 ? "PAYLOAD_TOO_LARGE" : status < 500 ? "INVALID_INPUT" : "INTERNAL_ERROR";
    return fail(reply, request, status, code);
  });

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (request, reply) => {
    try {
      await options.pool.query("select 1");
      return { status: "ok" };
    } catch {
      return fail(reply, request, 503, "SERVICE_UNAVAILABLE");
    }
  });

  app.post("/v1/telegram/miniapp/session", async (request, reply) => {
    if (!allow(request, reply, `signin:${request.ip}`, limits.signIn)) return reply;
    if (!options.botToken) return fail(reply, request, 503, "SERVICE_UNAVAILABLE");
    const parsed = z.strictObject({ initData: z.string().min(1).max(4096) }).safeParse(request.body);
    if (!parsed.success) return fail(reply, request, 400, "INVALID_INPUT");
    const check = verifyLaunchData(parsed.data.initData, options.botToken, Math.floor(options.now().getTime() / 1000));
    if (!check.ok) return fail(reply, request, 401, "AUTH_REQUIRED");
    const session = await startSession(options.pool, check.user);
    return ok(reply, request, { ...session, user: check.user, memberships: await memberships(options.pool, check.user.id) });
  });

  app.get("/v1/me", async (request, reply) => {
    const telegramUserId = await miniAppUser(request, reply, options.pool);
    if (!telegramUserId) return reply;
    return ok(reply, request, { telegramUserId, memberships: await memberships(options.pool, telegramUserId) });
  });

  // Pairing. The glasses call start, poll state and exchange with the secret;
  // a signed-in picker approves from the Mini App.
  app.post("/v1/devices/pairings", async (request, reply) => {
    if (!allow(request, reply, `pair:${request.ip}`, limits.pairingStart)) return reply;
    const parsed = z.strictObject({ label: z.string().trim().min(1).max(60) }).safeParse(request.body);
    if (!parsed.success) return fail(reply, request, 400, "INVALID_INPUT");
    return ok(reply, request, await devices.start(options.pool, parsed.data.label));
  });

  app.get<{ Params: { pid: string } }>("/v1/devices/pairings/:pid", async (request, reply) => {
    const secret = request.headers["x-pairing-secret"];
    if (!uuid.safeParse(request.params.pid).success || typeof secret !== "string") return fail(reply, request, 404, "NOT_FOUND");
    const found = await devices.state(options.pool, request.params.pid, secret);
    return found ? ok(reply, request, { status: found }) : fail(reply, request, 404, "NOT_FOUND");
  });

  app.post<{ Params: { pid: string } }>("/v1/devices/pairings/:pid/exchange", async (request, reply) => {
    const secret = request.headers["x-pairing-secret"];
    if (!uuid.safeParse(request.params.pid).success || typeof secret !== "string") return fail(reply, request, 404, "NOT_FOUND");
    const result = await devices.exchange(options.pool, request.params.pid, secret);
    if (result.ok) return ok(reply, request, { token: result.token, workspaceId: result.workspaceId, expiresAt: result.expiresAt });
    return fail(reply, request, result.code === "NOT_FOUND" ? 404 : 409, result.code);
  });

  app.post("/v1/devices/pairings/approve", async (request, reply) => {
    if (!allow(request, reply, `approve:${request.ip}`, limits.pairingApprove)) return reply;
    const telegramUserId = await miniAppUser(request, reply, options.pool);
    if (!telegramUserId) return reply;
    if (!allow(request, reply, `approve-user:${telegramUserId}`, limits.pairingApprove)) return reply;
    const parsed = z.strictObject({ workspaceId: uuid, code: z.string().min(8).max(16) }).safeParse(request.body);
    if (!parsed.success) return fail(reply, request, 400, "INVALID_INPUT");
    const result = await devices.approve(options.pool, telegramUserId, parsed.data.workspaceId, parsed.data.code);
    if (result.ok) return ok(reply, request, { label: result.label });
    return fail(reply, request, result.code === "PAIRING_EXPIRED" ? 410 : result.code === "ROLE_REQUIRED" ? 403 : 404, result.code);
  });

  // The coordinator console in the Mini App: the same command runner, roles
  // and engine checks as Telegram, reached with a Mini App session.
  app.get<{ Params: { wid: string }; Querystring: { view?: string; q?: string; cursor?: string } }>("/v1/workspaces/:wid/orders", async (request, reply) => {
    const actor = await coordinator(request, reply, options.pool);
    if (!actor) return reply;
    const view = z.enum(["needs_you", "active", "done"]).catch("active").parse(request.query.view);
    const search = request.query.q?.trim().slice(0, 40) || null;
    const after = request.query.cursor === undefined ? null : parseCursor(request.query.cursor);
    if (after === undefined) return fail(reply, request, 400, "INVALID_CURSOR");
    const page = await listOrders(options.pool, actor.workspaceId, { view, search, after });
    return ok(reply, request, { view, orders: page.orders, next: page.next && Buffer.from(JSON.stringify(page.next)).toString("base64url") });
  });

  app.get<{ Params: { wid: string; oid: string } }>("/v1/workspaces/:wid/orders/:oid", async (request, reply) => {
    const actor = await coordinator(request, reply, options.pool);
    if (!actor) return reply;
    const detail = uuid.safeParse(request.params.oid).success ? await orderDetail(options.pool, actor.workspaceId, request.params.oid) : null;
    return detail ? ok(reply, request, detail) : fail(reply, request, 404, "NOT_FOUND");
  });

  app.post<{ Params: { wid: string } }>("/v1/workspaces/:wid/orders", async (request, reply) => {
    const actor = await coordinator(request, reply, options.pool);
    if (!actor) return reply;
    if (!allow(request, reply, `create:${actor.memberId}`, limits.commands)) return reply;
    const parsed = newOrderBody.safeParse(request.body);
    if (!parsed.success) return fail(reply, request, 400, "INVALID_INPUT");
    const result = await createOrderOnce(options.pool, actor, parsed.data.commandId, { ref: parsed.data.ref, lines: parsed.data.lines });
    if (result.status !== 200) return fail(reply, request, result.status, result.body.code);
    return ok(reply, request, result.body);
  });

  // Reports and the order history export, over whole days in the viewer's time zone.
  type RangeQuery = { Params: { wid: string }; Querystring: { from?: string; to?: string; tz?: string } };
  const reportRange = (request: FastifyRequest<RangeQuery>) => reports.parseRange(request.query.from ?? "", request.query.to ?? "", request.query.tz ?? "");

  app.get<RangeQuery>("/v1/workspaces/:wid/reports", async (request, reply) => {
    const actor = await coordinator(request, reply, options.pool);
    if (!actor) return reply;
    if (!allow(request, reply, `read:${actor.memberId}`, limits.reads)) return reply;
    const range = reportRange(request);
    if (!range) return fail(reply, request, 400, "INVALID_RANGE");
    return ok(reply, request, await reports.report(options.pool, actor.workspaceId, range));
  });

  app.get<RangeQuery>("/v1/workspaces/:wid/reports/orders.csv", async (request, reply) => {
    const actor = await coordinator(request, reply, options.pool);
    if (!actor) return reply;
    if (!allow(request, reply, `import:${actor.memberId}`, limits.imports)) return reply;
    const range = reportRange(request);
    if (!range) return fail(reply, request, 400, "INVALID_RANGE");
    const csv = await reports.ordersCsv(options.pool, actor.workspaceId, range);
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="stow-orders-${range.from}-to-${range.to}.csv"`)
      .header("cache-control", "no-store")
      .send(csv);
  });

  // Paired glasses and what each picker holds. Read-only: ending a session is
  // the owner's Revoke on the Team page.
  app.get<{ Params: { wid: string } }>("/v1/workspaces/:wid/sessions", async (request, reply) => {
    const actor = await coordinator(request, reply, options.pool);
    if (!actor) return reply;
    return ok(reply, request, { sessions: await sessions(options.pool, actor.workspaceId) });
  });

  // Settings: anyone on the console can read them; only owners change them.
  app.get<{ Params: { wid: string } }>("/v1/workspaces/:wid/settings", async (request, reply) => {
    const actor = await coordinator(request, reply, options.pool);
    if (!actor) return reply;
    return ok(reply, request, await workspaceSettings.settings(options.pool, actor.workspaceId));
  });

  app.post<{ Params: { wid: string } }>("/v1/workspaces/:wid/settings", async (request, reply) => {
    const actor = await coordinator(request, reply, options.pool);
    if (!actor) return reply;
    if (!allow(request, reply, `command:${actor.memberId}`, limits.commands)) return reply;
    const parsed = z
      .object({ timeZone: z.string().max(64).refine(workspaceSettings.isTimeZone), retentionDays: z.union([z.literal(90), z.literal(365), z.null()]) })
      .safeParse(request.body);
    if (!parsed.success) return fail(reply, request, 400, "INVALID_INPUT");
    const result = await workspaceSettings.changeSettings(options.pool, actor, parsed.data);
    return result.ok ? ok(reply, request, result.settings) : fail(reply, request, 403, result.code);
  });

  // The onboarding checklist, read from the data so it resumes anywhere.
  app.get<{ Params: { wid: string } }>("/v1/workspaces/:wid/setup", async (request, reply) => {
    const actor = await coordinator(request, reply, options.pool);
    if (!actor) return reply;
    return ok(reply, request, await setup(options.pool, actor.workspaceId));
  });

  // The Telegram page: which groups drive the workspace, and whether sending works.
  app.get<{ Params: { wid: string } }>("/v1/workspaces/:wid/telegram", async (request, reply) => {
    const actor = await coordinator(request, reply, options.pool);
    if (!actor) return reply;
    return ok(reply, request, await connections.listGroups(options.pool, actor.workspaceId));
  });

  app.post<{ Params: { wid: string; cid: string } }>("/v1/workspaces/:wid/telegram/groups/:cid/disconnect", async (request, reply) => {
    const actor = await coordinator(request, reply, options.pool);
    if (!actor) return reply;
    if (!allow(request, reply, `command:${actor.memberId}`, limits.commands)) return reply;
    if (!uuid.safeParse(request.params.cid).success) return fail(reply, request, 404, "NOT_FOUND");
    const result = await connections.disconnectGroup(options.pool, actor, request.params.cid);
    return result.ok ? ok(reply, request, { disconnected: true }) : fail(reply, request, result.code === "ROLE_REQUIRED" ? 403 : 404, result.code);
  });

  // The Workers page: everyone can see the team; only owners change it.
  app.get<{ Params: { wid: string } }>("/v1/workspaces/:wid/members", async (request, reply) => {
    const actor = await coordinator(request, reply, options.pool);
    if (!actor) return reply;
    return ok(reply, request, { members: await members.listMembers(options.pool, actor) });
  });

  const memberChange = async (
    request: FastifyRequest<{ Params: { wid: string; mid: string } }>,
    reply: FastifyReply,
    run: (actor: Actor, memberId: string) => Promise<members.Change>,
  ) => {
    const actor = await coordinator(request, reply, options.pool);
    if (!actor) return reply;
    if (!allow(request, reply, `command:${actor.memberId}`, limits.commands)) return reply;
    if (!uuid.safeParse(request.params.mid).success) return fail(reply, request, 404, "NOT_FOUND");
    const result = await run(actor, request.params.mid);
    if (result.ok) return ok(reply, request, { changed: true });
    const status = { ROLE_REQUIRED: 403, NOT_FOUND: 404, LAST_OWNER: 409, HOLDS_ORDERS: 409, NO_CHANGE: 409 }[result.code];
    return fail(reply, request, status, result.code);
  };

  app.post<{ Params: { wid: string; mid: string } }>("/v1/workspaces/:wid/members/:mid/role", async (request, reply) => {
    const parsed = z.strictObject({ role: z.enum(["OWNER", "COORDINATOR", "PICKER"]) }).safeParse(request.body);
    if (!parsed.success) return fail(reply, request, 400, "INVALID_INPUT");
    return memberChange(request, reply, (actor, memberId) => members.changeRole(options.pool, actor, memberId, parsed.data.role));
  });

  app.post<{ Params: { wid: string; mid: string } }>("/v1/workspaces/:wid/members/:mid/devices/revoke", (request, reply) =>
    memberChange(request, reply, (actor, memberId) => members.revokeDevices(options.pool, actor, memberId)),
  );

  app.post<{ Params: { wid: string; mid: string } }>("/v1/workspaces/:wid/members/:mid/remove", (request, reply) =>
    memberChange(request, reply, (actor, memberId) => members.removeMember(options.pool, actor, memberId)),
  );

  app.get<{ Params: { wid: string } }>("/v1/workspaces/:wid/pickers", async (request, reply) => {
    const actor = await coordinator(request, reply, options.pool);
    if (!actor) return reply;
    return ok(reply, request, { pickers: await pickers(options.pool, actor.workspaceId) });
  });

  app.post<{ Params: { wid: string; oid: string } }>("/v1/workspaces/:wid/orders/:oid/notes", async (request, reply) => {
    const actor = await coordinator(request, reply, options.pool);
    if (!actor) return reply;
    const parsed = z.strictObject({ body: z.string().trim().min(1).max(280) }).safeParse(request.body);
    if (!parsed.success || !uuid.safeParse(request.params.oid).success) return fail(reply, request, 400, "INVALID_INPUT");
    const posted = await postNote(options.pool, actor.workspaceId, request.params.oid, actor.memberId, parsed.data.body);
    return posted === "POSTED" ? ok(reply, request, { posted: true }) : fail(reply, request, 409, "TERMINAL_ORDER");
  });

  // Catalogue import: preview first, then commit the same text all or nothing.
  const importBody = z.strictObject({ csv: z.string().min(1).max(catalogue.importLimits.bytes), allowUpdates: z.boolean().default(false) });
  const importLimit_bytes = catalogue.importLimits.bytes + 64 * 1024;

  app.get<{ Params: { wid: string } }>("/v1/workspaces/:wid/catalogue", async (request, reply) => {
    const actor = await coordinator(request, reply, options.pool);
    if (!actor) return reply;
    return ok(reply, request, { products: await catalogue.products(options.pool, actor.workspaceId) });
  });

  app.get<{ Params: { wid: string } }>("/v1/workspaces/:wid/catalogue.csv", async (request, reply) => {
    const actor = await coordinator(request, reply, options.pool);
    if (!actor) return reply;
    if (!allow(request, reply, `import:${actor.memberId}`, limits.imports)) return reply;
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", 'attachment; filename="stow-catalogue.csv"')
      .header("cache-control", "no-store")
      .send(await catalogue.catalogueCsv(options.pool, actor.workspaceId));
  });

  app.post<{ Params: { wid: string } }>("/v1/workspaces/:wid/catalogue/preview", { bodyLimit: importLimit_bytes }, async (request, reply) => {
    const actor = await coordinator(request, reply, options.pool);
    if (!actor) return reply;
    if (!allow(request, reply, `import:${actor.memberId}`, limits.imports)) return reply;
    const parsed = importBody.safeParse(request.body);
    if (!parsed.success) return fail(reply, request, 400, "INVALID_INPUT");
    return ok(reply, request, await catalogue.preview(options.pool, actor.workspaceId, parsed.data.csv));
  });

  app.post<{ Params: { wid: string } }>("/v1/workspaces/:wid/catalogue/commit", { bodyLimit: importLimit_bytes }, async (request, reply) => {
    const actor = await coordinator(request, reply, options.pool);
    if (!actor) return reply;
    if (!allow(request, reply, `import:${actor.memberId}`, limits.imports)) return reply;
    const parsed = importBody.safeParse(request.body);
    if (!parsed.success) return fail(reply, request, 400, "INVALID_INPUT");
    const result = await catalogue.commit(options.pool, actor.workspaceId, parsed.data.csv, parsed.data.allowUpdates);
    if (result.ok) return ok(reply, request, result);
    return reply.code(422).send({
      error: { code: result.code, message: messages[result.code] ?? result.code, retryable: false, details: "errors" in result ? { errors: result.errors } : { skus: result.skus } },
      meta: meta(request),
    });
  });

  app.post<{ Params: { wid: string } }>("/v1/workspaces/:wid/console/commands", async (request, reply) => {
    const actor = await coordinator(request, reply, options.pool);
    if (!actor) return reply;
    if (!allow(request, reply, `command:${actor.memberId}`, limits.commands)) return reply;
    const parsed = consoleCommandBody.safeParse(request.body);
    if (!parsed.success) return fail(reply, request, 400, "INVALID_INPUT");
    const body = parsed.data;
    const base = { orderId: body.orderId, revision: body.expectedRevision, version: body.expectedVersion };
    const command: Command =
      body.type === "REVISE_ORDER" ? { type: "REVISE_ORDER", ...base, reason: body.payload.reason, changes: body.payload.changes }
      : body.type === "REQUEST_CANCEL" ? { type: "REQUEST_CANCEL", ...base, reason: body.payload.reason }
      : body.type === "ASSIGN_ORDER" ? { type: "ASSIGN_ORDER", ...base, memberId: body.payload.memberId }
      : { type: "RESOLVE_EXCEPTION", ...base, reason: body.payload.reason, resolution: body.payload.resolution };
    const result = await runCommand(options.pool, actor, body.commandId, command);
    if (result.status !== 200) return fail(reply, request, result.status, result.body.code);
    return ok(reply, request, { commandId: body.commandId, ...result.body });
  });

  app.get<{ Params: { wid: string } }>("/v1/workspaces/:wid/worker/snapshot", async (request, reply) => {
    const device = await authenticate(request, reply, options.pool);
    if (!device) return reply;
    if (!allow(request, reply, `read:${device.memberId}`, limits.reads)) return reply;
    const view = await workerView(options.pool, device.workspaceId, device.memberId);
    const plan =
      view.plan.kind === "TASK"
        ? { ...taskJson(view.plan.task, view.order!), taskToken: signTask(options.taskTokenSecret, device.memberId, view.plan.task) }
        : view.plan;
    return ok(reply, request, {
      workspaceId: device.workspaceId,
      cursor: view.cursor,
      order: view.order && orderJson(view.order),
      plan,
      totes: view.totes,
      batchOffer: view.batchOffer,
      changes: view.changes,
      decision: view.decision,
      lastCompleted: view.lastCompleted,
      note: view.note,
      quickReplies,
    });
  });

  app.post<{ Params: { wid: string; mid: string } }>("/v1/workspaces/:wid/messages/:mid/read", async (request, reply) => {
    const device = await authenticate(request, reply, options.pool);
    if (!device) return reply;
    if (!uuid.safeParse(request.params.mid).success) return fail(reply, request, 404, "NOT_FOUND");
    return (await markRead(options.pool, device, request.params.mid)) ? ok(reply, request, { read: true }) : fail(reply, request, 404, "NOT_FOUND");
  });

  app.post<{ Params: { wid: string } }>("/v1/workspaces/:wid/replies", async (request, reply) => {
    const device = await authenticate(request, reply, options.pool);
    if (!device) return reply;
    if (!allow(request, reply, `reply:${device.memberId}`, limits.replies)) return reply;
    const parsed = z.strictObject({ clientId: uuid, orderId: uuid, replyId: z.string().max(20) }).safeParse(request.body);
    if (!parsed.success) return fail(reply, request, 400, "INVALID_INPUT");
    const result = await sendReply(options.pool, device, parsed.data.orderId, parsed.data.clientId, parsed.data.replyId);
    if (result === "SENT") return ok(reply, request, { sent: true, delivery: "PENDING" });
    return fail(reply, request, result === "UNKNOWN_REPLY" ? 400 : 409, result);
  });

  app.post<{ Params: { wid: string } }>("/v1/workspaces/:wid/commands", async (request, reply) => {
    const device = await authenticate(request, reply, options.pool);
    if (!device) return reply;
    if (!allow(request, reply, `command:${device.memberId}`, limits.commands)) return reply;
    const parsed = commandBody.safeParse(request.body);
    if (!parsed.success) return fail(reply, request, 400, "INVALID_INPUT");
    const body = parsed.data;
    const base = { orderId: body.orderId, revision: body.expectedRevision, version: body.expectedVersion };
    let command: Command;
    switch (body.type) {
      case "CONFIRM_TASK": {
        const shown = { orderId: body.orderId, lineId: body.payload.lineId, kind: body.payload.kind, revision: body.expectedRevision, version: body.expectedVersion };
        if (!verifyTask(options.taskTokenSecret, device.memberId, shown, body.payload.taskToken)) {
          return fail(reply, request, 409, "TASK_CHANGED");
        }
        command = { type: "CONFIRM_TASK", ...base, kind: body.payload.kind, lineId: body.payload.lineId, quantity: body.payload.quantity };
        break;
      }
      case "CLAIM_ORDER":
        command = { type: "CLAIM_ORDER", ...base, toteId: body.payload.toteId };
        break;
      case "ACK_RESOLUTION":
        command = { type: "ACK_RESOLUTION", ...base, exceptionId: body.payload.exceptionId };
        break;
      case "REPORT_EXCEPTION":
        command = { type: "REPORT_EXCEPTION", ...base, exceptionType: body.payload.type, reportedQty: body.payload.reportedQty };
        break;
      default:
        command = { type: body.type, ...base };
    }
    const result = await runCommand(options.pool, device, body.commandId, command);
    if (result.status !== 200) return fail(reply, request, result.status, result.body.code);
    // Telegram delivery is asynchronous; the physical action is already saved.
    return ok(reply, request, { commandId: body.commandId, ...result.body, delivery: "PENDING" });
  });

  app.post<{ Params: { wid: string } }>("/v1/workspaces/:wid/batches", async (request, reply) => {
    const device = await authenticate(request, reply, options.pool);
    if (!device) return reply;
    if (!allow(request, reply, `command:${device.memberId}`, limits.commands)) return reply;
    const parsed = z
      .strictObject({ commandId: uuid, orders: z.array(z.strictObject({ orderId: uuid, expectedRevision: expected.expectedRevision, expectedVersion: counter })).max(10) })
      .safeParse(request.body);
    if (!parsed.success) return fail(reply, request, 400, "INVALID_INPUT");
    const shown = parsed.data.orders.map((order) => ({ orderId: order.orderId, revision: order.expectedRevision, version: order.expectedVersion }));
    const result = await startBatch(options.pool, device, parsed.data.commandId, shown);
    if (result.status !== 200) return fail(reply, request, result.status, result.body.code);
    return ok(reply, request, { commandId: parsed.data.commandId, ...result.body, delivery: "PENDING" });
  });

  return app;
}

// Resolves the bearer token to a live device in the workspace named by the
// path. A token for another workspace gets the same 404 as a missing one, so
// IDs from other tenants reveal nothing.
async function authenticate(request: FastifyRequest<{ Params: { wid: string } }>, reply: FastifyReply, pool: pg.Pool): Promise<Device | null> {
  const header = request.headers.authorization ?? "";
  const token = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(header)?.[1];
  if (!token) {
    fail(reply, request, 401, "AUTH_REQUIRED");
    return null;
  }
  // Recording presence rides on the same round trip, at most every 30 seconds.
  const { rows } = await pool.query<{ workspace_id: string; member_id: string; role: Role }>(
    `with live as (
       select d.id, d.workspace_id, d.member_id, m.role, d.last_seen_at from device_tokens d join members m on m.workspace_id = d.workspace_id and m.id = d.member_id
       where d.token_hash = $1 and d.revoked_at is null and d.expires_at > now() and m.role in ('PICKER', 'OWNER')
     ), seen as (
       update device_tokens set last_seen_at = now()
       where id in (select id from live where last_seen_at is null or last_seen_at < now() - interval '30 seconds')
     )
     select workspace_id, member_id, role from live`,
    [hashToken(token)],
  );
  const device = rows[0];
  if (!device) {
    fail(reply, request, 401, "AUTH_REQUIRED");
    return null;
  }
  if (device.workspace_id !== request.params.wid) {
    fail(reply, request, 404, "NOT_FOUND");
    return null;
  }
  return { workspaceId: device.workspace_id, memberId: device.member_id, role: device.role };
}

// Mini App requests carry their session as a bearer token, like devices, but
// resolve to a Telegram account; workspace access is checked per route.
async function miniAppUser(request: FastifyRequest, reply: FastifyReply, pool: pg.Pool): Promise<string | null> {
  const token = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(request.headers.authorization ?? "")?.[1];
  const user = token ? await sessionUser(pool, token) : null;
  if (!user) fail(reply, request, 401, "AUTH_REQUIRED");
  return user;
}

// A Mini App session acting as a coordinator or owner in the workspace named
// by the path. Anyone else gets the same 404 as a workspace that does not exist.
async function coordinator(request: FastifyRequest<{ Params: { wid: string } }>, reply: FastifyReply, pool: pg.Pool): Promise<Actor | null> {
  const telegramUserId = await miniAppUser(request, reply, pool);
  if (!telegramUserId) return null;
  const membership = (await memberships(pool, telegramUserId)).find((m) => m.workspaceId === request.params.wid);
  if (!membership || (membership.role !== "COORDINATOR" && membership.role !== "OWNER")) {
    fail(reply, request, 404, "NOT_FOUND");
    return null;
  }
  return { workspaceId: membership.workspaceId, memberId: membership.memberId, role: membership.role };
}

// A cursor is opaque to clients: base64url JSON of the last row's sort key.
// undefined means it did not parse, as distinct from no cursor at all.
function parseCursor(raw: string): Cursor | undefined {
  try {
    const parsed = z.object({ updatedAt: z.iso.datetime(), id: z.uuid() }).safeParse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** hashToken is how device tokens are stored and looked up. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// The token names which task was shown, not how many units: a partial
// confirmation is legitimate, and the engine bounds the quantity.
type ShownTask = Pick<Task, "orderId" | "lineId" | "kind" | "revision" | "version">;

function signTask(secret: string, workerId: string, task: ShownTask): string {
  const message = [workerId, task.orderId, task.lineId, task.kind, task.revision, task.version].join(":");
  return createHmac("sha256", secret).update(message).digest("base64url");
}

function verifyTask(secret: string, workerId: string, shown: ShownTask, token: string): boolean {
  const expectedToken = Buffer.from(signTask(secret, workerId, shown));
  const given = Buffer.from(token);
  return expectedToken.length === given.length && timingSafeEqual(expectedToken, given);
}

function orderJson(order: Order) {
  return {
    id: order.id,
    ref: order.ref,
    revision: order.revision,
    version: String(order.version),
    terminal: order.terminal,
    isCancelRequested: order.isCancelRequested,
    isReleaseRequested: order.isReleaseRequested,
    toteId: order.assignment?.toteId ?? null,
    lines: order.lines.map((line) => ({
      id: line.id,
      sku: line.sku,
      name: line.name,
      bin: line.bin,
      requested: line.requested,
      picked: line.picked,
      outstandingPick: outstandingPick(line),
      outstandingReturn: outstandingReturn(line),
    })),
  };
}

function taskJson(task: Task, order: Order) {
  const line = order.lines.find((candidate) => candidate.id === task.lineId)!;
  const requested = order.lines.reduce((sum, candidate) => sum + candidate.requested, 0);
  const confirmed = order.lines.reduce((sum, candidate) => sum + Math.min(candidate.picked, candidate.requested), 0);
  return {
    kind: "TASK" as const,
    task: { ...task, version: String(task.version), orderRef: order.ref, sku: line.sku, name: line.name, bin: line.bin, toteId: order.assignment?.toteId ?? null },
    progress: { confirmed, requested },
  };
}

function meta(request: FastifyRequest) {
  return { requestId: request.id, serverTime: new Date().toISOString() };
}

function ok(reply: FastifyReply, request: FastifyRequest, data: unknown) {
  return reply.code(200).send({ data, meta: meta(request) });
}

function fail(reply: FastifyReply, request: FastifyRequest, status: number, code: string) {
  const retryable = status >= 500 || status === 429;
  return reply.code(status).send({ error: { code, message: messages[code] ?? code, retryable }, meta: meta(request) });
}

const messages: Record<string, string> = {
  AUTH_REQUIRED: "sign in again: the device token is missing, expired or revoked",
  NOT_FOUND: "not found",
  INVALID_INPUT: "the request does not match the expected shape",
  TASK_CHANGED: "not saved: the task changed, refresh and recheck the tote",
  STALE_VERSION: "not saved: the order changed, refresh and recheck the tote",
  REVISION_REQUIRED: "not saved: the order was revised, acknowledge the change first",
  ASSIGNMENT_CONFLICT: "this order belongs to someone else",
  QUANTITY_OUT_OF_RANGE: "the quantity is outside what this task needs",
  ROLE_REQUIRED: "your role cannot do this",
  REF_TAKEN: "another order already uses that reference",
  INVALID_RANGE: "choose dates as YYYY-MM-DD, from no later than to, at most 366 days, with a valid time zone",
  INVALID_CURSOR: "the page cursor is not one this server issued; load the list from the start",
  LAST_OWNER: "a workspace needs at least one owner; make someone else owner first",
  HOLDS_ORDERS: "this person still holds open orders; release or reassign them first",
  NOT_A_PICKER: "orders can only be assigned to pickers in this workspace",
  BATCH_SIZE: "a batch holds 2 to 5 different orders",
  PAIRING_EXPIRED: "that code has expired; the glasses will show a new one",
  NOT_APPROVED: "not approved yet",
  NOT_ASSIGNED: "only the picker on this order can reply on it",
  UNKNOWN_REPLY: "that quick reply does not exist",
  ALREADY_EXCHANGED: "this pairing has already been used",
  OPEN_EXCEPTION: "a problem is already reported on this order",
  UNKNOWN_SKU: "that SKU is not in the catalogue",
  NO_CHANGE: "nothing changed",
  RATE_LIMITED: "too many requests; wait and try again",
  IMPORT_ERRORS: "the file has errors; fix the rows listed and try again",
  UPDATES_NOT_ALLOWED: "the file changes existing products; confirm updates to apply it",
  DUPLICATE_SKU: "that SKU is already in the order",
  ORDER_TOO_LARGE: "the order is over the size limit",
  IDEMPOTENCY_CONFLICT: "this command ID was already used for a different request",
  TERMINAL_ORDER: "the order is already closed",
  INVALID_TRANSITION: "that action is not available now",
  PAYLOAD_TOO_LARGE: "the request body is too large",
  SERVICE_UNAVAILABLE: "the service is not ready",
  INTERNAL_ERROR: "something went wrong; retry with the same command ID",
};
