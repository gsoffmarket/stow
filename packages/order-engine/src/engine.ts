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

/** Rejection is why a command was refused; the order is unchanged. */
export type Rejection =
  | "TERMINAL_ORDER"
  | "STALE_VERSION"
  | "REVISION_REQUIRED"
  | "ASSIGNMENT_CONFLICT"
  | "TASK_CHANGED"
  | "QUANTITY_OUT_OF_RANGE"
  | "INVALID_TRANSITION";

export type Outcome = { readonly ok: true; readonly order: Order } | { readonly ok: false; readonly code: Rejection };

/** Expected is the state a client last saw; any committed change since makes its command stale. */
export type Expected = { readonly revision: number; readonly version: number };

/** Confirmation is a picker saying they physically moved `quantity` units for one task. */
export type Confirmation = Expected & { readonly kind: TaskKind; readonly lineId: string; readonly quantity: number };

/**
 * claim gives a queued order to the worker. Claiming is explicit acceptance of
 * the current revision, so the worker starts with nothing to acknowledge.
 */
export function claim(order: Order, workerId: string, toteId: string | null, expected: Expected): Outcome {
  const stale = checkFresh(order, expected);
  if (stale) return stale;
  if (order.assignment) return { ok: false, code: "ASSIGNMENT_CONFLICT" };
  const assignment = { workerId, toteId, isAccepted: true, ackRevision: order.revision };
  return { ok: true, order: { ...order, assignment, version: order.version + 1 } };
}

/**
 * confirm applies a pick or return, but only for the exact task the planner
 * would show now. A tap on a screen rendered before a revision fails here
 * instead of counting against the new plan.
 */
export function confirm(order: Order, workerId: string, confirmation: Confirmation): Outcome {
  const stale = checkFresh(order, confirmation);
  if (stale) return stale;
  const next = plan(order, workerId);
  if (next.kind === "CONFLICT" || next.kind === "OFFER") return { ok: false, code: "ASSIGNMENT_CONFLICT" };
  if (next.kind !== "TASK" || next.task.kind !== confirmation.kind || next.task.lineId !== confirmation.lineId) {
    return { ok: false, code: "TASK_CHANGED" };
  }
  const quantity = confirmation.quantity;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > next.task.quantity) {
    return { ok: false, code: "QUANTITY_OUT_OF_RANGE" };
  }
  const delta = confirmation.kind === "PICK" ? quantity : -quantity;
  const lines = order.lines.map((line) =>
    line.id === confirmation.lineId ? { ...line, picked: line.picked + delta } : line,
  );
  return { ok: true, order: assertInvariants({ ...order, lines, version: order.version + 1 }) };
}

/** complete closes a fully picked order; it is the picker's explicit final action. */
export function complete(order: Order, workerId: string, expected: Expected): Outcome {
  const stale = checkFresh(order, expected);
  if (stale) return stale;
  if (plan(order, workerId).kind !== "REVIEW_COMPLETE") return { ok: false, code: "INVALID_TRANSITION" };
  return { ok: true, order: { ...order, terminal: "COMPLETED", version: order.version + 1 } };
}

function checkFresh(order: Order, expected: Expected): Outcome | null {
  if (order.terminal) return { ok: false, code: "TERMINAL_ORDER" };
  if (expected.revision !== order.revision) return { ok: false, code: "REVISION_REQUIRED" };
  if (expected.version !== order.version) return { ok: false, code: "STALE_VERSION" };
  return null;
}

// A violated invariant here is a bug in this module, not bad input, so it
// throws rather than returning a rejection.
function assertInvariants(order: Order): Order {
  for (const line of order.lines) {
    if (!Number.isInteger(line.picked) || line.picked < 0) {
      throw new Error(`order ${order.id} line ${line.id}: picked is ${line.picked}, must be a non-negative integer`);
    }
  }
  return order;
}
