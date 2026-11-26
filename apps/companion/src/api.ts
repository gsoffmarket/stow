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
