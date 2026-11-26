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
  isAccepted: boolean | null;
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
  | { type: "ASSIGN_ORDER"; payload: { memberId: string } }
  | { type: "RESOLVE_EXCEPTION"; payload: { reason: string; resolution: Resolution } };

/** OrderPage is one page of a list; next is an opaque cursor, null on the last page. */
export type OrderPage = { orders: OrderRow[]; next: string | null };

export function listOrders(token: string, workspaceId: string, view: View, search: string, cursor: string | null = null): Promise<OrderPage> {
  const query = new URLSearchParams({ view });
  if (search) query.set("q", search);
  if (cursor) query.set("cursor", cursor);
  return call(`/v1/workspaces/${workspaceId}/orders?${query}`, { method: "GET", token });
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

/** createOrder queues an order typed in the Mini App; commandId makes a retried submit safe. */
export function createOrder(token: string, workspaceId: string, commandId: string, ref: string | null, lines: { sku: string; quantity: number }[]): Promise<{ orderId: string; ref: string }> {
  return call(`/v1/workspaces/${workspaceId}/orders`, { method: "POST", token, body: { commandId, ref, lines } });
}

/** RangeQuery is whole calendar days in the viewer's time zone. */
export type RangeQuery = { from: string; to: string; timeZone: string };

export type Report = {
  range: RangeQuery & { startsAt: string; endsAt: string };
  orders: { created: number; completed: number; cancelled: number };
  unitsConfirmed: number;
  problems: number;
  undelivered: number;
  pickers: { name: string; completed: number; units: number }[];
};

const rangeParams = (range: RangeQuery) => new URLSearchParams({ from: range.from, to: range.to, tz: range.timeZone }).toString();

export function getReport(token: string, workspaceId: string, range: RangeQuery): Promise<Report> {
  return call(`/v1/workspaces/${workspaceId}/reports?${rangeParams(range)}`, { method: "GET", token });
}

/** ordersCsv fetches the order history file; it is text, not the usual JSON envelope. */
export async function ordersCsv(token: string, workspaceId: string, range: RangeQuery): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}/v1/workspaces/${workspaceId}/reports/orders.csv?${rangeParams(range)}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new ApiError(0, "NETWORK");
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: { code: string } } | null;
    throw new ApiError(response.status, payload?.error?.code ?? "UNKNOWN");
  }
  return response.blob();
}

export type Member = { id: string; name: string; role: Role; isLinked: boolean; devices: number; openOrders: number; isYou: boolean };

/** GlassesSession is a paired pair of glasses: who wears it, whether it is polling, and what it holds. */
export type GlassesSession = { id: string; label: string; picker: string; pairedAt: string; lastSeenAt: string | null; isConnected: boolean; orders: { ref: string; toteId: string | null }[] };

export function listSessions(token: string, workspaceId: string): Promise<{ sessions: GlassesSession[] }> {
  return call(`/v1/workspaces/${workspaceId}/sessions`, { method: "GET", token });
}

export function listMembers(token: string, workspaceId: string): Promise<{ members: Member[] }> {
  return call(`/v1/workspaces/${workspaceId}/members`, { method: "GET", token });
}

/** MemberChange is what an owner can do to one member; the server re-checks every rule. */
export type MemberChange = { kind: "role"; role: Exclude<Role, "VIEWER"> } | { kind: "revoke" } | { kind: "remove" };

export function changeMember(token: string, workspaceId: string, memberId: string, change: MemberChange): Promise<{ changed: true }> {
  const base = `/v1/workspaces/${workspaceId}/members/${memberId}`;
  if (change.kind === "role") return call(`${base}/role`, { method: "POST", token, body: { role: change.role } });
  return call(change.kind === "revoke" ? `${base}/devices/revoke` : `${base}/remove`, { method: "POST", token, body: {} });
}

/** TelegramGroup is a group that drives the workspace; title is null for groups connected before names were kept. */
export type TelegramGroup = { id: string; title: string | null; connectedAt: string; connectedBy: string; openOrders: number };

export function getTelegram(token: string, workspaceId: string): Promise<{ groups: TelegramGroup[]; delivery: { undelivered: number } }> {
  return call(`/v1/workspaces/${workspaceId}/telegram`, { method: "GET", token });
}

export function disconnectGroup(token: string, workspaceId: string, groupId: string): Promise<{ disconnected: true }> {
  return call(`/v1/workspaces/${workspaceId}/telegram/groups/${groupId}/disconnect`, { method: "POST", token, body: {} });
}

export type Picker = { id: string; name: string; openOrders: number };

export function listPickers(token: string, workspaceId: string): Promise<{ pickers: Picker[] }> {
  return call(`/v1/workspaces/${workspaceId}/pickers`, { method: "GET", token });
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
