// The one status message Stow keeps per order in the work group, edited in
// place as work moves. It is plain text: no parse mode, so names and SKUs
// from the catalogue can never inject formatting or links.

/** OrderStatus is the committed state the message describes. */
export type OrderStatus = {
  readonly ref: string;
  readonly revision: number;
  readonly terminal: "COMPLETED" | "CANCELLED" | null;
  readonly picker: string | null;
  readonly toteId: string | null;
  readonly lines: readonly { readonly sku: string; readonly requested: number; readonly picked: number }[];
};

// Telegram rejects messages longer than 4096 characters; long orders are cut
// with an explicit marker rather than failing to send.
const maxLength = 4096;

/** renderStatus produces the status message text for an order. */
export function renderStatus(status: OrderStatus): string {
  const phase = status.terminal ?? (status.picker ? "PICKING" : "QUEUED");
  const confirmed = status.lines.reduce((sum, line) => sum + Math.min(line.picked, line.requested), 0);
  const requested = status.lines.reduce((sum, line) => sum + line.requested, 0);
  const who = [status.toteId ? `Tote ${status.toteId}` : null, status.picker].filter(Boolean).join(" · ");
  const lines = status.lines.map((line) => {
    const excess = line.picked - line.requested;
    return `${line.sku}: ${Math.min(line.picked, line.requested)}/${line.requested}${excess > 0 ? ` · return ${excess}` : ""}`;
  });
  const footer =
    status.terminal === "COMPLETED"
      ? `${confirmed} units confirmed by the picker. Not independently verified.`
      : status.picker
        ? `Progress: ${confirmed}/${requested} confirmed.`
        : `${status.lines.length} lines / ${requested} units. Awaiting picker.`;
  const text = [`${status.ref} · ${phase} · rev ${status.revision}`, who, ...lines, footer].filter((part) => part !== "").join("\n");
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 20)}\n… (truncated)`;
}
