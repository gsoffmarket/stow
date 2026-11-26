// Pairing glasses to a picker. Glasses have no keyboard and Google sign-in
// does not work in the Even Hub WebView, so the glasses show a short code and
// a person who is already signed in (through Telegram) approves it.
//
//   glasses: start()     -> code to show + private secret to poll with
//   picker:  approve()   -> binds the pairing to their membership
//   glasses: exchange()  -> one device token, once
//
// The code alone is not enough to get a token: the exchange also needs the
// secret, which never leaves the glasses. Codes expire after five minutes.

import { createHash, randomBytes, randomInt } from "node:crypto";
import type pg from "pg";
import { transaction, type Role } from "./fulfilment.ts";

const pairing_s = 300;
const deviceToken_days = 30;
// No 0/O, 1/I/L: the code is read off a small green display and typed on a phone.
const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** formatCode shows a code as two groups of four. */
function formatCode(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** normalizeCode accepts what a person types: any case, with or without the dash or spaces. */
export function normalizeCode(typed: string): string {
  return typed.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export type Started = { readonly pairingId: string; readonly code: string; readonly secret: string; readonly expiresAt: string };

/** start opens a pairing for a pair of glasses. */
export async function start(pool: pg.Pool, label: string): Promise<Started> {
  const raw = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join("");
  const secret = randomBytes(32).toString("base64url");
  const { rows } = await pool.query<{ id: string; expires_at: Date }>(
    `insert into device_pairings (label, code_hash, secret_hash, expires_at) values ($1, $2, $3, now() + make_interval(secs => $4))
     returning id, expires_at`,
    [label, sha256(raw), sha256(secret), pairing_s],
  );
  return { pairingId: rows[0]!.id, code: formatCode(raw), secret, expiresAt: rows[0]!.expires_at.toISOString() };
}

export type PairingState = "PENDING" | "APPROVED" | "CONSUMED" | "EXPIRED";

/** state tells the glasses whether their code has been approved. */
export async function state(pool: pg.Pool, pairingId: string, secret: string): Promise<PairingState | null> {
  const { rows } = await pool.query<{ status: Exclude<PairingState, "EXPIRED">; expired: boolean }>(
    "select status, expires_at < now() as expired from device_pairings where id = $1 and secret_hash = $2",
    [pairingId, sha256(secret)],
  );
  const pairing = rows[0];
  if (!pairing) return null;
  return pairing.status === "PENDING" && pairing.expired ? "EXPIRED" : pairing.status;
}

export type Approval =
  | { readonly ok: true; readonly label: string }
  | { readonly ok: false; readonly code: "NOT_FOUND" | "ROLE_REQUIRED" | "PAIRING_EXPIRED" };

/** approve binds a pending code to the approving person's membership in a workspace. */
export async function approve(pool: pg.Pool, telegramUserId: string, workspaceId: string, typedCode: string): Promise<Approval> {
  return transaction(pool, async (client) => {
    const member = await client.query<{ id: string; role: Role }>(
      "select id, role from members where workspace_id = $1 and telegram_user_id = $2",
      [workspaceId, telegramUserId],
    );
    const approver = member.rows[0];
    if (!approver) return { ok: false, code: "NOT_FOUND" };
    if (approver.role !== "PICKER" && approver.role !== "OWNER") return { ok: false, code: "ROLE_REQUIRED" };
    const { rows } = await client.query<{ id: string; label: string; expired: boolean }>(
      "select id, label, expires_at < now() as expired from device_pairings where code_hash = $1 and status = 'PENDING' for update",
      [sha256(normalizeCode(typedCode))],
    );
    const pairing = rows[0];
    if (!pairing) return { ok: false, code: "NOT_FOUND" };
    if (pairing.expired) return { ok: false, code: "PAIRING_EXPIRED" };
    await client.query(
      "update device_pairings set status = 'APPROVED', workspace_id = $2, member_id = $3, approved_at = now() where id = $1",
      [pairing.id, workspaceId, approver.id],
    );
    return { ok: true, label: pairing.label };
  });
}

export type Exchange =
  | { readonly ok: true; readonly token: string; readonly workspaceId: string; readonly expiresAt: string }
  | { readonly ok: false; readonly code: "NOT_FOUND" | "NOT_APPROVED" | "ALREADY_EXCHANGED" };

/**
 * exchange turns an approved pairing into a device token, exactly once. A
 * second exchange is refused, so a leaked pairing secret cannot mint more
 * tokens after the glasses have theirs.
 */
export async function exchange(pool: pg.Pool, pairingId: string, secret: string): Promise<Exchange> {
  return transaction(pool, async (client) => {
    const { rows } = await client.query<{ status: string; workspace_id: string | null; member_id: string | null; label: string }>(
      "select status, workspace_id, member_id, label from device_pairings where id = $1 and secret_hash = $2 for update",
      [pairingId, sha256(secret)],
    );
    const pairing = rows[0];
    if (!pairing) return { ok: false, code: "NOT_FOUND" };
    if (pairing.status === "CONSUMED") return { ok: false, code: "ALREADY_EXCHANGED" };
    if (pairing.status !== "APPROVED") return { ok: false, code: "NOT_APPROVED" };
    const token = randomBytes(32).toString("base64url");
    const issued = await client.query<{ expires_at: Date }>(
      `insert into device_tokens (workspace_id, member_id, label, token_hash, expires_at)
       values ($1, $2, $3, $4, now() + make_interval(days => $5)) returning expires_at`,
      [pairing.workspace_id, pairing.member_id, pairing.label, sha256(token), deviceToken_days],
    );
    await client.query("update device_pairings set status = 'CONSUMED', consumed_at = now() where id = $1", [pairingId]);
    return { ok: true, token, workspaceId: pairing.workspace_id!, expiresAt: issued.rows[0]!.expires_at.toISOString() };
  });
}
