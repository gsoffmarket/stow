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

export type HttpOptions = {
  readonly pool: pg.Pool;
  readonly taskTokenSecret: string;
  readonly corsAllowedOrigins: readonly string[];
  readonly logger: boolean;
};

type Device = { readonly workspaceId: string; readonly memberId: string; readonly role: Role };

const uuid = z.uuid();
const counter = z.string().regex(/^[0-9]{1,18}$/).transform(Number);
const expected = { orderId: uuid, expectedRevision: z.number().int().min(1), expectedVersion: counter };
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
  const app = Fastify({
    bodyLimit: 64 * 1024,
    genReqId: () => randomUUID(),
    logger: options.logger ? { redact: ["req.headers.authorization"] } : false,
  });

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && options.corsAllowedOrigins.includes(origin)) {
      reply.header("access-control-allow-origin", origin).header("vary", "origin");
      reply.header("access-control-allow-headers", "authorization, content-type");
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

  app.get<{ Params: { wid: string } }>("/v1/workspaces/:wid/worker/snapshot", async (request, reply) => {
    const device = await authenticate(request, reply, options.pool);
    if (!device) return reply;
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
    });
  });

  app.post<{ Params: { wid: string } }>("/v1/workspaces/:wid/commands", async (request, reply) => {
    const device = await authenticate(request, reply, options.pool);
    if (!device) return reply;
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
  OPEN_EXCEPTION: "a problem is already reported on this order",
  UNKNOWN_SKU: "that SKU is not in the catalogue",
  NO_CHANGE: "nothing changed",
  DUPLICATE_SKU: "that SKU is already in the order",
  ORDER_TOO_LARGE: "the order is over the size limit",
  IDEMPOTENCY_CONFLICT: "this command ID was already used for a different request",
  TERMINAL_ORDER: "the order is already closed",
  INVALID_TRANSITION: "that action is not available now",
  PAYLOAD_TOO_LARGE: "the request body is too large",
  SERVICE_UNAVAILABLE: "the service is not ready",
  INTERNAL_ERROR: "something went wrong; retry with the same command ID",
};
