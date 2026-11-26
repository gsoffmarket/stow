// The way from a new workspace to the first picked order. Every tick comes
// from the server's data, so the list resumes wherever the team left off,
// whether a step was done here, in the group or on the glasses. It goes away
// once the required steps are done; inviting a picker is optional because an
// owner can pick too.

import { m } from "motion/react";
import { getSetup, type Setup } from "./api.ts";
import { copy } from "./copy.ts";
import { usePolling } from "./polling.ts";
import { botLink } from "./telegram.ts";

type Step = keyof Setup;
type Destination = "catalogue" | "telegram" | "pair" | "bot";
type Props = { token: string; workspaceId: string; canPair: boolean; onGo: (destination: Destination) => void };

const order: readonly { step: Step; isOptional: boolean; go: Destination | null }[] = [
  { step: "hasCatalogue", isOptional: false, go: "catalogue" },
  { step: "hasGroup", isOptional: false, go: "telegram" },
  { step: "hasPicker", isOptional: true, go: "bot" },
  { step: "hasGlasses", isOptional: false, go: "pair" },
  { step: "hasCompletedOrder", isOptional: false, go: null },
];

export function SetupChecklist({ token, workspaceId, canPair, onGo }: Props) {
  const { data } = usePolling(() => getSetup(token, workspaceId), [workspaceId], 10_000);
  if (!data) return null;
  const required = order.filter((entry) => !entry.isOptional);
  const done = required.filter((entry) => data[entry.step]).length;
  if (done === required.length) return null;

  return (
    <section aria-label={copy.setup.title} className="flex flex-col gap-3 rounded-[var(--radius-card)] bg-surface px-4 py-4 shadow-[var(--shadow-key)]">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[17px] font-medium">{copy.setup.title}</h2>
        <span className="text-[12px] text-text-secondary">{copy.setup.progress(done, required.length)}</span>
      </div>
      <ol className="flex flex-col gap-3">
        {order.map(({ step, isOptional, go }) => {
          const isDone = data[step];
          const text = copy.setup.steps[step];
          const canGo = go !== null && !isDone && (go !== "pair" || canPair) && (go !== "bot" || botLink !== null);
          return (
            <li key={step} className="flex gap-3">
              <m.span
                aria-hidden="true"
                initial={false}
                animate={{ scale: isDone ? [1.25, 1] : 1 }}
                className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[11px] ${isDone ? "bg-confirmed text-canvas" : "border border-border-strong"}`}
              >
                {isDone ? "✓" : ""}
              </m.span>
              <span className="flex min-w-0 flex-col gap-1">
                <span className={`text-[14px] ${isDone ? "text-text-muted line-through" : ""}`}>
                  {text.title}
                  {isOptional && !isDone && <span className="ml-2 text-[11px] text-text-muted">{copy.setup.optional}</span>}
                </span>
                {!isDone && <span className="text-[12px] leading-normal text-text-secondary">{text.body}</span>}
                {canGo && (
                  <button onClick={() => onGo(go)} className="self-start text-[13px] font-medium text-accent">
                    {text.action}
                  </button>
                )}
              </span>
              <span className="sr-only">{isDone ? "done" : "not done"}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
