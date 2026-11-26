// Who is using the Mini App. Stow has no passwords: a person is their
// Telegram account. The Mini App sends Telegram's signed launch data once; the
// server checks the signature with the bot token, then issues a short-lived
// opaque session. Fields the client could edit are never trusted unsigned.
//
// Signature check per Telegram's Mini App docs: the secret key is
// HMAC-SHA256(key = "WebAppData", data = bot token); the expected hash is
// HMAC-SHA256(key = secret, data = every field except `hash`, as key=value
// lines sorted by key and joined with "\n").

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import type { Role } from "./fulfilment.ts";

/** TelegramUser is the signed identity from Mini App launch data. */
export type TelegramUser = { readonly id: string; readonly firstName: string; readonly username: string | null };

export type LaunchCheck = { readonly ok: true; readonly user: TelegramUser } | { readonly ok: false; readonly reason: "unsigned" | "bad_signature" | "expired" | "no_user" };

/** maxLaunchAge_s bounds how old signed launch data may be when exchanged for a session. */
export const maxLaunchAge_s = 300;

/** verifyLaunchData checks Telegram's signature and freshness and returns the signed user. */
export function verifyLaunchData(initData: string, botToken: string, now_s: number): LaunchCheck {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: "unsigned" };
  params.delete("hash");
  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(checkString).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) return { ok: false, reason: "bad_signature" };

  const signedAt = Number(params.get("auth_date"));
  if (!Number.isInteger(signedAt) || now_s - signedAt > maxLaunchAge_s || signedAt - now_s > 60) return { ok: false, reason: "expired" };
  try {
    const user = JSON.parse(params.get("user") ?? "null") as { id?: number; first_name?: string; username?: string } | null;
    if (!user || !Number.isSafeInteger(user.id)) return { ok: false, reason: "no_user" };
    return { ok: true, user: { id: String(user.id), firstName: (user.first_name ?? "").slice(0, 80), username: user.username ?? null } };
  } catch {
    return { ok: false, reason: "no_user" };
  }
}

const session_s = 3600;

/** startSession issues a Mini App session for a verified Telegram user. */
export async function startSession(pool: pg.Pool, user: TelegramUser): Promise<{ token: string; expiresAt: string }> {
  const token = randomBytes(32).toString("base64url");
  const { rows } = await pool.query<{ expires_at: Date }>(
    "insert into miniapp_sessions (telegram_user_id, token_hash, expires_at) values ($1, $2, now() + make_interval(secs => $3)) returning expires_at",
    [user.id, sessionHash(token), session_s],
  );
  return { token, expiresAt: rows[0]!.expires_at.toISOString() };
}

/** sessionUser resolves a session token to its Telegram user ID, if live. */
export async function sessionUser(pool: pg.Pool, token: string): Promise<string | null> {
  const { rows } = await pool.query<{ telegram_user_id: string }>(
    "select telegram_user_id from miniapp_sessions where token_hash = $1 and revoked_at is null and expires_at > now()",
    [sessionHash(token)],
  );
  return rows[0]?.telegram_user_id ?? null;
}

function sessionHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Membership is one workspace a Telegram user belongs to. */
export type Membership = { readonly workspaceId: string; readonly workspaceName: string; readonly memberId: string; readonly role: Role; readonly displayName: string };

/** memberships lists every workspace linked to a Telegram account. */
export async function memberships(pool: pg.Pool, telegramUserId: string): Promise<Membership[]> {
  const { rows } = await pool.query<{ workspace_id: string; workspace_name: string; member_id: string; role: Role; display_name: string }>(
    `select w.id as workspace_id, w.name as workspace_name, m.id as member_id, m.role, m.display_name
     from members m join workspaces w on w.id = m.workspace_id
     where m.telegram_user_id = $1 order by w.name, w.id`,
    [telegramUserId],
  );
  return rows.map((row) => ({ workspaceId: row.workspace_id, workspaceName: row.workspace_name, memberId: row.member_id, role: row.role, displayName: row.display_name }));
}
