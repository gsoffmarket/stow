// Revising targets from the console. Each line gets a stepper; the sheet
// shows any return a lower target causes before anything is sent.

import { useState } from "react";
import type { ConsoleCommand, OrderDetail } from "./api.ts";
import { copy } from "./copy.ts";
import { GhostButton, PrimaryButton, Sheet } from "./ui.tsx";

type Props = { detail: OrderDetail; busy: boolean; onClose: () => void; onSubmit: (command: ConsoleCommand) => void };

export function Revise({ detail, busy, onClose, onSubmit }: Props) {
  const [targets, setTargets] = useState(() => Object.fromEntries(detail.lines.map((line) => [line.id, line.requested])));
  const [reason, setReason] = useState("");
  const changes = detail.lines
    .filter((line) => targets[line.id] !== line.requested)
    .map((line) => ({ kind: "SET_QUANTITY" as const, lineId: line.id, quantity: targets[line.id]! }));

  const step = (lineId: string, by: number) =>
    setTargets((current) => ({ ...current, [lineId]: Math.min(10_000, Math.max(0, (current[lineId] ?? 0) + by)) }));

  return (
    <Sheet label={copy.revise.title} onClose={onClose}>
      <h2 className="text-[20px] font-medium">{copy.revise.title}</h2>
      <ul className="flex flex-col gap-2">
        {detail.lines.map((line) => {
          const target = targets[line.id]!;
          const back = line.picked - target;
          return (
            <li key={line.id} className="flex flex-col gap-1.5 rounded-[12px] bg-surface-recessed px-3 py-2.5">
              <span className="flex items-center justify-between gap-3">
                <span className="flex flex-col">
                  <span className="text-[15px] font-medium">{line.name}</span>
                  <span className="font-mono text-[12px] text-text-secondary">{line.sku}</span>
                </span>
                <span className="flex items-center gap-1" role="group" aria-label={line.sku}>
                  <button aria-label={`One less ${line.sku}`} onClick={() => step(line.id, -1)} className="size-11 rounded-[var(--radius-control)] border border-border-strong text-[18px]">−</button>
                  <output className="w-12 text-center text-[18px] font-semibold" aria-live="polite">
                    {target !== line.requested && <span className="mr-1 text-[13px] font-normal text-text-muted line-through">{line.requested}</span>}
                    {target}
                  </output>
                  <button aria-label={`One more ${line.sku}`} onClick={() => step(line.id, 1)} className="size-11 rounded-[var(--radius-control)] border border-border-strong text-[18px]">+</button>
                </span>
              </span>
              {back > 0 && <span className="text-[13px] text-accent">{copy.revise.returnFirst(back)}</span>}
            </li>
          );
        })}
      </ul>
      <label className="flex flex-col gap-1.5 text-[13px] text-text-secondary">
        {copy.revise.reason}
        <input value={reason} maxLength={280} onChange={(event) => setReason(event.target.value)} className="rounded-[var(--radius-control)] bg-surface-recessed px-3 py-2.5 text-[16px] text-text-primary" />
      </label>
      <PrimaryButton disabled={busy || changes.length === 0} onClick={() => onSubmit({ type: "REVISE_ORDER", payload: { reason: reason.trim() || copy.revise.reasonDefault, changes } })}>
        {changes.length === 0 ? copy.revise.nothing : copy.revise.confirm}
      </PrimaryButton>
      <GhostButton onClick={onClose}>{copy.revise.cancel}</GhostButton>
    </Sheet>
  );
}
