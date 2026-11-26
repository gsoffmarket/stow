// The team: who is in the workspace, whether their Telegram account and
// glasses are connected, and how much work they hold. Owners can change a
// role, sign out someone's glasses or remove them; the server enforces every
// rule, so the sheet only shows what the owner can try and explains refusals.

import { AnimatePresence, m } from "motion/react";
import { useState } from "react";
import { ApiError, changeMember, listMembers, type Member, type MemberChange } from "./api.ts";
import { copy } from "./copy.ts";
import { usePolling } from "./polling.ts";
import { haptic } from "./telegram.ts";
import { GhostButton, Sheet } from "./ui.tsx";

type Props = { token: string; workspaceId: string; isOwner: boolean; onBack: () => void };

const roles = ["OWNER", "COORDINATOR", "PICKER"] as const;

export function Team({ token, workspaceId, isOwner, onBack }: Props) {
  const { data, refresh } = usePolling(() => listMembers(token, workspaceId), [workspaceId], 10_000);
  const [selected, setSelected] = useState<Member | null>(null);

  return (
    <section className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <button onClick={onBack} aria-label={copy.team.back} className="flex size-10 items-center justify-center rounded-[var(--radius-control)]">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <h1 className="text-2xl font-medium">{copy.team.title}</h1>
      </div>

      {data && (
        <ul className="overflow-hidden rounded-[var(--radius-card)] bg-surface shadow-[var(--shadow-key)]">
          {data.members.map((member, index) => (
            <li key={member.id} className={index > 0 ? "border-t border-border" : ""}>
              <button
                disabled={!isOwner}
                onClick={() => setSelected(member)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left disabled:cursor-default"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-[15px]">
                    <span className="truncate">{member.name}</span>
                    {member.isYou && <span className="text-[12px] text-text-muted">{copy.team.you}</span>}
                  </span>
                  <span className="block truncate text-[12px] text-text-secondary">
                    {[member.isLinked ? copy.team.linked : copy.team.notLinked, copy.team.glasses(member.devices), copy.team.orders(member.openOrders)].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <span className="rounded-[var(--radius-badge)] bg-surface-raised px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-text-secondary">
                  {copy.team.roles[member.role]}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[13px] leading-normal text-text-muted">{isOwner ? copy.team.invite : copy.team.ownerOnly}</p>

      <AnimatePresence>
        {selected && (
          <MemberSheet
            token={token}
            workspaceId={workspaceId}
            member={selected}
            onClose={() => setSelected(null)}
            onChanged={async () => {
              setSelected(null);
              await refresh();
            }}
          />
        )}
      </AnimatePresence>
    </section>
  );
}

function MemberSheet({ token, workspaceId, member, onClose, onChanged }: { token: string; workspaceId: string; member: Member; onClose: () => void; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);

  async function apply(change: MemberChange) {
    setBusy(true);
    setError(null);
    try {
      await changeMember(token, workspaceId, member.id, change);
      haptic("success");
      await onChanged();
    } catch (failure) {
      haptic("error");
      setError(copy.errors[failure instanceof ApiError ? failure.code : "UNKNOWN"] ?? copy.errors.UNKNOWN!);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet label={member.name} onClose={onClose}>
      <h2 className="text-[20px] font-medium">{member.name}</h2>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-[11px] font-semibold uppercase tracking-[0.073em] text-text-secondary">{copy.team.roleTitle}</legend>
        <div role="radiogroup" className="grid grid-cols-3 gap-1 rounded-[10px] bg-surface-recessed p-1">
          {roles.map((role) => (
            <button
              key={role}
              role="radio"
              aria-checked={member.role === role}
              disabled={busy}
              onClick={() => member.role !== role && void apply({ kind: "role", role })}
              className="relative min-h-10 rounded-[var(--radius-control)] text-[13px] font-medium text-text-secondary aria-checked:bg-surface-raised aria-checked:text-text-primary"
            >
              {copy.team.roles[role]}
            </button>
          ))}
        </div>
      </fieldset>

      {member.devices > 0 && (
        <div className="flex flex-col gap-1.5">
          <GhostButton onClick={() => void apply({ kind: "revoke" })}>{copy.team.revoke}</GhostButton>
          <p className="text-[12px] text-text-muted">{copy.team.revokeHint}</p>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        {isRemoving ? (
          <m.button
            initial={{ scale: 0.98, opacity: 0.6 }}
            animate={{ scale: 1, opacity: 1 }}
            disabled={busy}
            onClick={() => void apply({ kind: "remove" })}
            className="min-h-11 rounded-[var(--radius-control)] bg-accent px-4 text-[15px] font-medium text-canvas shadow-[var(--shadow-lift)] disabled:opacity-50"
          >
            {copy.team.removeConfirm(member.name)}
          </m.button>
        ) : (
          <button onClick={() => setIsRemoving(true)} className="min-h-11 text-[14px] font-medium text-accent">
            {copy.team.remove}
          </button>
        )}
        <p className="text-[12px] text-text-muted">{copy.team.removeHint}</p>
      </div>

      {error && <p role="alert" className="rounded-[var(--radius-control)] bg-surface-attention px-4 py-3 text-[14px]">{error}</p>}
      <GhostButton onClick={onClose}>{copy.team.close}</GhostButton>
    </Sheet>
  );
}
