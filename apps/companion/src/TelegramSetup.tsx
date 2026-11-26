// Which Telegram groups drive this workspace, whether sending to them works,
// and how to connect one. Connecting happens in the group, where Telegram
// proves who asked; here an owner can only disconnect, after confirming.

import { useState } from "react";
import { ApiError, disconnectGroup, getTelegram, type TelegramGroup } from "./api.ts";
import { copy } from "./copy.ts";
import { usePolling } from "./polling.ts";
import { haptic } from "./telegram.ts";
import { BackLink } from "./ui.tsx";

type Props = { token: string; workspaceId: string; isOwner: boolean; onBack: () => void };

const botUsername = (import.meta.env.VITE_STOW_BOT_USERNAME as string | undefined) || null;
const day = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" });

export function TelegramSetup({ token, workspaceId, isOwner, onBack }: Props) {
  const { data, refresh } = usePolling(() => getTelegram(token, workspaceId), [workspaceId], 15_000);

  return (
    <section className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <BackLink label={copy.telegram.back} onBack={onBack} />
        <h1 className="text-2xl font-medium">{copy.telegram.title}</h1>
      </div>
      {botUsername && (
        <a href={`https://t.me/${botUsername}`} className="text-[14px] text-text-secondary underline-offset-2 hover:underline">
          {copy.telegram.bot(botUsername)}
        </a>
      )}
      {data && data.delivery.undelivered > 0 && (
        <p role="alert" className="rounded-[var(--radius-control)] bg-surface-attention px-4 py-3 text-[14px]">{copy.telegram.undelivered(data.delivery.undelivered)}</p>
      )}

      {data && (
        <section className="flex flex-col gap-2.5">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.073em] text-text-secondary">{copy.telegram.groups}</h2>
          {data.groups.length === 0 ? (
            <p className="text-[14px] text-text-muted">{copy.telegram.none}</p>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {data.groups.map((group) => (
                <GroupCard key={group.id} token={token} workspaceId={workspaceId} group={group} isOwner={isOwner} onChanged={refresh} />
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="flex flex-col gap-2.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.073em] text-text-secondary">{copy.telegram.howTitle}</h2>
        <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-[14px] leading-normal text-text-secondary">
          {copy.telegram.how.map((step) => <li key={step}>{step}</li>)}
        </ol>
      </section>
    </section>
  );
}

function GroupCard({ token, workspaceId, group, isOwner, onChanged }: { token: string; workspaceId: string; group: TelegramGroup; isOwner: boolean; onChanged: () => Promise<void> }) {
  const [isConfirming, setIsConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = group.title ?? copy.telegram.untitled;

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      await disconnectGroup(token, workspaceId, group.id);
      haptic("success");
      await onChanged();
    } catch (failure) {
      haptic("error");
      setError(copy.errors[failure instanceof ApiError ? failure.code : "UNKNOWN"] ?? copy.errors.UNKNOWN!);
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-col gap-2 rounded-[var(--radius-card)] bg-surface px-4 py-3.5 shadow-[var(--shadow-key)]">
      <span className="text-[15px] font-medium">{name}</span>
      <span className="text-[12px] text-text-secondary">{copy.telegram.groupLine(group.connectedBy, day.format(new Date(group.connectedAt)), group.openOrders)}</span>
      {!isOwner ? (
        <span className="text-[12px] text-text-muted">{copy.telegram.ownerOnly}</span>
      ) : isConfirming ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-[12px] leading-normal text-text-muted">{copy.telegram.disconnectHint}</p>
          <button disabled={busy} onClick={() => void disconnect()} className="min-h-11 rounded-[var(--radius-control)] bg-accent px-4 text-[15px] font-medium text-canvas disabled:opacity-50">
            {copy.telegram.disconnectConfirm(name)}
          </button>
        </div>
      ) : (
        <button onClick={() => setIsConfirming(true)} className="min-h-11 self-start text-[14px] font-medium text-accent">
          {copy.telegram.disconnect}
        </button>
      )}
      {error && <p role="alert" className="rounded-[var(--radius-control)] bg-surface-attention px-4 py-3 text-[14px]">{error}</p>}
    </li>
  );
}
