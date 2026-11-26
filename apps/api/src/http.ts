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
import { outstandingPick, outstandingReturn, type Order, type Task } from "@stow/order-engine";
import { runCommand, workerView, type Command, type Role } from "./fulfilment.ts";
import * as devices from "./devices.ts";
import { markRead, postNote, quickReplies, sendReply } from "./messages.ts";
import { listOrders, orderDetail } from "./console.ts";
import * as catalogue from "./catalogue.ts";
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
  z.strictObject({ commandId: uuid, type: z.enum(["COMPLETE_ORDER", "ACK_REVISION", "PAUSE_ORDER", "RESUME_ORDER", "CLOSE_CANCELLED"]), ...expected, payload: z.strictObject({}) }),
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
  app.get<{ Params: { wid: string }; Querystring: { view?: string } }>("/v1/workspaces/:wid/orders", async (request, reply) => {
    const actor = await coordinator(request, reply, options.pool);
    if (!actor) return reply;
    const view = z.enum(["needs_you", "active", "done"]).catch("active").parse(request.query.view);
    return ok(reply, request, { view, orders: await listOrders(options.pool, actor.workspaceId, view) });
  });

  app.get<{ Params: { wid: string; oid: string } }>("/v1/workspaces/:wid/orders/:oid", async (request, reply) => {
    const actor = await coordinator(request, reply, options.pool);
    if (!actor) return reply;
    const detail = uuid.safeParse(request.params.oid).success ? await orderDetail(options.pool, actor.workspaceId, request.params.oid) : null;
    return detail ? ok(reply, request, detail) : fail(reply, request, 404, "NOT_FOUND");
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
  const { rows } = await pool.query<{ workspace_id: string; member_id: string; role: Role }>(
    `select d.workspace_id, d.member_id, m.role from device_tokens d join members m on m.workspace_id = d.workspace_id and m.id = d.member_id
     where d.token_hash = $1 and d.revoked_at is null and d.expires_at > now() and m.role in ('PICKER', 'OWNER')`,
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
