// Calls to the Stow API from the Mini App. The session comes from exchanging
// Telegram's launch data and lives only in memory: reopening the Mini App
// brings fresh launch data, so nothing sensitive is kept in browser storage.

const apiUrl = import.meta.env.VITE_STOW_API_URL as string;

export type Role = "OWNER" | "COORDINATOR" | "PICKER" | "VIEWER";

export type Membership = { workspaceId: string; workspaceName: string; memberId: string; role: Role; displayName: string };

export type Session = { token: string; user: { id: string; firstName: string }; memberships: Membership[] };

/** ApiError carries the API's stable error code; the UI never parses messages. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(`${status} ${code}`);
    this.status = status;
    this.code = code;
  }
}

async function call<T>(path: string, init: { method: "GET" | "POST"; token?: string; body?: object }): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      method: init.method,
      headers: {
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : null,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ApiError(0, "NETWORK");
  }
  const payload = (await response.json().catch(() => null)) as { data?: T; error?: { code: string } } | null;
  if (!response.ok || !payload?.data) throw new ApiError(response.status, payload?.error?.code ?? "UNKNOWN");
  return payload.data;
}

export function signIn(initData: string): Promise<Session> {
  return call("/v1/telegram/miniapp/session", { method: "POST", body: { initData } });
}

export function approvePairing(token: string, workspaceId: string, code: string): Promise<{ label: string }> {
  return call("/v1/devices/pairings/approve", { method: "POST", token, body: { workspaceId, code } });
}

export type Hold = "NONE" | "AWAITING_PICKER" | "BLOCKED" | "CANCELLING" | "RELEASING" | "PAUSED";

export type OrderRow = {
  id: string;
  ref: string;
  terminal: "COMPLETED" | "CANCELLED" | null;
  hold: Hold;
  picker: string | null;
  toteId: string | null;
  confirmed: number;
  requested: number;
  lines: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type View = "needs_you" | "active" | "done";

export type OrderDetail = {
  order: OrderRow & { version: string };
  lines: { id: string; sku: string; name: string; bin: string | null; requested: number; picked: number }[];
  exception: { id: string; type: string; lineId: string | null; sku: string | null; reportedQty: number | null; status: string } | null;
  timeline: { seq: string; type: string; actor: string | null; at: string; detail: string | null }[];
  messages: { direction: "TO_PICKER" | "TO_GROUP"; body: string; author: string; at: string; isRead: boolean }[];
};

export type Resolution = { kind: "RESUME" } | { kind: "REDUCE"; quantity: number } | { kind: "CANCEL" };

export type ConsoleCommand =
  | { type: "REVISE_ORDER"; payload: { reason: string; changes: { kind: "SET_QUANTITY"; lineId: string; quantity: number }[] } }
  | { type: "REQUEST_CANCEL"; payload: { reason: string } }
  | { type: "RESOLVE_EXCEPTION"; payload: { reason: string; resolution: Resolution } };

export function listOrders(token: string, workspaceId: string, view: View): Promise<{ orders: OrderRow[] }> {
  return call(`/v1/workspaces/${workspaceId}/orders?view=${view}`, { method: "GET", token });
}

export function getOrder(token: string, workspaceId: string, orderId: string): Promise<OrderDetail> {
  return call(`/v1/workspaces/${workspaceId}/orders/${orderId}`, { method: "GET", token });
}

export function sendNote(token: string, workspaceId: string, orderId: string, body: string): Promise<{ posted: true }> {
  return call(`/v1/workspaces/${workspaceId}/orders/${orderId}/notes`, { method: "POST", token, body: { body } });
}

/** runCommand sends a coordinator command bound to the order state the screen showed. */
export function runCommand(token: string, workspaceId: string, detail: OrderDetail, command: ConsoleCommand): Promise<{ outcome: "APPLIED" | "NO_CHANGE" }> {
  return call(`/v1/workspaces/${workspaceId}/console/commands`, {
    method: "POST",
    token,
    body: { commandId: crypto.randomUUID(), orderId: detail.order.id, expectedRevision: detail.order.revision, expectedVersion: detail.order.version, ...command },
  });
}

export type Product = { sku: string; name: string; bin: string | null; routeRank: number };
export type RowError = { line: number; field: string; problem: string };
export type PreviewRow = { line: number; sku: string; name: string; bin: string | null; routeRank: number; fate: "NEW" | "UPDATE" | "UNCHANGED" };

export function listProducts(token: string, workspaceId: string): Promise<{ products: Product[] }> {
  return call(`/v1/workspaces/${workspaceId}/catalogue`, { method: "GET", token });
}

export function previewImport(token: string, workspaceId: string, csv: string): Promise<{ rows: PreviewRow[]; errors: RowError[] }> {
  return call(`/v1/workspaces/${workspaceId}/catalogue/preview`, { method: "POST", token, body: { csv } });
}

export function commitImport(token: string, workspaceId: string, csv: string, allowUpdates: boolean): Promise<{ added: number; updated: number; unchanged: number }> {
  return call(`/v1/workspaces/${workspaceId}/catalogue/commit`, { method: "POST", token, body: { csv, allowUpdates } });
}
