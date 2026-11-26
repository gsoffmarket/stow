// The coordinator's order list: what needs them, what is moving, what closed.
// The first page refreshes every few seconds; rows that change move smoothly,
// and an order that just arrived from the group sweeps in once. Older pages
// load on request and are not polled: the server pages by last activity, so
// an order that changes jumps back to the live first page.

import { AnimatePresence, m } from "motion/react";
import { useEffect, useState } from "react";
import { listOrders, type OrderRow, type View } from "./api.ts";
import { copy } from "./copy.ts";
import { NewOrder } from "./NewOrder.tsx";
import { usePolling } from "./polling.ts";
import { GhostButton } from "./ui.tsx";

type Props = { token: string; workspaceId: string; onOpen: (orderId: string) => void };

const views: View[] = ["needs_you", "active", "done"];
const settle = { type: "spring", visualDuration: 0.35, bounce: 0.15 } as const;

export function Orders({ token, workspaceId, onOpen }: Props) {
  const [view, setView] = useState<View>("active");
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  const { data, isLive } = usePolling(() => listOrders(token, workspaceId, view, search), [view, search], 3000);
  const [older, setOlder] = useState<{ orders: OrderRow[]; next: string | null } | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [needsYou, setNeedsYou] = useState(0);
  const [isCreating, setIsCreating] = useState(false);
  const firstPage = data?.orders ?? null;
  const firstIds = new Set(firstPage?.map((order) => order.id));
  const orders = firstPage && [...firstPage, ...(older?.orders.filter((order) => !firstIds.has(order.id)) ?? [])];
  const next = older ? older.next : (data?.next ?? null);

  // Searching waits for a pause in typing, so each keystroke is not a request.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(typed.trim()), 300);
    return () => clearTimeout(timer);
  }, [typed]);
  useEffect(() => setOlder(null), [view, search]);
  useEffect(() => {
    if (view === "needs_you" && firstPage && !search) setNeedsYou(firstPage.length);
  }, [view, firstPage, search]);

  async function loadMore() {
    if (!next) return;
    setIsLoadingMore(true);
    try {
      const page = await listOrders(token, workspaceId, view, search, next);
      setOlder((current) => ({ orders: [...(current?.orders ?? []), ...page.orders], next: page.next }));
    } finally {
      setIsLoadingMore(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-medium">{copy.orders.title}</h1>
        <span className="mr-auto"><LiveDot isLive={isLive} /></span>
        <button onClick={() => setIsCreating(true)} className="min-h-10 rounded-[var(--radius-control)] bg-action px-3 text-[13px] font-medium text-action-text">
          {copy.newOrder.open}
        </button>
      </div>
      <div role="tablist" aria-label={copy.orders.title} className="grid grid-cols-3 gap-1 rounded-[10px] bg-surface-recessed p-1">
        {views.map((option) => (
          <button
            key={option}
            role="tab"
            aria-selected={view === option}
            onClick={() => setView(option)}
            className="relative min-h-10 rounded-[var(--radius-control)] text-[13px] font-medium text-text-secondary aria-selected:text-text-primary"
          >
            {view === option && <m.span layoutId="tab" transition={settle} className="absolute inset-0 rounded-[var(--radius-control)] bg-surface-raised shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]" />}
            <span className="relative">
              {copy.orders.views[option]}
              {option === "needs_you" && needsYou > 0 ? ` · ${needsYou}` : ""}
            </span>
          </button>
        ))}
      </div>
      <input
        type="search"
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        placeholder={copy.orders.search}
        aria-label={copy.orders.search}
        maxLength={40}
        className="min-h-11 rounded-[var(--radius-control)] bg-surface-recessed px-3 text-[16px] text-text-primary placeholder:text-text-muted"
      />
      {orders && orders.length === 0 && <p className="py-8 text-center text-[14px] text-text-muted">{search ? copy.orders.noMatch(search, view) : copy.orders.empty[view]}</p>}
      <ul className="flex flex-col gap-2.5">
        <AnimatePresence mode="popLayout" initial={false}>
          {orders?.map((order) => (
            <m.li key={order.id} layout initial={{ opacity: 0.6, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={settle}>
              <OrderCard order={order} onOpen={() => onOpen(order.id)} />
            </m.li>
          ))}
        </AnimatePresence>
      </ul>
      {next && (
        <GhostButton disabled={isLoadingMore} onClick={() => void loadMore()}>
          {isLoadingMore ? copy.orders.loadingMore : copy.orders.more}
        </GhostButton>
      )}
      <AnimatePresence>
        {isCreating && <NewOrder token={token} workspaceId={workspaceId} onClose={() => setIsCreating(false)} onCreated={onOpen} />}
      </AnimatePresence>
    </section>
  );
}

function OrderCard({ order, onOpen }: { order: OrderRow; onOpen: () => void }) {
  const needsYou = order.hold === "BLOCKED";
  const isNew = Date.now() - Date.parse(order.createdAt) < 60_000 && !order.picker;
  return (
    <m.button
      onClick={onOpen}
      whileTap={{ scale: 0.98 }}
      transition={{ type: "spring", visualDuration: 0.2, bounce: 0.1 }}
      className={`relative flex w-full flex-col gap-2 overflow-hidden rounded-[var(--radius-card)] px-4 py-3.5 text-left ${
        needsYou ? "bg-surface-attention shadow-[inset_2px_0_0_0_var(--color-accent)]" : order.terminal ? "border border-border" : "bg-surface shadow-[var(--shadow-key)]"
      }`}
    >
      {isNew && (
        <m.span
          aria-hidden="true"
          initial={{ x: "-100%" }}
          animate={{ x: "100%" }}
          transition={{ duration: 0.6, ease: [0.2, 0, 0, 1] }}
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,transparent,rgba(255,99,99,0.28),transparent)]"
        />
      )}
      <span className="flex items-center justify-between gap-3">
        <span className={`font-mono text-[14px] font-medium ${order.terminal ? "text-text-secondary" : ""}`}>{order.ref}</span>
        <StatusChip order={order} />
      </span>
      {!order.terminal && <span className="text-[22px] font-medium leading-tight">{copy.orders.progress(order.confirmed, order.requested)}</span>}
      {!order.terminal && order.requested > 0 && (
        <span aria-hidden="true" className="h-1 overflow-hidden rounded-full bg-surface-raised">
          <m.span
            className="block h-1 rounded-full bg-confirmed"
            initial={false}
            animate={{ width: `${(order.confirmed / order.requested) * 100}%` }}
            transition={{ type: "spring", visualDuration: 0.2, bounce: 0.1 }}
          />
        </span>
      )}
      <span className="text-[12px] text-text-secondary">
        {order.picker ? [order.picker, order.toteId && `Tote ${order.toteId}`].filter(Boolean).join(" · ") : copy.orders.unassigned}
      </span>
    </m.button>
  );
}

/** StatusChip names an order's state in words, with color only as a second cue. */
export function StatusChip({ order }: { order: OrderRow }) {
  const label = order.terminal ? copy.phase[order.terminal] : order.hold !== "NONE" ? copy.hold[order.hold] : order.picker ? copy.phase.PICKING : copy.phase.QUEUED;
  const tone =
    order.hold === "BLOCKED" ? "text-accent"
    : order.hold !== "NONE" ? "text-pending"
    : order.terminal ? "text-text-secondary"
    : order.picker ? "text-confirmed"
    : "text-text-secondary";
  return (
    <m.span layout className={`rounded-[var(--radius-badge)] bg-surface-raised px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.04em] ${tone}`}>
      {label}
    </m.span>
  );
}

/** LiveDot breathes only while updates are actually arriving. */
export function LiveDot({ isLive }: { isLive: boolean }) {
  return (
    <span className="flex items-center gap-1.5 text-[12px] text-text-secondary">
      <m.span
        aria-hidden="true"
        className={`size-[7px] rounded-full ${isLive ? "bg-confirmed" : "bg-text-muted"}`}
        animate={isLive ? { opacity: [1, 0.35, 1] } : { opacity: 1 }}
        transition={isLive ? { duration: 2.4, repeat: Infinity, ease: "easeInOut" } : { duration: 0 }}
      />
      {isLive ? copy.orders.live : copy.orders.offline}
    </span>
  );
}
