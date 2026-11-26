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

export type ExceptionType = "SHORTAGE" | "DAMAGED" | "LOCATION_MISMATCH" | "RETURN_BLOCKED" | "OTHER";

/** OrderException is the one unresolved problem an order may have. */
export type OrderException = {
  readonly id: string;
  readonly status: ExceptionStatus;
  readonly type: ExceptionType;
  readonly lineId: string | null;
  readonly reportedQty: number | null;
};

export type Order = {
  readonly id: string;
  readonly ref: string;
  readonly revision: number;
  readonly version: number;
  readonly terminal: "COMPLETED" | "CANCELLED" | null;
  readonly isPaused: boolean;
  readonly isCancelRequested: boolean;
  readonly isReleaseRequested: boolean;
  readonly exception: OrderException | null;
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
 * is the PRD's screen priority: ownership, pause, a resolution or revision to
 * acknowledge, an open exception, returns, picks, then review. Derivation never mutates.
 */
export function plan(order: Order, workerId: string): Plan {
  if (order.terminal) return { kind: "TERMINAL", terminal: order.terminal };
  const assignment = order.assignment;
  if (!assignment || !assignment.isAccepted) return { kind: "OFFER" };
  if (assignment.workerId !== workerId) return { kind: "CONFLICT" };
  if (order.isPaused) return { kind: "PAUSED" };
  // A resolution is acknowledged as a whole, including any revision it made,
  // so it is shown before a plain revision notice.
  if (order.exception?.status === "RESOLVED_AWAITING_ACK") {
    return { kind: "RESOLUTION_ACK", exceptionId: order.exception.id };
  }
  if (assignment.ackRevision !== order.revision) {
    return { kind: "REVISION_ACK", fromRevision: assignment.ackRevision, toRevision: order.revision };
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
  | "INVALID_TRANSITION"
  | "NO_CHANGE"
  | "DUPLICATE_SKU"
  | "ORDER_TOO_LARGE"
  | "OPEN_EXCEPTION";

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

/** Limits from the PRD: per-line and per-order unit caps. */
export const limits = { unitsPerLine: 10_000, unitsPerOrder: 20_000, lines: 100 } as const;

/**
 * Change is one coordinator edit. Quantities are absolute targets, never
 * increments, so a repeated message cannot double a line. A line's SKU is
 * never rewritten; a different SKU is a new line.
 */
export type Change =
  | { readonly kind: "SET_QUANTITY"; readonly lineId: string; readonly quantity: number }
  | { readonly kind: "ADD_LINE"; readonly line: Omit<Line, "requested" | "picked" | "creationIndex">; readonly quantity: number };

/**
 * revise applies coordinator changes as one new revision. Picked counts are
 * untouched: if a target drops below what is already in the tote, the plan
 * turns the difference into a return. The worker must acknowledge before any
 * further confirmation, because the acknowledged revision no longer matches.
 */
export function revise(order: Order, changes: readonly Change[], expected: Expected): Outcome {
  const stale = checkFresh(order, expected);
  if (stale) return stale;
  if (order.exception?.status === "OPEN") return { ok: false, code: "OPEN_EXCEPTION" };
  const next = applyChanges(order, changes);
  if (!next.ok) return next;
  if (sameTargets(order.lines, next.lines)) return { ok: false, code: "NO_CHANGE" };
  return { ok: true, order: { ...order, lines: next.lines, revision: order.revision + 1, version: order.version + 1 } };
}

function applyChanges(order: Order, changes: readonly Change[]): { ok: true; lines: Line[] } | { ok: false; code: Rejection } {
  const lines = [...order.lines];
  for (const change of changes) {
    if (!Number.isInteger(change.quantity) || change.quantity < 0 || change.quantity > limits.unitsPerLine) {
      return { ok: false, code: "QUANTITY_OUT_OF_RANGE" };
    }
    if (change.kind === "SET_QUANTITY") {
      const index = lines.findIndex((line) => line.id === change.lineId);
      if (index < 0) return { ok: false, code: "INVALID_TRANSITION" };
      lines[index] = { ...lines[index]!, requested: change.quantity };
    } else {
      if (lines.some((line) => line.sku === change.line.sku || line.id === change.line.id)) return { ok: false, code: "DUPLICATE_SKU" };
      if (change.quantity === 0) return { ok: false, code: "QUANTITY_OUT_OF_RANGE" };
      const creationIndex = Math.max(-1, ...lines.map((line) => line.creationIndex)) + 1;
      lines.push({ ...change.line, requested: change.quantity, picked: 0, creationIndex });
    }
  }
  if (lines.length > limits.lines) return { ok: false, code: "ORDER_TOO_LARGE" };
  if (lines.reduce((sum, line) => sum + line.requested, 0) > limits.unitsPerOrder) return { ok: false, code: "ORDER_TOO_LARGE" };
  return { ok: true, lines };
}

function sameTargets(before: readonly Line[], after: readonly Line[]): boolean {
  return before.length === after.length && after.every((line) => before.find((old) => old.id === line.id)?.requested === line.requested);
}

/** acknowledge records that the worker has seen the current revision. */
export function acknowledge(order: Order, workerId: string, expected: Expected): Outcome {
  const stale = checkFresh(order, expected);
  if (stale) return stale;
  if (plan(order, workerId).kind !== "REVISION_ACK") return { ok: false, code: "INVALID_TRANSITION" };
  const assignment = { ...order.assignment!, ackRevision: order.revision };
  return { ok: true, order: { ...order, assignment, version: order.version + 1 } };
}

/**
 * requestCancel sets every target to zero as a new revision. With nothing in
 * a tote and nobody assigned, the order closes at once; otherwise the picker
 * returns everything and closes it, so goods are never left unaccounted for.
 */
export function requestCancel(order: Order, expected: Expected): Outcome {
  const stale = checkFresh(order, expected);
  if (stale) return stale;
  const lines = order.lines.map((line) => ({ ...line, requested: 0 }));
  const isEmpty = lines.every((line) => line.picked === 0);
  const terminal = isEmpty && !order.assignment ? ("CANCELLED" as const) : null;
  return {
    ok: true,
    order: { ...order, lines, isCancelRequested: true, terminal, revision: order.revision + 1, version: order.version + 1 },
  };
}

/** closeCancelled finishes a cancellation once every picked unit is back. */
export function closeCancelled(order: Order, workerId: string, expected: Expected): Outcome {
  const stale = checkFresh(order, expected);
  if (stale) return stale;
  if (plan(order, workerId).kind !== "REVIEW_CANCEL") return { ok: false, code: "INVALID_TRANSITION" };
  return { ok: true, order: { ...order, terminal: "CANCELLED", version: order.version + 1 } };
}

/** Report is a picker saying the current task cannot be done as shown. */
export type Report = { readonly exceptionId: string; readonly type: ExceptionType; readonly reportedQty: number | null };

/**
 * report blocks the order on the current task's line. Only one exception can
 * be open per order, and nothing else can be confirmed until a coordinator
 * resolves it and the picker acknowledges the resolution.
 */
export function report(order: Order, workerId: string, problem: Report, expected: Expected): Outcome {
  const stale = checkFresh(order, expected);
  if (stale) return stale;
  if (order.exception) return { ok: false, code: "OPEN_EXCEPTION" };
  const next = plan(order, workerId);
  if (next.kind !== "TASK") return { ok: false, code: "INVALID_TRANSITION" };
  if (problem.reportedQty !== null && (!Number.isInteger(problem.reportedQty) || problem.reportedQty < 0 || problem.reportedQty > limits.unitsPerLine)) {
    return { ok: false, code: "QUANTITY_OUT_OF_RANGE" };
  }
  const exception = { id: problem.exceptionId, status: "OPEN" as const, type: problem.type, lineId: next.task.lineId, reportedQty: problem.reportedQty };
  return { ok: true, order: { ...order, exception, version: order.version + 1 } };
}

/**
 * Resolution is the coordinator's decision. Software never picks one: a
 * shortage is not silently reduced and a substitute is never proposed here.
 */
export type Resolution =
  | { readonly kind: "RESUME" }
  | { readonly kind: "REDUCE"; readonly quantity: number }
  | { readonly kind: "SUBSTITUTE"; readonly quantity: number; readonly substitute: Omit<Line, "requested" | "picked" | "creationIndex">; readonly substituteQuantity: number }
  | { readonly kind: "CANCEL" };

/** resolve answers the open exception, revising the order when the decision changes targets. */
export function resolve(order: Order, resolution: Resolution, expected: Expected): Outcome {
  const stale = checkFresh(order, expected);
  if (stale) return stale;
  const exception = order.exception;
  if (exception?.status !== "OPEN") return { ok: false, code: "INVALID_TRANSITION" };
  const resolved = { ...order, exception: { ...exception, status: "RESOLVED_AWAITING_ACK" as const }, version: order.version + 1 };
  if (resolution.kind === "RESUME") return { ok: true, order: resolved };
  if (resolution.kind === "CANCEL") {
    const lines = order.lines.map((line) => ({ ...line, requested: 0 }));
    return { ok: true, order: { ...resolved, lines, isCancelRequested: true, revision: order.revision + 1 } };
  }
  if (!exception.lineId) return { ok: false, code: "INVALID_TRANSITION" };
  const line = order.lines.find((candidate) => candidate.id === exception.lineId)!;
  // A reduction lowers the target; raising it is a revision, not an answer to a problem.
  if (resolution.quantity > line.requested) return { ok: false, code: "QUANTITY_OUT_OF_RANGE" };
  const changes: Change[] = [{ kind: "SET_QUANTITY", lineId: line.id, quantity: resolution.quantity }];
  if (resolution.kind === "SUBSTITUTE") changes.push({ kind: "ADD_LINE", line: resolution.substitute, quantity: resolution.substituteQuantity });
  const next = applyChanges(order, changes);
  if (!next.ok) return next;
  return { ok: true, order: { ...resolved, lines: next.lines, revision: order.revision + 1 } };
}

/**
 * acknowledgeResolution closes the exception and, in the same step, accepts
 * any revision the resolution made: the worker was shown both together.
 */
export function acknowledgeResolution(order: Order, workerId: string, exceptionId: string, expected: Expected): Outcome {
  const stale = checkFresh(order, expected);
  if (stale) return stale;
  const next = plan(order, workerId);
  if (next.kind !== "RESOLUTION_ACK" || next.exceptionId !== exceptionId) return { ok: false, code: "INVALID_TRANSITION" };
  const assignment = { ...order.assignment!, ackRevision: order.revision };
  return { ok: true, order: { ...order, exception: null, assignment, version: order.version + 1 } };
}

/** pause and resume keep the assignment and the tote; nothing is released. */
export function pause(order: Order, workerId: string, expected: Expected): Outcome {
  return setPaused(order, workerId, expected, true);
}

export function resume(order: Order, workerId: string, expected: Expected): Outcome {
  return setPaused(order, workerId, expected, false);
}

function setPaused(order: Order, workerId: string, expected: Expected, isPaused: boolean): Outcome {
  const stale = checkFresh(order, expected);
  if (stale) return stale;
  const assignment = order.assignment;
  if (!assignment?.isAccepted || assignment.workerId !== workerId) return { ok: false, code: "ASSIGNMENT_CONFLICT" };
  if (order.isPaused === isPaused) return { ok: false, code: "NO_CHANGE" };
  return { ok: true, order: { ...order, isPaused, version: order.version + 1 } };
}

/**
 * prepareRelease starts handing an order back to the queue. Everything in the
 * tote goes back to its bin first, because v1 never passes a part-filled tote
 * to another picker; the plan turns every picked unit into a return.
 */
export function prepareRelease(order: Order, workerId: string, expected: Expected): Outcome {
  const stale = checkFresh(order, expected);
  if (stale) return stale;
  if (order.assignment?.workerId !== workerId) return { ok: false, code: "ASSIGNMENT_CONFLICT" };
  if (order.exception) return { ok: false, code: "OPEN_EXCEPTION" };
  if (order.isPaused || order.isCancelRequested || order.isReleaseRequested) return { ok: false, code: "INVALID_TRANSITION" };
  return { ok: true, order: { ...order, isReleaseRequested: true, version: order.version + 1 } };
}

/** cancelRelease keeps the order after all; units already returned are picked again. */
export function cancelRelease(order: Order, workerId: string, expected: Expected): Outcome {
  const stale = checkFresh(order, expected);
  if (stale) return stale;
  if (order.assignment?.workerId !== workerId) return { ok: false, code: "ASSIGNMENT_CONFLICT" };
  if (!order.isReleaseRequested) return { ok: false, code: "INVALID_TRANSITION" };
  return { ok: true, order: { ...order, isReleaseRequested: false, version: order.version + 1 } };
}

/** release returns an order with an empty tote to the queue for anyone to claim. */
export function release(order: Order, workerId: string, expected: Expected): Outcome {
  const stale = checkFresh(order, expected);
  if (stale) return stale;
  if (plan(order, workerId).kind !== "REVIEW_RELEASE") return { ok: false, code: "INVALID_TRANSITION" };
  return { ok: true, order: { ...order, assignment: null, isReleaseRequested: false, version: order.version + 1 } };
}

/** batchLimits bounds how many orders one picker carries at once (PRD §7.6). */
export const batchLimits = { min: 2, max: 5 } as const;

/** BatchStep is the one thing a picker carrying several orders should do next. */
export type BatchStep = { readonly orderId: string; readonly plan: Plan };

/**
 * planBatch picks the next step across every order a picker is carrying,
 * each in its own tote. Each order keeps its own rules; this only decides
 * which order's next step comes first:
 *
 *   1. anything to acknowledge (a revision or a coordinator's decision),
 *      because the picker must not act on a plan they have not seen;
 *   2. a finished order's review, so completed totes leave the cart;
 *   3. returns, before any new pick, on any order;
 *   4. picks, in walking order across all orders.
 *
 * A blocked or paused order waits on its own while the others continue,
 * because its tote is kept apart. If nothing can move, the first open
 * order's plan is returned so the screen can say why; null means every
 * order in the batch is closed.
 */
export function planBatch(orders: readonly Order[], workerId: string): BatchStep | null {
  const steps = orders.map((order) => ({ order, plan: plan(order, workerId) }));
  const first = (match: (step: (typeof steps)[number]) => boolean) => steps.find(match);
  const acknowledge = first(({ plan }) => plan.kind === "REVISION_ACK" || plan.kind === "RESOLUTION_ACK");
  if (acknowledge) return { orderId: acknowledge.order.id, plan: acknowledge.plan };
  const review = first(({ plan }) => plan.kind === "REVIEW_COMPLETE" || plan.kind === "REVIEW_CANCEL" || plan.kind === "REVIEW_RELEASE");
  if (review) return { orderId: review.order.id, plan: review.plan };

  const tasks = steps.flatMap(({ order, plan }) => (plan.kind === "TASK" ? [{ order, task: plan.task, line: order.lines.find((l) => l.id === plan.task.lineId)! }] : []));
  const returning = tasks.filter(({ task }) => task.kind === "RETURN");
  const pool = returning.length > 0 ? returning : tasks;
  const next = [...pool].sort(
    (a, b) =>
      a.line.routeRank - b.line.routeRank ||
      compareText(a.line.bin ?? "", b.line.bin ?? "") ||
      compareText(a.order.ref, b.order.ref),
  )[0];
  if (next) return { orderId: next.order.id, plan: { kind: "TASK", task: next.task } };
  const waiting = first(({ plan }) => plan.kind !== "TERMINAL");
  return waiting ? { orderId: waiting.order.id, plan: waiting.plan } : null;
}
