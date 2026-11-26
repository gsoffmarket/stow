// One order in the console: lines with what is in the tote, the open problem
// with the coordinator's choices, notes, and the timeline. Every decision is
// sent bound to the version on screen, so acting on a stale view is refused
// by the server and the screen refreshes instead of guessing.

import { AnimatePresence, m } from "motion/react";
import { useEffect, useState, type FormEvent } from "react";
import { ApiError, getOrder, listPickers, runCommand, sendNote, type ConsoleCommand, type OrderDetail as Detail, type Picker } from "./api.ts";
import { copy } from "./copy.ts";
import { LiveDot, StatusChip } from "./Orders.tsx";
import { usePolling } from "./polling.ts";
import { Revise } from "./Revise.tsx";
import { haptic } from "./telegram.ts";
import { GhostButton, PrimaryButton, Sheet } from "./ui.tsx";

type Props = { token: string; workspaceId: string; orderId: string; onBack: () => void };

export function OrderDetail({ token, workspaceId, orderId, onBack }: Props) {
  const { data: detail, isLive, refresh } = usePolling(() => getOrder(token, workspaceId, orderId), [orderId], 3000);
  const [sheet, setSheet] = useState<"revise" | "cancel" | "assign" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(command: ConsoleCommand): Promise<boolean> {
    if (!detail || busy) return false;
    setBusy(true);
    setError(null);
    try {
      await runCommand(token, workspaceId, detail, command);
      haptic("success");
      return true;
    } catch (failure) {
      haptic("error");
      const code = failure instanceof ApiError ? failure.code : "UNKNOWN";
      setError(copy.errors[code] ?? copy.errors.UNKNOWN!);
      return false;
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  if (!detail) return <p className="text-text-secondary" role="status">{copy.detail.loading}</p>;
  const { order } = detail;
  const isOpen = !order.terminal;
  // Only an order nobody has started can go to a picker; one being picked stays with its tote.
  const canAssign = isOpen && order.isAccepted !== true && order.hold !== "CANCELLING";

  return (
    <section className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <button onClick={onBack} aria-label={copy.detail.back} className="flex size-10 items-center justify-center rounded-[var(--radius-control)]">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <m.span layoutId={`ref-${order.id}`} className="font-mono text-[16px] font-medium">{order.ref}</m.span>
        <span className="ml-auto"><StatusChip order={order} /></span>
      </div>

      <div className="flex items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-[32px] font-medium leading-tight">{copy.orders.progress(order.confirmed, order.requested)}</span>
          <span className="text-[13px] text-text-secondary">
            {order.picker ? [order.picker, order.toteId && `Tote ${order.toteId}`, `rev ${order.revision}`].filter(Boolean).join(" · ") : copy.orders.unassigned}
          </span>
        </div>
        <LiveDot isLive={isLive} />
      </div>

      <AnimatePresence>
        {error && (
          <m.p role="alert" initial={{ opacity: 0.6, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="rounded-[var(--radius-control)] bg-surface-attention px-4 py-3 text-[14px]">
            {error}
          </m.p>
        )}
      </AnimatePresence>

      {detail.exception && <Problem detail={detail} busy={busy} act={act} />}

      <ul aria-label={copy.detail.lines} className="overflow-hidden rounded-[var(--radius-card)] bg-surface shadow-[var(--shadow-key)]">
        {detail.lines.map((line, index) => {
          const back = line.picked - line.requested;
          return (
            <li key={line.id} className={`flex flex-col gap-1.5 px-4 py-3.5 ${index > 0 ? "border-t border-border" : ""} ${back > 0 ? "bg-surface-attention shadow-[inset_2px_0_0_0_var(--color-accent)]" : ""}`}>
              <span className="flex items-baseline justify-between gap-3">
                <span className="text-[15px] font-medium">{line.name}</span>
                <span className="font-mono text-[12px] text-text-secondary">{[line.sku, line.bin].filter(Boolean).join(" · ")}</span>
              </span>
              <span className="flex items-center gap-2.5 text-[14px]">
                <span className="text-text-secondary">{copy.detail.target}</span>
                <span className="font-semibold">{line.requested}</span>
                <span className="text-text-secondary">· {copy.detail.picked(line.picked)}</span>
                {back > 0 && (
                  <m.span initial={{ scale: 0.92 }} animate={{ scale: 1 }} className="ml-auto rounded-[var(--radius-badge)] bg-accent px-2 py-0.5 text-[12px] font-semibold text-canvas">
                    {copy.detail.returnN(back)}
                  </m.span>
                )}
              </span>
            </li>
          );
        })}
      </ul>

      {canAssign && <GhostButton onClick={() => setSheet("assign")}>{order.picker ? copy.detail.reassign : copy.detail.assign}</GhostButton>}

      {isOpen && (
        <div className="grid grid-cols-2 gap-2">
          <GhostButton onClick={() => setSheet("cancel")}>{copy.detail.cancel}</GhostButton>
          <PrimaryButton onClick={() => setSheet("revise")} disabled={detail.exception?.status === "OPEN"}>{copy.detail.revise}</PrimaryButton>
        </div>
      )}

      {isOpen && order.picker && <Notes token={token} workspaceId={workspaceId} detail={detail} onSent={refresh} />}

      <section className="flex flex-col gap-2.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.073em] text-text-secondary">{copy.detail.timeline}</h2>
        <ol className="flex flex-col gap-2.5">
          {detail.timeline.map((event) => (
            <m.li key={event.seq} layout initial={{ opacity: 0.6, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex gap-3 text-[14px]">
              <time className="w-11 shrink-0 font-mono text-[12px] text-text-muted" dateTime={event.at}>
                {new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </time>
              <span>
                {event.type.toLowerCase().replace(/_/g, " ")}
                {event.detail && <span className="text-text-secondary"> · {event.detail}</span>}
                {event.actor && <span className="text-text-muted"> · {event.actor}</span>}
              </span>
            </m.li>
          ))}
        </ol>
      </section>

      <AnimatePresence>
        {sheet === "revise" && <Revise detail={detail} busy={busy} onClose={() => setSheet(null)} onSubmit={async (command) => (await act(command)) && setSheet(null)} />}
        {sheet === "assign" && (
          <AssignSheet token={token} workspaceId={workspaceId} busy={busy} onClose={() => setSheet(null)} onPick={async (memberId) => (await act({ type: "ASSIGN_ORDER", payload: { memberId } })) && setSheet(null)} />
        )}
        {sheet === "cancel" && <CancelSheet detail={detail} busy={busy} onClose={() => setSheet(null)} onSubmit={async (reason) => (await act({ type: "REQUEST_CANCEL", payload: { reason } })) && setSheet(null)} />}
      </AnimatePresence>
    </section>
  );
}

function Problem({ detail, busy, act }: { detail: Detail; busy: boolean; act: (command: ConsoleCommand) => Promise<boolean> }) {
  const problem = detail.exception!;
  const line = detail.lines.find((candidate) => candidate.id === problem.lineId);
  const reduceTo = line ? Math.min(line.requested, line.picked + (problem.reportedQty ?? 0)) : 0;
  const decide = (resolution: Extract<ConsoleCommand, { type: "RESOLVE_EXCEPTION" }>["payload"]["resolution"]) =>
    act({ type: "RESOLVE_EXCEPTION", payload: { reason: "Decided in the Stow app", resolution } });
  return (
    <section className="flex flex-col gap-3 rounded-[var(--radius-card)] bg-surface-attention px-4 py-4 shadow-[inset_2px_0_0_0_var(--color-accent)]">
      <span className="text-[11px] font-semibold uppercase tracking-[0.073em] text-accent">{copy.detail.problem.title(problem.type)}</span>
      <span className="text-[17px] font-medium">{copy.detail.problem.found(problem.sku ?? "", problem.reportedQty)}</span>
      {problem.status === "OPEN" ? (
        <div className="grid grid-cols-2 gap-2">
          <GhostButton onClick={() => void decide({ kind: "RESUME" })}>{copy.detail.problem.resume}</GhostButton>
          <PrimaryButton disabled={busy} onClick={() => void decide({ kind: "REDUCE", quantity: reduceTo })}>{copy.detail.problem.reduce(reduceTo)}</PrimaryButton>
          <button disabled={busy} onClick={() => void decide({ kind: "CANCEL" })} className="col-span-2 min-h-11 text-[14px] font-medium text-accent">
            {copy.detail.problem.cancel}
          </button>
        </div>
      ) : (
        <span className="text-[14px] text-text-secondary">{copy.detail.problem.waiting}</span>
      )}
    </section>
  );
}

function Notes({ token, workspaceId, detail, onSent }: { token: string; workspaceId: string; detail: Detail; onSent: () => Promise<void> }) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!body.trim() || sending) return;
    setSending(true);
    try {
      await sendNote(token, workspaceId, detail.order.id, body.trim());
      haptic("success");
      setBody("");
      await onSent();
    } finally {
      setSending(false);
    }
  }
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.073em] text-text-secondary">{copy.detail.notes}</h2>
      {detail.messages.map((message) => (
        <div key={message.at + message.body} className={`flex flex-col gap-1 rounded-[12px] px-3 py-2.5 ${message.direction === "TO_PICKER" ? "self-end bg-surface-raised" : "self-start bg-surface-recessed"}`}>
          <span className="text-[14px]">{message.body}</span>
          <span className="text-[11px] text-text-muted">
            {message.direction === "TO_PICKER" ? (message.isRead ? copy.detail.read : copy.detail.unread) : `${copy.detail.fromGroup} · ${message.author}`}
          </span>
        </div>
      ))}
      <form onSubmit={submit} className="flex gap-2">
        <label className="sr-only" htmlFor="note">{copy.detail.notePlaceholder}</label>
        <input
          id="note"
          value={body}
          maxLength={280}
          onChange={(event) => setBody(event.target.value)}
          placeholder={copy.detail.notePlaceholder}
          className="min-w-0 flex-1 rounded-[var(--radius-control)] bg-surface-recessed px-3 py-2.5 text-[16px] placeholder:text-text-muted"
        />
        <button type="submit" disabled={!body.trim() || sending} className="min-h-11 rounded-[var(--radius-control)] border border-border-strong px-4 text-[14px] font-medium disabled:opacity-50">
          {copy.detail.sendNote}
        </button>
      </form>
    </section>
  );
}

function CancelSheet({ detail, busy, onClose, onSubmit }: { detail: Detail; busy: boolean; onClose: () => void; onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  const inTote = detail.lines.reduce((sum, line) => sum + line.picked, 0);
  return (
    <Sheet label={copy.cancel.title} onClose={onClose}>
      <h2 className="text-[20px] font-medium">{copy.cancel.title}</h2>
      <p className="text-[14px] text-text-secondary">{copy.cancel.returns(inTote)}</p>
      <label className="flex flex-col gap-1.5 text-[13px] text-text-secondary">
        {copy.cancel.reason}
        <input value={reason} maxLength={280} onChange={(event) => setReason(event.target.value)} className="rounded-[var(--radius-control)] bg-surface-recessed px-3 py-2.5 text-[16px] text-text-primary" />
      </label>
      <button
        disabled={busy}
        onClick={() => onSubmit(reason.trim() || "Cancelled in the Stow app")}
        className="min-h-11 rounded-[var(--radius-control)] bg-accent px-4 text-[15px] font-medium text-canvas shadow-[var(--shadow-lift)] disabled:opacity-50"
      >
        {copy.cancel.confirm}
      </button>
      <GhostButton onClick={onClose}>{copy.cancel.keep}</GhostButton>
    </Sheet>
  );
}

function AssignSheet({ token, workspaceId, busy, onClose, onPick }: { token: string; workspaceId: string; busy: boolean; onClose: () => void; onPick: (memberId: string) => void }) {
  const [pickers, setPickers] = useState<Picker[] | null>(null);
  useEffect(() => {
    void listPickers(token, workspaceId).then((loaded) => setPickers(loaded.pickers));
  }, [token, workspaceId]);
  return (
    <Sheet label={copy.assign.title} onClose={onClose}>
      <h2 className="text-[20px] font-medium">{copy.assign.title}</h2>
      <p className="text-[14px] text-text-secondary">{copy.assign.hint}</p>
      {!pickers && <p role="status" className="text-[14px] text-text-muted">{copy.assign.loading}</p>}
      {pickers?.length === 0 && <p className="text-[14px] text-text-muted">{copy.assign.none}</p>}
      {pickers && pickers.length > 0 && (
        <ul className="overflow-hidden rounded-[var(--radius-card)] bg-surface-recessed">
          {pickers.map((picker, index) => (
            <li key={picker.id} className={index > 0 ? "border-t border-border" : ""}>
              <button disabled={busy} onClick={() => onPick(picker.id)} className="flex min-h-12 w-full items-center justify-between gap-3 px-4 text-left text-[15px] disabled:opacity-50">
                {picker.name}
                <span className={`text-[12px] ${picker.openOrders === 0 ? "text-confirmed" : "text-text-secondary"}`}>{copy.assign.open(picker.openOrders)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <GhostButton onClick={onClose}>{copy.assign.close}</GhostButton>
    </Sheet>
  );
}
