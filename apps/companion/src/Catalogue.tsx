// The catalogue: what the workspace stocks, and importing more from CSV.
// Import always previews first; nothing is written until the person commits,
// and changes to existing products need their own explicit tick.

import { AnimatePresence, m } from "motion/react";
import { useState } from "react";
import { ApiError, commitImport, listProducts, previewImport, type PreviewRow, type RowError } from "./api.ts";
import { copy } from "./copy.ts";
import { usePolling } from "./polling.ts";
import { haptic } from "./telegram.ts";
import { PrimaryButton } from "./ui.tsx";

type Props = { token: string; workspaceId: string; onBack: () => void };
type Checked = { rows: PreviewRow[]; errors: RowError[] };

export function Catalogue({ token, workspaceId, onBack }: Props) {
  const { data, refresh } = usePolling(() => listProducts(token, workspaceId), [workspaceId], 30_000);
  const [csv, setCsv] = useState("");
  const [checked, setChecked] = useState<Checked | null>(null);
  const [allowUpdates, setAllowUpdates] = useState(false);
  const [state, setState] = useState<"idle" | "checking" | "importing">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const updates = checked?.rows.filter((row) => row.fate === "UPDATE").length ?? 0;
  const writes = checked?.rows.filter((row) => row.fate !== "UNCHANGED").length ?? 0;
  // The server refuses the whole file when it would change existing products
  // without permission, so the button waits for the tick rather than failing.
  const needsTick = updates > 0 && !allowUpdates;

  async function check() {
    setState("checking");
    setMessage(null);
    try {
      setChecked(await previewImport(token, workspaceId, csv));
    } catch (error) {
      setMessage(copy.errors[error instanceof ApiError ? error.code : "UNKNOWN"] ?? copy.errors.UNKNOWN!);
    } finally {
      setState("idle");
    }
  }

  async function save() {
    setState("importing");
    try {
      const done = await commitImport(token, workspaceId, csv, allowUpdates);
      haptic("success");
      setMessage(copy.catalogue.done(done.added, done.updated));
      setCsv("");
      setChecked(null);
      await refresh();
    } catch (error) {
      haptic("error");
      setMessage(copy.errors[error instanceof ApiError ? error.code : "UNKNOWN"] ?? copy.errors.UNKNOWN!);
    } finally {
      setState("idle");
    }
  }

  return (
    <section className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <button onClick={onBack} aria-label={copy.catalogue.back} className="flex size-10 items-center justify-center rounded-[var(--radius-control)]">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <h1 className="text-2xl font-medium">{copy.catalogue.title}</h1>
        {data && <span className="ml-auto text-[13px] text-text-secondary">{copy.catalogue.count(data.products.length)}</span>}
      </div>

      <section className="flex flex-col gap-3 rounded-[var(--radius-card)] bg-surface p-4 shadow-[var(--shadow-key)]">
        <h2 className="text-[17px] font-medium">{copy.catalogue.importTitle}</h2>
        <p className="text-[13px] text-text-secondary">{copy.catalogue.importHint}</p>
        <label className="flex flex-col gap-1.5 text-[13px] text-text-secondary">
          {copy.catalogue.paste}
          <textarea
            value={csv}
            onChange={(event) => {
              setCsv(event.target.value);
              setChecked(null);
            }}
            rows={5}
            spellCheck={false}
            placeholder={"sku,name,bin\nTS-BLK-M,Black T-shirt (M),A-03"}
            className="rounded-[var(--radius-control)] bg-surface-recessed px-3 py-2.5 font-mono text-[13px] text-text-primary placeholder:text-text-muted"
          />
        </label>
        <label className="text-[13px] text-text-secondary">
          {copy.catalogue.file}
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            className="mt-1.5 block w-full text-[13px] file:mr-3 file:rounded-[var(--radius-control)] file:border file:border-border-strong file:bg-transparent file:px-3 file:py-2 file:text-text-primary"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              setCsv(await file.text());
              setChecked(null);
            }}
          />
        </label>
        {!checked && (
          <PrimaryButton disabled={!csv.trim() || state !== "idle"} onClick={() => void check()}>
            {state === "checking" ? copy.catalogue.checking : copy.catalogue.preview}
          </PrimaryButton>
        )}

        <AnimatePresence>
          {checked && checked.errors.length > 0 && (
            <m.div role="alert" initial={{ opacity: 0.6, y: -4 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-1.5 rounded-[var(--radius-control)] bg-surface-attention p-3">
              <span className="text-[14px] font-medium text-accent">{copy.catalogue.errorsTitle(checked.errors.length)}</span>
              {checked.errors.slice(0, 20).map((error) => (
                <span key={`${error.line}-${error.field}`} className="text-[13px]">
                  {copy.catalogue.errorLine(error.line, error.field, error.problem)}
                </span>
              ))}
            </m.div>
          )}
          {checked && checked.errors.length === 0 && (
            <m.div initial={{ opacity: 0.6, y: -4 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-3">
              <ul className="flex max-h-72 flex-col overflow-y-auto rounded-[var(--radius-control)] bg-surface-recessed">
                {checked.rows.map((row) => (
                  <li key={row.sku} className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0">
                    <span className="w-24 shrink-0 truncate font-mono text-[12px]">{row.sku}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px]">{row.name}</span>
                    <span className={`text-[11px] font-semibold uppercase tracking-[0.04em] ${row.fate === "NEW" ? "text-confirmed" : row.fate === "UPDATE" ? "text-pending" : "text-text-muted"}`}>
                      {copy.catalogue.fates[row.fate]}
                    </span>
                  </li>
                ))}
              </ul>
              {updates > 0 && (
                <label className="flex min-h-11 items-center gap-3 text-[14px]">
                  <input type="checkbox" checked={allowUpdates} onChange={(event) => setAllowUpdates(event.target.checked)} className="size-5 accent-[var(--color-action)]" />
                  {copy.catalogue.allowUpdates(updates)}
                </label>
              )}
              <PrimaryButton disabled={writes === 0 || needsTick || state !== "idle"} onClick={() => void save()}>
                {state === "importing" ? copy.catalogue.importing : needsTick ? copy.catalogue.tickFirst : copy.catalogue.commit(writes)}
              </PrimaryButton>
            </m.div>
          )}
        </AnimatePresence>
        {message && <p role="status" className="text-[14px]">{message}</p>}
      </section>

      {data && data.products.length === 0 && <p className="text-center text-[14px] text-text-muted">{copy.catalogue.empty}</p>}
      {data && data.products.length > 0 && (
        <ul className="overflow-hidden rounded-[var(--radius-card)] bg-surface shadow-[var(--shadow-key)]">
          {data.products.map((product, index) => (
            <li key={product.sku} className={`flex items-center gap-3 px-4 py-3 ${index > 0 ? "border-t border-border" : ""}`}>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px]">{product.name}</span>
                <span className="block font-mono text-[12px] text-text-secondary">{product.sku}</span>
              </span>
              <span className="font-mono text-[12px] text-text-muted">{product.bin ?? "—"}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
