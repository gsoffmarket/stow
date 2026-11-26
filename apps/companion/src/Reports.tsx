// What happened over a range of days, and the order history as CSV. Ranges
// are whole days in this device's time zone; the definitions under the
// numbers say exactly what each one counts, so nobody reads a vanity metric.

import { m } from "motion/react";
import { useEffect, useState } from "react";
import { ApiError, getReport, ordersCsv, type RangeQuery, type Report } from "./api.ts";
import { copy } from "./copy.ts";
import { haptic } from "./telegram.ts";
import { BackLink, PrimaryButton } from "./ui.tsx";

type Props = { token: string; workspaceId: string; onBack: () => void };
type Preset = "today" | "week" | "month" | "custom";

const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const presets: Preset[] = ["today", "week", "month", "custom"];

// A local calendar date, n days before today, as YYYY-MM-DD.
function daysAgo(n: number): string {
  const day = new Date();
  day.setDate(day.getDate() - n);
  return day.toLocaleDateString("en-CA");
}

const presetRange = { today: 0, week: 6, month: 29 } as const;

export function Reports({ token, workspaceId, onBack }: Props) {
  const [preset, setPreset] = useState<Preset>("week");
  const [custom, setCustom] = useState({ from: daysAgo(6), to: daysAgo(0) });
  const [result, setResult] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  const range: RangeQuery = preset === "custom" ? { ...custom, timeZone } : { from: daysAgo(presetRange[preset]), to: daysAgo(0), timeZone };

  useEffect(() => {
    let cancelled = false;
    setError(null);
    getReport(token, workspaceId, range)
      .then((loaded) => !cancelled && setResult(loaded))
      .catch((failure) => !cancelled && setError(message(failure)));
    return () => {
      cancelled = true;
    };
    // The range is derived from these three values; listing it would refetch on every render.
  }, [token, workspaceId, preset, custom.from, custom.to]);

  async function download() {
    setIsExporting(true);
    try {
      const file = await ordersCsv(token, workspaceId, range);
      const link = document.createElement("a");
      link.href = URL.createObjectURL(file);
      link.download = `stow-orders-${range.from}-to-${range.to}.csv`;
      link.click();
      URL.revokeObjectURL(link.href);
      haptic("success");
    } catch (failure) {
      haptic("error");
      setError(message(failure));
    } finally {
      setIsExporting(false);
    }
  }

  const figures = result && [
    { label: copy.reports.created, value: result.orders.created },
    { label: copy.reports.completed, value: result.orders.completed },
    { label: copy.reports.cancelled, value: result.orders.cancelled },
    { label: copy.reports.units, value: result.unitsConfirmed },
    { label: copy.reports.problems, value: result.problems },
    { label: copy.reports.undelivered, value: result.undelivered, isWarning: result.undelivered > 0 },
  ];

  return (
    <section className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <BackLink label={copy.reports.back} onBack={onBack} />
        <h1 className="text-2xl font-medium">{copy.reports.title}</h1>
      </div>

      <div role="tablist" aria-label={copy.reports.title} className="grid grid-cols-4 gap-1 rounded-[10px] bg-surface-recessed p-1">
        {presets.map((option) => (
          <button
            key={option}
            role="tab"
            aria-selected={preset === option}
            onClick={() => setPreset(option)}
            className="relative min-h-10 rounded-[var(--radius-control)] text-[13px] font-medium text-text-secondary aria-selected:text-text-primary"
          >
            {preset === option && <m.span layoutId="range" className="absolute inset-0 rounded-[var(--radius-control)] bg-surface-raised" />}
            <span className="relative">{copy.reports.presets[option]}</span>
          </button>
        ))}
      </div>
      {preset === "custom" && (
        <div className="grid grid-cols-2 gap-2">
          {(["from", "to"] as const).map((end) => (
            <label key={end} className="flex flex-col gap-1.5 text-[13px] text-text-secondary">
              {copy.reports[end]}
              <input
                type="date"
                value={custom[end]}
                onChange={(event) => event.target.value && setCustom((current) => ({ ...current, [end]: event.target.value }))}
                className="min-h-11 rounded-[var(--radius-control)] bg-surface-recessed px-3 text-[16px] text-text-primary [color-scheme:dark]"
              />
            </label>
          ))}
        </div>
      )}
      <p className="text-[12px] text-text-muted">{copy.reports.zone(timeZone)}</p>

      {error && <p role="alert" className="rounded-[var(--radius-control)] bg-surface-attention px-4 py-3 text-[14px]">{error}</p>}
      {!result && !error && <p role="status" className="text-[14px] text-text-secondary">{copy.reports.loading}</p>}

      {figures && (
        <dl className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          {figures.map((figure) => (
            <div key={figure.label} className="flex flex-col gap-1 rounded-[var(--radius-card)] bg-surface px-4 py-3.5 shadow-[var(--shadow-key)]">
              <dt className="text-[12px] text-text-secondary">{figure.label}</dt>
              <dd className={`text-[28px] leading-tight font-medium tabular-nums ${figure.isWarning ? "text-accent" : ""}`}>{figure.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {result && (
        <section className="flex flex-col gap-2.5">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.073em] text-text-secondary">{copy.reports.byPicker}</h2>
          {result.pickers.length === 0 ? (
            <p className="text-[14px] text-text-muted">{copy.reports.nobody}</p>
          ) : (
            <ul className="overflow-hidden rounded-[var(--radius-card)] bg-surface shadow-[var(--shadow-key)]">
              {result.pickers.map((picker, index) => (
                <li key={picker.name} className={`flex items-center justify-between gap-3 px-4 py-3 ${index > 0 ? "border-t border-border" : ""}`}>
                  <span className="truncate text-[15px]">{picker.name}</span>
                  <span className="shrink-0 text-[13px] text-text-secondary">{copy.reports.pickerLine(picker.completed, picker.units)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <div className="flex flex-col gap-1.5">
        <PrimaryButton disabled={isExporting} onClick={() => void download()}>{isExporting ? copy.reports.exporting : copy.reports.export}</PrimaryButton>
        <p className="text-[12px] text-text-muted">{copy.reports.exportHint}</p>
      </div>

      <ul className="flex flex-col gap-1.5 text-[12px] leading-normal text-text-muted">
        {copy.reports.definitions.map((line) => <li key={line}>{line}</li>)}
      </ul>
    </section>
  );
}

function message(failure: unknown): string {
  return copy.errors[failure instanceof ApiError ? failure.code : "UNKNOWN"] ?? copy.errors.UNKNOWN!;
}
