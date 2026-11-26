// The people in a workspace and what an owner can change about them: role,
// paired glasses, and membership itself (PRD FR-21).
//
// Every change locks the workspace row first, the same order fulfilment
// uses, so two owners acting at once cannot both demote the last owner.
// Removal keeps the member row because history names it; it clears the
// Telegram link, which is how sign-in finds a membership, so Mini App access
// ends on the next request, and revokes every device token in the same
// transaction.

import type pg from "pg";
import { transaction, type Actor, type Role } from "./fulfilment.ts";

/** Member is one person in the workspace as the Workers page shows them. */
export type Member = {
  readonly id: string;
  readonly name: string;
  readonly role: Role;
  readonly isLinked: boolean;
  readonly devices: number;
  readonly openOrders: number;
  readonly isYou: boolean;
};

/** listMembers returns everyone not removed, owners first. */
export async function listMembers(pool: pg.Pool, actor: Actor): Promise<Member[]> {
  const { rows } = await pool.query<{ id: string; name: string; role: Role; is_linked: boolean; devices: number; open_orders: number }>(
    `select m.id, m.display_name as name, m.role, m.telegram_user_id is not null as is_linked,
            (select count(*)::int from device_tokens d where d.member_id = m.id and d.revoked_at is null and d.expires_at > now()) as devices,
            (select count(*)::int from assignments a join orders o on o.id = a.order_id
             where a.worker_id = m.id and a.released_at is null and o.terminal is null) as open_orders
     from members m where m.workspace_id = $1 and m.removed_at is null
     order by array_position(array['OWNER', 'COORDINATOR', 'PICKER', 'VIEWER'], m.role), m.display_name, m.id limit 500`,
    [actor.workspaceId],
  );
  return rows.map((row) => ({ id: row.id, name: row.name, role: row.role, isLinked: row.is_linked, devices: row.devices, openOrders: row.open_orders, isYou: row.id === actor.memberId }));
}

export type Refusal = "ROLE_REQUIRED" | "NOT_FOUND" | "LAST_OWNER" | "HOLDS_ORDERS" | "NO_CHANGE";
export type Change = { readonly ok: true } | { readonly ok: false; readonly code: Refusal };

/** changeRole sets a member's role; there is always at least one owner left. */
export function changeRole(pool: pg.Pool, actor: Actor, memberId: string, role: Exclude<Role, "VIEWER">): Promise<Change> {
  return asOwner(pool, actor, memberId, async (client, current) => {
    if (current.role === role) return { ok: false, code: "NO_CHANGE" };
    if (current.role === "OWNER" && (await owners(client, actor.workspaceId)) === 1) return { ok: false, code: "LAST_OWNER" };
    await client.query("update members set role = $3 where workspace_id = $1 and id = $2", [actor.workspaceId, memberId, role]);
    return { ok: true };
  });
}

/** revokeDevices signs out every pair of glasses the member has paired. */
export function revokeDevices(pool: pg.Pool, actor: Actor, memberId: string): Promise<Change> {
  return asOwner(pool, actor, memberId, async (client) => {
    const { rowCount } = await client.query("update device_tokens set revoked_at = now() where workspace_id = $1 and member_id = $2 and revoked_at is null", [actor.workspaceId, memberId]);
    return rowCount ? { ok: true } : { ok: false, code: "NO_CHANGE" };
  });
}

/**
 * removeMember ends someone's access. A member holding open orders is
 * refused rather than leaving goods in a tote nobody owns: their orders are
 * released from the glasses or reassigned first.
 */
export function removeMember(pool: pg.Pool, actor: Actor, memberId: string): Promise<Change> {
  return asOwner(pool, actor, memberId, async (client, current) => {
    if (current.role === "OWNER" && (await owners(client, actor.workspaceId)) === 1) return { ok: false, code: "LAST_OWNER" };
    const held = await client.query(
      "select 1 from assignments a join orders o on o.id = a.order_id where a.workspace_id = $1 and a.worker_id = $2 and a.released_at is null and o.terminal is null limit 1",
      [actor.workspaceId, memberId],
    );
    if (held.rowCount) return { ok: false, code: "HOLDS_ORDERS" };
    await client.query("update device_tokens set revoked_at = now() where workspace_id = $1 and member_id = $2 and revoked_at is null", [actor.workspaceId, memberId]);
    await client.query("update members set telegram_user_id = null, removed_at = now() where workspace_id = $1 and id = $2", [actor.workspaceId, memberId]);
    return { ok: true };
  });
}

// Runs an owner's change to one member under the workspace lock.
async function asOwner(
  pool: pg.Pool,
  actor: Actor,
  memberId: string,
  change: (client: pg.ClientBase, current: { role: Role }) => Promise<Change>,
): Promise<Change> {
  if (actor.role !== "OWNER") return { ok: false, code: "ROLE_REQUIRED" };
  return transaction(pool, async (client) => {
    await client.query("select 1 from workspaces where id = $1 for update", [actor.workspaceId]);
    const { rows } = await client.query<{ role: Role }>("select role from members where workspace_id = $1 and id = $2 and removed_at is null", [actor.workspaceId, memberId]);
    const current = rows[0];
    return current ? change(client, current) : { ok: false, code: "NOT_FOUND" };
  });
}

async function owners(client: pg.ClientBase, workspaceId: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>("select count(*)::int as n from members where workspace_id = $1 and role = 'OWNER' and removed_at is null", [workspaceId]);
  return rows[0]!.n;
}
