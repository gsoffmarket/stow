// Workspace settings: the time zone reports use and how long closed orders
// are kept, plus a plain statement of what Stow stores. Owners edit; everyone
// else on the console reads. Shortening retention deletes data within the
// hour, so the page says so before Save.

import { useEffect, useState } from "react";
import { ApiError, getSettings, saveSettings, type WorkspaceSettings } from "./api.ts";
import { copy } from "./copy.ts";
import { haptic } from "./telegram.ts";
import { BackLink, PrimaryButton } from "./ui.tsx";

type Props = { token: string; workspaceId: string; isOwner: boolean; onBack: () => void };
type Retention = WorkspaceSettings["retentionDays"];

const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const zones = Intl.supportedValuesOf("timeZone");
const retentions: Retention[] = [90, 365, null];

// How many days a choice keeps, with "forever" as the longest.
const span = (retention: Retention) => retention ?? Infinity;

export function Settings({ token, workspaceId, isOwner, onBack }: Props) {
  const [saved, setSaved] = useState<WorkspaceSettings | null>(null);
  const [draft, setDraft] = useState<WorkspaceSettings | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSettings(token, workspaceId).then((loaded) => {
      setSaved(loaded);
      setDraft(loaded);
    }, (failure) => setError(message(failure)));
  }, [token, workspaceId]);

  async function save() {
    if (!draft) return;
    setStatus("saving");
    setError(null);
    try {
      const next = await saveSettings(token, workspaceId, draft);
      setSaved(next);
      setDraft(next);
      setStatus("saved");
      haptic("success");
    } catch (failure) {
      setStatus("idle");
      setError(message(failure));
      haptic("error");
    }
  }

  const isChanged = saved && draft && (saved.timeZone !== draft.timeZone || saved.retentionDays !== draft.retentionDays);
  const isShorter = saved && draft && span(draft.retentionDays) < span(saved.retentionDays);

  return (
    <section className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <BackLink label={copy.settings.back} onBack={onBack} />
        <h1 className="text-2xl font-medium">{copy.settings.title}</h1>
      </div>
      {!isOwner && <p className="text-[13px] text-text-muted">{copy.settings.ownerOnly}</p>}

      {draft && (
        <>
          <fieldset disabled={!isOwner} className="flex flex-col gap-2">
            <legend className="mb-2 text-[11px] font-semibold uppercase tracking-[0.073em] text-text-secondary">{copy.settings.zoneTitle}</legend>
            <select
              value={draft.timeZone}
              onChange={(event) => setDraft({ ...draft, timeZone: event.target.value })}
              aria-label={copy.settings.zoneTitle}
              className="min-h-11 rounded-[var(--radius-control)] bg-surface-recessed px-3 text-[16px] text-text-primary [color-scheme:dark] disabled:opacity-60"
            >
              {(zones.includes(draft.timeZone) ? zones : [draft.timeZone, ...zones]).map((zone) => <option key={zone} value={zone}>{zone}</option>)}
            </select>
            {isOwner && draft.timeZone !== deviceZone && (
              <button type="button" onClick={() => setDraft({ ...draft, timeZone: deviceZone })} className="self-start text-[13px] font-medium text-accent">
                {copy.settings.useDevice(deviceZone)}
              </button>
            )}
            <p className="text-[12px] text-text-muted">{copy.settings.zoneHint}</p>
          </fieldset>

          <fieldset disabled={!isOwner} className="flex flex-col gap-2">
            <legend className="mb-2 text-[11px] font-semibold uppercase tracking-[0.073em] text-text-secondary">{copy.settings.historyTitle}</legend>
            {retentions.map((retention) => (
              <label key={String(retention)} className="flex min-h-11 items-center gap-3 rounded-[var(--radius-control)] bg-surface-recessed px-3 text-[14px] has-[:checked]:bg-surface-raised">
                <input type="radio" name="retention" checked={draft.retentionDays === retention} onChange={() => setDraft({ ...draft, retentionDays: retention })} className="accent-[var(--color-accent)]" />
                {copy.settings.retention[retention ?? "forever"]}
              </label>
            ))}
            <p className="text-[12px] leading-normal text-text-muted">{copy.settings.retentionHint}</p>
          </fieldset>

          {isOwner && (
            <div className="flex flex-col gap-2">
              {isShorter && draft.retentionDays !== null && (
                <p role="alert" className="rounded-[var(--radius-control)] bg-surface-attention px-4 py-3 text-[14px]">{copy.settings.shorter(draft.retentionDays)}</p>
              )}
              <PrimaryButton disabled={!isChanged || status === "saving"} onClick={() => void save()}>
                {status === "saving" ? copy.settings.saving : copy.settings.save}
              </PrimaryButton>
              {status === "saved" && !isChanged && <p role="status" className="text-[13px] text-confirmed">{copy.settings.saved}</p>}
            </div>
          )}
        </>
      )}
      {error && <p role="alert" className="rounded-[var(--radius-control)] bg-surface-attention px-4 py-3 text-[14px]">{error}</p>}

      <section className="flex flex-col gap-2.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.073em] text-text-secondary">{copy.settings.privacyTitle}</h2>
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[13px] leading-normal text-text-secondary">
          {copy.settings.privacy.map((line) => <li key={line}>{line}</li>)}
        </ul>
        <p className="text-[13px] leading-normal text-text-muted">{copy.settings.deletion}</p>
        <p className="text-[13px] text-text-muted">{copy.settings.locale}</p>
      </section>
    </section>
  );
}

function message(failure: unknown): string {
  return copy.errors[failure instanceof ApiError ? failure.code : "UNKNOWN"] ?? copy.errors.UNKNOWN!;
}
