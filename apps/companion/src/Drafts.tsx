// Orders from the group that named an unknown item, or an alias several
// products share. The list sits above the orders while any are open; the page
// lets a coordinator choose a product for each line and create the order.
// The server checks the lines again, so this page only has to make a valid
// choice easy, not enforce it.

import { useEffect, useState } from "react";
import { ApiError, confirmDraft, discardDraft, getDraft, listDrafts, listProducts, type Draft, type Product } from "./api.ts";
import { copy } from "./copy.ts";
import { usePolling } from "./polling.ts";
import { haptic } from "./telegram.ts";
import { BackLink, GhostButton, PrimaryButton } from "./ui.tsx";

const day = new Intl.DateTimeFormat("en", { day: "numeric", month: "short" });

export function DraftList({ token, workspaceId, onOpen }: { token: string; workspaceId: string; onOpen: (draftId: string) => void }) {
  const { data } = usePolling(() => listDrafts(token, workspaceId), [workspaceId], 15_000);
  if (!data || data.drafts.length === 0) return null;
  return (
    <section aria-label={copy.drafts.title} className="flex flex-col gap-2.5">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.073em] text-accent">{copy.drafts.title}</h2>
      <ul className="overflow-hidden rounded-[var(--radius-card)] bg-surface-attention shadow-[var(--shadow-key)]">
        {data.drafts.map((draft, index) => (
          <li key={draft.id} className={index > 0 ? "border-t border-border" : ""}>
            <button onClick={() => onOpen(draft.id)} className="flex min-h-14 w-full flex-col gap-0.5 px-4 py-3 text-left">
              <span className="font-mono text-[15px]">{draft.ref ?? copy.drafts.untitled}</span>
              <span className="text-[12px] text-text-secondary">{copy.drafts.line(draft.lines.length, draft.createdBy)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

type Props = { token: string; workspaceId: string; draftId: string; onBack: () => void; onCreated: (orderId: string) => void };
type Line = { item: string; quantity: number; sku: string | null; candidates: string[] };

export function DraftPage({ token, workspaceId, draftId, onBack, onCreated }: Props) {
  const [draft, setDraft] = useState<Draft | null | "gone">(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [busy, setBusy] = useState(false);
  const [isDiscarding, setIsDiscarding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getDraft(token, workspaceId, draftId)
      .then((loaded) => {
        if (cancelled) return;
        setDraft(loaded);
        setLines(loaded.lines.map((line) => ({ ...line })));
      })
      .catch(() => !cancelled && setDraft("gone"));
    void listProducts(token, workspaceId).then((loaded) => !cancelled && setProducts(loaded.products));
    return () => {
      cancelled = true;
    };
  }, [token, workspaceId, draftId]);

  const chosen = lines.map((line) => line.sku).filter((sku): sku is string => sku !== null);
  const repeated = new Set(chosen.filter((sku, index) => chosen.indexOf(sku) !== index));
  const isReady = lines.length > 0 && lines.every((line) => line.sku !== null) && repeated.size === 0;
  const units = lines.reduce((sum, line) => sum + line.quantity, 0);

  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      haptic("error");
      setError(copy.errors[failure instanceof ApiError ? failure.code : "UNKNOWN"] ?? copy.errors.UNKNOWN!);
      setBusy(false);
    }
  }

  const create = () =>
    act(async () => {
      const created = await confirmDraft(token, workspaceId, draftId, lines.map((line) => ({ sku: line.sku!, quantity: line.quantity })));
      haptic("success");
      onCreated(created.orderId);
    });

  const discard = () =>
    act(async () => {
      await discardDraft(token, workspaceId, draftId);
      haptic("success");
      onBack();
    });

  return (
    <section className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <BackLink label={copy.drafts.back} onBack={onBack} />
        <h1 className="font-mono text-2xl font-medium">{draft && draft !== "gone" ? (draft.ref ?? copy.drafts.untitled) : copy.drafts.untitled}</h1>
      </div>
      {draft === "gone" && <p className="text-[14px] text-text-muted">{copy.drafts.gone}</p>}
      {draft && draft !== "gone" && (
        <>
          <p className="text-[14px] leading-normal text-text-secondary">{copy.drafts.hint}</p>
          <ul className="flex flex-col gap-2.5">
            {lines.map((line, index) => (
              <DraftRow
                key={`${line.item}-${index}`}
                line={line}
                products={products}
                isRepeated={line.sku !== null && repeated.has(line.sku)}
                onChoose={(sku) => setLines((current) => current.map((other, at) => (at === index ? { ...other, sku } : other)))}
                onRemove={() => setLines((current) => current.filter((_, at) => at !== index))}
              />
            ))}
          </ul>
          {error && <p role="alert" className="rounded-[var(--radius-control)] bg-surface-attention px-4 py-3 text-[14px]">{error}</p>}
          <PrimaryButton disabled={!isReady || busy} onClick={() => void create()}>
            {busy && !isDiscarding ? copy.drafts.confirming : copy.drafts.confirm(units)}
          </PrimaryButton>
          {isDiscarding ? (
            <GhostButton disabled={busy} onClick={() => void discard()}>{copy.drafts.discardConfirm}</GhostButton>
          ) : (
            <GhostButton onClick={() => setIsDiscarding(true)}>{copy.drafts.discard}</GhostButton>
          )}
          <p className="text-[12px] text-text-muted">{copy.drafts.expires(day.format(new Date(draft.expiresAt)))}</p>
        </>
      )}
    </section>
  );
}

type RowProps = { line: Line; products: Product[]; isRepeated: boolean; onChoose: (sku: string | null) => void; onRemove: () => void };

function DraftRow({ line, products, isRepeated, onChoose, onRemove }: RowProps) {
  // An ambiguous name lists what it could mean first; anything else can be any product.
  const likely = products.filter((product) => line.candidates.includes(product.sku));
  const label = (product: Product) => `${product.name} · ${product.sku}`;
  const status = line.candidates.length > 0 ? copy.drafts.ambiguous(line.candidates.length) : copy.drafts.unknown;
  const wasClear = line.sku !== null && line.candidates.length === 0;
  return (
    <li className="flex flex-col gap-2 rounded-[var(--radius-card)] bg-surface px-4 py-3.5 shadow-[var(--shadow-key)]">
      <span className="flex items-baseline justify-between gap-3">
        <span className="truncate font-mono text-[14px]">{copy.drafts.typed(line.item, line.quantity)}</span>
        {!wasClear && <span className="shrink-0 text-[12px] text-pending">{status}</span>}
      </span>
      <select
        aria-label={copy.drafts.choose}
        value={line.sku ?? ""}
        onChange={(event) => onChoose(event.target.value || null)}
        className="min-h-11 rounded-[var(--radius-control)] bg-surface-recessed px-3 text-[15px] text-text-primary"
      >
        <option value="">{copy.drafts.choose}</option>
        {likely.length > 0 && (
          <optgroup label={copy.drafts.likely}>
            {likely.map((product) => <option key={product.sku} value={product.sku}>{label(product)}</option>)}
          </optgroup>
        )}
        <optgroup label={copy.drafts.everything}>
          {products.filter((product) => !line.candidates.includes(product.sku)).map((product) => <option key={product.sku} value={product.sku}>{label(product)}</option>)}
        </optgroup>
      </select>
      {isRepeated && <span role="alert" className="text-[12px] text-pending">{copy.drafts.twice}</span>}
      <button onClick={onRemove} className="min-h-11 self-start text-[13px] font-medium text-accent">{copy.drafts.remove(line.item)}</button>
    </li>
  );
}
