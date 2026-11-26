// Approving a pair of glasses: the picker types the code their G2 shows.

import { AnimatePresence, m } from "motion/react";
import { useState, type FormEvent } from "react";
import { ApiError, approvePairing, type Membership } from "./api.ts";
import { copy } from "./copy.ts";
import { haptic } from "./telegram.ts";
import { Card, GhostButton, PrimaryButton } from "./ui.tsx";

type Props = { token: string; workspaces: Membership[]; onBack: () => void };

// Shows what was typed as XXXX-XXXX while keeping only letters and digits.
function formatTyped(raw: string): string {
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

export function Pair({ token, workspaces, onBack }: Props) {
  const [code, setCode] = useState("");
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.workspaceId ?? "");
  const [state, setState] = useState<{ kind: "idle" } | { kind: "saving" } | { kind: "done"; label: string } | { kind: "error"; code: string }>({ kind: "idle" });
  const complete = code.replace("-", "").length === 8;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!complete || state.kind === "saving") return;
    setState({ kind: "saving" });
    try {
      const approved = await approvePairing(token, workspaceId, code);
      haptic("success");
      setState({ kind: "done", label: approved.label });
    } catch (error) {
      haptic("error");
      setState({ kind: "error", code: error instanceof ApiError ? error.code : "UNKNOWN" });
    }
  }

  if (state.kind === "done") {
    return (
      <Card>
        <m.div
          initial={{ scale: 0.92, opacity: 0.6 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", visualDuration: 0.25, bounce: 0.2 }}
          className="flex size-12 items-center justify-center rounded-full bg-surface-raised"
          aria-hidden="true"
        >
          <svg width="22" height="22" viewBox="0 0 22 22">
            <path d="M5 11.5l4 4 8-9" fill="none" stroke="var(--color-confirmed)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </m.div>
        <p role="status" className="text-[17px] leading-snug">{copy.pair.done(state.label)}</p>
        <GhostButton onClick={onBack}>{copy.pair.back}</GhostButton>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-medium">{copy.pair.title}</h1>
        <p className="text-[15px] leading-normal text-text-secondary">{copy.pair.body}</p>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
        <label className="flex flex-col gap-2 text-[13px] text-text-secondary">
          {copy.pair.label}
          <input
            value={code}
            onChange={(event) => setCode(formatTyped(event.target.value))}
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="one-time-code"
            spellCheck={false}
            placeholder="XXXX-XXXX"
            aria-invalid={state.kind === "error"}
            className="rounded-[var(--radius-control)] bg-surface-recessed px-4 py-3.5 text-center font-mono text-[26px] font-medium tracking-[0.2em] text-text-primary placeholder:text-text-muted aria-[invalid=true]:shadow-[0_0_0_1px_var(--color-accent)]"
          />
        </label>
        {workspaces.length > 1 && (
          <label className="flex flex-col gap-2 text-[13px] text-text-secondary">
            {copy.pair.workspace}
            <select
              value={workspaceId}
              onChange={(event) => setWorkspaceId(event.target.value)}
              className="rounded-[var(--radius-control)] bg-surface-recessed px-3 py-3 text-[16px] text-text-primary"
            >
              {workspaces.map((workspace) => (
                <option key={workspace.workspaceId} value={workspace.workspaceId}>
                  {workspace.workspaceName}
                </option>
              ))}
            </select>
          </label>
        )}
        <AnimatePresence>
          {state.kind === "error" && (
            <m.p
              role="alert"
              initial={{ opacity: 0.6, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              className="text-[14px] text-accent"
            >
              {copy.pair.errors[state.code] ?? copy.pair.errors.UNKNOWN}
            </m.p>
          )}
        </AnimatePresence>
        <PrimaryButton type="submit" disabled={!complete || state.kind === "saving"}>
          {state.kind === "saving" ? copy.pair.submitting : copy.pair.submit}
        </PrimaryButton>
      </form>
      <GhostButton onClick={onBack}>{copy.pair.back}</GhostButton>
    </Card>
  );
}
