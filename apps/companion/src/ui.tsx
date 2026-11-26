// Shared building blocks in the Stow dark system (PRD §14.3). Motion follows
// §14.5: presses spring, entrances settle, nothing animates an outcome that
// has not happened.

import { m } from "motion/react";
import type { ReactNode } from "react";

const press = { type: "spring", visualDuration: 0.2, bounce: 0.1 } as const;

type ButtonProps = { children: ReactNode; onClick?: () => void; disabled?: boolean; type?: "button" | "submit" };

/** PrimaryButton is the one filled action on a screen. */
export function PrimaryButton({ children, onClick, disabled, type = "button" }: ButtonProps) {
  return (
    <m.button
      type={type}
      onClick={onClick}
      disabled={disabled}
      whileTap={disabled ? {} : { scale: 0.98 }}
      transition={press}
      className="w-full min-h-11 rounded-[var(--radius-control)] bg-action px-4 py-3 text-[15px] font-medium text-action-text shadow-[var(--shadow-lift)] disabled:opacity-50"
    >
      {children}
    </m.button>
  );
}

export function GhostButton({ children, onClick, type = "button" }: ButtonProps) {
  return (
    <m.button
      type={type}
      onClick={onClick}
      whileTap={{ scale: 0.98 }}
      transition={press}
      className="w-full min-h-11 rounded-[var(--radius-control)] border border-border-strong px-4 py-3 text-[15px] font-medium text-text-primary"
    >
      {children}
    </m.button>
  );
}

/** Card is a raised key-cap panel that settles in when it appears. */
export function Card({ children }: { children: ReactNode }) {
  return (
    <m.section
      initial={{ opacity: 0.6, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", visualDuration: 0.35, bounce: 0.15 }}
      className="flex flex-col gap-5 rounded-[var(--radius-panel)] bg-surface p-6 shadow-[var(--shadow-key)]"
    >
      {children}
    </m.section>
  );
}

/** Page is the full-height dark frame every screen sits in. */
export function Page({ children }: { children: ReactNode }) {
  return <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col gap-6 px-4 py-6">{children}</main>;
}

/** Mark is Stow's two-tote logo. */
export function Mark() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
      <rect x="2" y="8" width="13" height="12" rx="3" fill="var(--color-accent)" />
      <rect x="7" y="2" width="13" height="12" rx="3" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
