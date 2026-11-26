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
  /** What is holding the order up, if anything. */
  readonly hold: "NONE" | "AWAITING_PICKER_ACK" | "BLOCKED" | "CANCELLING" | "RELEASING" | "PAUSED";
  /** The state of the latest coordinator note, shown so the group knows it landed. */
  readonly note: "NONE" | "UNREAD" | "READ";
};

// Telegram rejects messages longer than 4096 characters; long orders are cut
// with an explicit marker rather than failing to send.
const maxLength = 4096;

/** renderStatus produces the status message text for an order. */
export function renderStatus(status: OrderStatus): string {
  const held = { NONE: null, AWAITING_PICKER_ACK: "AWAITING PICKER", BLOCKED: "BLOCKED", CANCELLING: "CANCELLING", RELEASING: "RELEASING", PAUSED: "PAUSED" }[status.hold];
  const phase = status.terminal ?? held ?? (status.picker ? "PICKING" : "QUEUED");
  const confirmed = status.lines.reduce((sum, line) => sum + Math.min(line.picked, line.requested), 0);
  const requested = status.lines.reduce((sum, line) => sum + line.requested, 0);
  const who = [status.toteId ? `Tote ${status.toteId}` : null, status.picker].filter(Boolean).join(" · ");
  const lines = status.lines.map((line) => {
    const excess = line.picked - line.requested;
    return `${line.sku}: ${Math.min(line.picked, line.requested)}/${line.requested}${excess > 0 ? ` · return ${excess}` : ""}`;
  });
  const footer =
    status.terminal === "COMPLETED"
      ? `${confirmed} ${confirmed === 1 ? "unit" : "units"} confirmed by the picker. Not independently verified.`
      : status.picker
        ? `Progress: ${confirmed}/${requested} confirmed.`
        : `${status.lines.length} lines / ${requested} units. Awaiting picker.`;
  const note = { NONE: "", UNREAD: "Note sent to the picker.", READ: "Note read by the picker." }[status.note];
  const text = [`${status.ref} · ${phase} · rev ${status.revision}`, who, ...lines, footer, note].filter((part) => part !== "").join("\n");
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 20)}\n… (truncated)`;
}

/** ExceptionNotice is a picker's report as the coordinator sees it. */
export type ExceptionNotice = {
  readonly ref: string;
  readonly type: "SHORTAGE" | "DAMAGED" | "LOCATION_MISMATCH" | "RETURN_BLOCKED" | "OTHER";
  readonly sku: string;
  readonly requested: number;
  readonly picked: number;
  readonly reportedQty: number | null;
  readonly picker: string;
  /** Set once a coordinator has decided; the buttons go away. */
  readonly decision: string | null;
};

const exceptionLabels: Record<ExceptionNotice["type"], string> = {
  SHORTAGE: "Shortage",
  DAMAGED: "Damaged item",
  LOCATION_MISMATCH: "Not at this location",
  RETURN_BLOCKED: "Cannot return",
  OTHER: "Problem",
};

/** renderException produces the message that asks a coordinator to decide. */
export function renderException(notice: ExceptionNotice): string {
  const found = notice.reportedQty === null ? "" : ` · ${notice.reportedQty} more found`;
  return [
    `${notice.ref} · ${exceptionLabels[notice.type].toUpperCase()}`,
    `${notice.sku} · ${notice.picked}/${notice.requested} picked${found}`,
    `Reported by ${notice.picker}.`,
    notice.decision ? `Decision: ${notice.decision}` : "Awaiting your decision.",
  ].join("\n");
}

/**
 * reducedTarget is what "Reduce" offers: what is already in the tote plus
 * what the picker says is still there. With no count, only what is picked.
 */
export function reducedTarget(notice: Pick<ExceptionNotice, "picked" | "reportedQty" | "requested">): number {
  return Math.min(notice.requested, notice.picked + (notice.reportedQty ?? 0));
}

/** renderReply is how a picker's quick reply appears in the group. */
export function renderReply(picker: string, ref: string, body: string): string {
  return `${picker} · ${ref}: ${body}`;
}
