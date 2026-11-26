// The order engine decides what physical work an order needs next and
// whether a picker's confirmation is allowed. It is pure: no clock, no
// database, no network. Callers pass the current order state and get back
// either the next state plus the event to persist, or a rejection code.
//
// Quantities follow the PRD's model: `requested` is the coordinator's current
// target, `picked` is the net worker-confirmed count in the tote. Neither is
// ever clamped to the other; when picked exceeds requested the difference is a
// mandatory return, which always comes before any further pick.

export type Line = {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly bin: string | null;
  readonly routeRank: number;
  readonly creationIndex: number;
  readonly requested: number;
  readonly picked: number;
};

export type Assignment = {
  readonly workerId: string;
  readonly toteId: string | null;
  readonly isAccepted: boolean;
  readonly ackRevision: number;
};

export type ExceptionStatus = "OPEN" | "RESOLVED_AWAITING_ACK";

export type Order = {
  readonly id: string;
  readonly ref: string;
  readonly revision: number;
  readonly version: number;
  readonly terminal: "COMPLETED" | "CANCELLED" | null;
  readonly isPaused: boolean;
  readonly isCancelRequested: boolean;
  readonly isReleaseRequested: boolean;
  readonly exception: { readonly id: string; readonly status: ExceptionStatus } | null;
  readonly assignment: Assignment | null;
  readonly lines: readonly Line[];
};

export type TaskKind = "PICK" | "RETURN";

export type Task = {
  readonly kind: TaskKind;
  readonly orderId: string;
  readonly lineId: string;
  readonly quantity: number;
  readonly revision: number;
  readonly version: number;
};

export type Plan =
  | { readonly kind: "TASK"; readonly task: Task }
  | { readonly kind: "TERMINAL"; readonly terminal: "COMPLETED" | "CANCELLED" }
  | { readonly kind: "OFFER" }
  | { readonly kind: "CONFLICT" }
  | { readonly kind: "PAUSED" }
  | { readonly kind: "REVISION_ACK"; readonly fromRevision: number; readonly toRevision: number }
  | { readonly kind: "RESOLUTION_ACK"; readonly exceptionId: string }
  | { readonly kind: "BLOCKED"; readonly exceptionId: string }
  | { readonly kind: "REVIEW_COMPLETE" }
  | { readonly kind: "REVIEW_CANCEL" }
  | { readonly kind: "REVIEW_RELEASE" };

/** outstandingPick is how many more units the line needs in the tote. */
export function outstandingPick(line: Line): number {
  return Math.max(0, line.requested - line.picked);
}

/** outstandingReturn is how many confirmed units exceed the current target. */
export function outstandingReturn(line: Line): number {
  return Math.max(0, line.picked - line.requested);
}

/**
 * plan derives the single next thing the picker must do. The order of checks
 * is the PRD's screen priority: ownership, pause, unacknowledged revision,
 * exceptions, returns, picks, then review. Derivation never mutates.
 */
export function plan(order: Order, workerId: string): Plan {
  if (order.terminal) return { kind: "TERMINAL", terminal: order.terminal };
  const assignment = order.assignment;
  if (!assignment || !assignment.isAccepted) return { kind: "OFFER" };
  if (assignment.workerId !== workerId) return { kind: "CONFLICT" };
  if (order.isPaused) return { kind: "PAUSED" };
  if (assignment.ackRevision !== order.revision) {
    return { kind: "REVISION_ACK", fromRevision: assignment.ackRevision, toRevision: order.revision };
  }
  if (order.exception?.status === "RESOLVED_AWAITING_ACK") {
    return { kind: "RESOLUTION_ACK", exceptionId: order.exception.id };
  }
  if (order.exception?.status === "OPEN") return { kind: "BLOCKED", exceptionId: order.exception.id };

  // Cancellation and release return everything in the tote, not just excess.
  const returnsAll = order.isCancelRequested || order.isReleaseRequested;
  const returnLine = routeOrder(order.lines).find((line) =>
    returnsAll ? line.picked > 0 : outstandingReturn(line) > 0,
  );
  if (returnLine) {
    const quantity = returnsAll ? returnLine.picked : outstandingReturn(returnLine);
    return { kind: "TASK", task: task(order, "RETURN", returnLine, quantity) };
  }
  if (order.isCancelRequested) return { kind: "REVIEW_CANCEL" };
  if (order.isReleaseRequested) return { kind: "REVIEW_RELEASE" };

  const pickLine = routeOrder(order.lines).find((line) => outstandingPick(line) > 0);
  if (pickLine) return { kind: "TASK", task: task(order, "PICK", pickLine, outstandingPick(pickLine)) };
  return { kind: "REVIEW_COMPLETE" };
}

function task(order: Order, kind: TaskKind, line: Line, quantity: number): Task {
  return { kind, orderId: order.id, lineId: line.id, quantity, revision: order.revision, version: order.version };
}

// Walking order: route rank, then bin label, then the order lines were
// written in, with the line ID as the final tie-break so the result never
// depends on input order. Strings compare by code unit rather than
// localeCompare so the order is the same on every machine.
function routeOrder(lines: readonly Line[]): Line[] {
  return [...lines].sort(
    (a, b) =>
      a.routeRank - b.routeRank ||
      compareText(a.bin ?? "", b.bin ?? "") ||
      a.creationIndex - b.creationIndex ||
      compareText(a.id, b.id),
  );
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
