// Typing an order in the Mini App, for orders that do not start in the group.
// Products come from the catalogue, so every line is valid before it is sent;
// the server still checks each one. One command ID per sheet means a retried
// submit returns the same order instead of creating a second.

import { m } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { ApiError, createOrder, listProducts, type Product } from "./api.ts";
import { copy } from "./copy.ts";
import { haptic } from "./telegram.ts";
import { GhostButton, PrimaryButton, Sheet } from "./ui.tsx";

type Props = { token: string; workspaceId: string; onClose: () => void; onCreated: (orderId: string) => void };
type Line = { product: Product; quantity: number };

const matches_max = 8;

export function NewOrder({ token, workspaceId, onClose, onCreated }: Props) {
  const [commandId] = useState(() => crypto.randomUUID());
  const [products, setProducts] = useState<Product[] | null>(null);
  const [query, setQuery] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listProducts(token, workspaceId).then((loaded) => setProducts(loaded.products));
  }, [token, workspaceId]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!products || needle === "") return [];
    const chosen = new Set(lines.map((line) => line.product.sku));
    return products
      .filter((product) => !chosen.has(product.sku) && [product.name, product.sku, product.bin ?? ""].some((field) => field.toLowerCase().includes(needle)))
      .slice(0, matches_max);
  }, [products, query, lines]);

  const units = lines.reduce((sum, line) => sum + line.quantity, 0);
  const change = (sku: string, delta: number) =>
    setLines((current) => current.flatMap((line) => (line.product.sku !== sku ? [line] : line.quantity + delta <= 0 ? [] : [{ ...line, quantity: Math.min(line.quantity + delta, 10_000) }])));

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const created = await createOrder(token, workspaceId, commandId, ref.trim() || null, lines.map((line) => ({ sku: line.product.sku, quantity: line.quantity })));
      haptic("success");
      onCreated(created.orderId);
    } catch (failure) {
      haptic("error");
      setError(copy.errors[failure instanceof ApiError ? failure.code : "UNKNOWN"] ?? copy.errors.UNKNOWN!);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet label={copy.newOrder.title} onClose={onClose}>
      <h2 className="text-[20px] font-medium">{copy.newOrder.title}</h2>

      {lines.length > 0 && (
        <ul className="overflow-hidden rounded-[var(--radius-card)] bg-surface-recessed">
          {lines.map(({ product, quantity }, index) => (
            <m.li key={product.sku} layout initial={{ opacity: 0.6, y: -4 }} animate={{ opacity: 1, y: 0 }} className={`flex items-center gap-3 px-3 py-2 ${index > 0 ? "border-t border-border" : ""}`}>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px]">{product.name}</span>
                <span className="block font-mono text-[12px] text-text-secondary">{[product.sku, product.bin].filter(Boolean).join(" · ")}</span>
              </span>
              <button aria-label={copy.newOrder.less(product.name)} onClick={() => change(product.sku, -1)} className="flex size-11 items-center justify-center rounded-[var(--radius-control)] border border-border-strong text-[18px]">−</button>
              <span className="w-8 text-center text-[17px] font-semibold tabular-nums" aria-live="polite">{quantity}</span>
              <button aria-label={copy.newOrder.more(product.name)} onClick={() => change(product.sku, 1)} className="flex size-11 items-center justify-center rounded-[var(--radius-control)] border border-border-strong text-[18px]">+</button>
            </m.li>
          ))}
        </ul>
      )}

      <label className="flex flex-col gap-1.5 text-[13px] text-text-secondary">
        {copy.newOrder.search}
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={copy.newOrder.searchHint}
          className="rounded-[var(--radius-control)] bg-surface-recessed px-3 py-2.5 text-[16px] text-text-primary placeholder:text-text-muted"
        />
      </label>
      {products?.length === 0 && <p className="text-[14px] text-text-muted">{copy.newOrder.emptyCatalogue}</p>}
      {query.trim() !== "" && products && products.length > 0 && matches.length === 0 && <p className="text-[14px] text-text-muted">{copy.newOrder.noMatch}</p>}
      {matches.length > 0 && (
        <ul className="flex flex-col">
          {matches.map((product) => (
            <li key={product.sku}>
              <button
                onClick={() => {
                  setLines((current) => [...current, { product, quantity: 1 }]);
                  setQuery("");
                }}
                className="flex min-h-11 w-full items-center justify-between gap-3 px-1 text-left text-[15px]"
              >
                <span className="truncate">{product.name}</span>
                <span className="shrink-0 font-mono text-[12px] text-text-secondary">{product.sku}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <label className="flex flex-col gap-1.5 text-[13px] text-text-secondary">
        {copy.newOrder.ref}
        <input
          value={ref}
          maxLength={40}
          onChange={(event) => setRef(event.target.value)}
          placeholder={copy.newOrder.refHint}
          className="rounded-[var(--radius-control)] bg-surface-recessed px-3 py-2.5 font-mono text-[16px] text-text-primary placeholder:font-sans placeholder:text-text-muted"
        />
      </label>

      {error && <p role="alert" className="rounded-[var(--radius-control)] bg-surface-attention px-4 py-3 text-[14px]">{error}</p>}
      <PrimaryButton disabled={units === 0 || busy} onClick={() => void submit()}>
        {busy ? copy.newOrder.creating : copy.newOrder.create(units)}
      </PrimaryButton>
      <GhostButton onClick={onClose}>{copy.newOrder.close}</GhostButton>
    </Sheet>
  );
}
