import { describe, expect, test } from "vitest";
import { acknowledge, closeCancelled, confirm, plan, requestCancel, revise, type Line, type Order } from "./engine.ts";

const worker = "worker-1";

function line(id: string, requested: number, picked: number, creationIndex = 0): Line {
  return { id, sku: id.toUpperCase(), name: id, bin: "A-01", routeRank: 0, creationIndex, requested, picked };
}

function order(lines: Line[], overrides: Partial<Order> = {}): Order {
  return {
    id: "o",
    ref: "ST-1",
    revision: 1,
    version: 5,
    terminal: null,
    isPaused: false,
    isCancelRequested: false,
    isReleaseRequested: false,
    exception: null,
    assignment: { workerId: worker, toteId: "A", isAccepted: true, ackRevision: 1 },
    lines,
    ...overrides,
  };
}

const fresh = { revision: 1, version: 5 };

function ok(outcome: ReturnType<typeof revise>): Order {
  if (!outcome.ok) throw new Error(`expected ok, got ${outcome.code}`);
  return outcome.order;
}

describe("revise then acknowledge", () => {
  // PRD §7.4: picked stays as recorded; the acknowledged plan decides the work.
  test.each([
    { before: [4, 2], target: 6, want: { kind: "PICK", quantity: 4 } },
    { before: [4, 2], target: 3, want: { kind: "PICK", quantity: 1 } },
    { before: [4, 2], target: 1, want: { kind: "RETURN", quantity: 1 } },
    { before: [4, 2], target: 0, want: { kind: "RETURN", quantity: 2 } },
  ])("$before.0/$before.1 revised to $target needs $want.kind × $want.quantity", ({ before, target, want }) => {
    const revised = ok(revise(order([line("a", before[0]!, before[1]!)]), [{ kind: "SET_QUANTITY", lineId: "a", quantity: target }], fresh));
    expect(revised).toMatchObject({ revision: 2, version: 6, lines: [{ requested: target, picked: before[1] }] });
    expect(plan(revised, worker)).toEqual({ kind: "REVISION_ACK", fromRevision: 1, toRevision: 2 });

    const acked = ok(acknowledge(revised, worker, { revision: 2, version: 6 }));
    expect(plan(acked, worker)).toMatchObject({ kind: "TASK", task: { ...want, lineId: "a", revision: 2, version: 7 } });
  });

  test("a confirmation made against the old revision is refused", () => {
    const revised = ok(revise(order([line("a", 4, 2)]), [{ kind: "SET_QUANTITY", lineId: "a", quantity: 1 }], fresh));
    expect(confirm(revised, worker, { ...fresh, kind: "PICK", lineId: "a", quantity: 2 })).toEqual({ ok: false, code: "REVISION_REQUIRED" });
  });

  test("several revisions before acknowledgement collapse to the latest plan", () => {
    const first = ok(revise(order([line("a", 4, 2)]), [{ kind: "SET_QUANTITY", lineId: "a", quantity: 3 }], fresh));
    const second = ok(revise(first, [{ kind: "SET_QUANTITY", lineId: "a", quantity: 1 }], { revision: 2, version: 6 }));
    expect(plan(second, worker)).toEqual({ kind: "REVISION_ACK", fromRevision: 1, toRevision: 3 });
    const acked = ok(acknowledge(second, worker, { revision: 3, version: 7 }));
    expect(plan(acked, worker)).toMatchObject({ task: { kind: "RETURN", quantity: 1 } });
  });

  test("adding a line appends it after the existing ones", () => {
    const added = ok(
      revise(order([line("a", 1, 0)]), [{ kind: "ADD_LINE", line: { id: "b", sku: "B", name: "b", bin: "B-01", routeRank: 0 }, quantity: 2 }], fresh),
    );
    expect(added.lines.at(-1)).toEqual({ id: "b", sku: "B", name: "b", bin: "B-01", routeRank: 0, creationIndex: 1, requested: 2, picked: 0 });
  });

  test.each([
    { name: "an identical target", changes: [{ kind: "SET_QUANTITY" as const, lineId: "a", quantity: 4 }], code: "NO_CHANGE" },
    { name: "a negative target", changes: [{ kind: "SET_QUANTITY" as const, lineId: "a", quantity: -1 }], code: "QUANTITY_OUT_OF_RANGE" },
    { name: "an unknown line", changes: [{ kind: "SET_QUANTITY" as const, lineId: "z", quantity: 1 }], code: "INVALID_TRANSITION" },
    {
      name: "a SKU already in the order",
      changes: [{ kind: "ADD_LINE" as const, line: { id: "b", sku: "A", name: "a", bin: null, routeRank: 0 }, quantity: 1 }],
      code: "DUPLICATE_SKU",
    },
    { name: "more than 10,000 on a line", changes: [{ kind: "SET_QUANTITY" as const, lineId: "a", quantity: 10_001 }], code: "QUANTITY_OUT_OF_RANGE" },
    {
      name: "more than 20,000 units in the order",
      changes: [
        { kind: "SET_QUANTITY" as const, lineId: "a", quantity: 10_000 },
        { kind: "SET_QUANTITY" as const, lineId: "b", quantity: 10_000 },
        { kind: "ADD_LINE" as const, line: { id: "c", sku: "C", name: "c", bin: null, routeRank: 0 }, quantity: 1 },
      ],
      code: "ORDER_TOO_LARGE",
    },
  ])("rejects $name", ({ changes, code }) => {
    expect(revise(order([line("a", 4, 2), line("b", 1, 0, 1)]), changes, fresh)).toEqual({ ok: false, code });
  });

  test("refuses a stale coordinator preview and an order with an open exception", () => {
    const change = [{ kind: "SET_QUANTITY" as const, lineId: "a", quantity: 1 }];
    expect(revise(order([line("a", 4, 2)]), change, { revision: 1, version: 4 })).toEqual({ ok: false, code: "STALE_VERSION" });
    const blocked = order([line("a", 4, 2)], { exception: { id: "x", status: "OPEN" } });
    expect(revise(blocked, change, fresh)).toEqual({ ok: false, code: "OPEN_EXCEPTION" });
  });
});

describe("cancellation", () => {
  test("an unassigned order with nothing picked closes at once", () => {
    const cancelled = ok(requestCancel(order([line("a", 3, 0)], { assignment: null }), fresh));
    expect(cancelled).toMatchObject({ terminal: "CANCELLED", isCancelRequested: true, lines: [{ requested: 0 }] });
  });

  test("a picked order needs acknowledgement, every unit returned, then an explicit close", () => {
    const cancelled = ok(requestCancel(order([line("a", 3, 2)]), fresh));
    expect(cancelled.terminal).toBeNull();
    const acked = ok(acknowledge(cancelled, worker, { revision: 2, version: 6 }));
    expect(plan(acked, worker)).toMatchObject({ task: { kind: "RETURN", quantity: 2 } });
    expect(closeCancelled(acked, worker, { revision: 2, version: 7 })).toEqual({ ok: false, code: "INVALID_TRANSITION" });

    const returned = ok(confirm(acked, worker, { revision: 2, version: 7, kind: "RETURN", lineId: "a", quantity: 2 }));
    expect(plan(returned, worker)).toEqual({ kind: "REVIEW_CANCEL" });
    expect(ok(closeCancelled(returned, worker, { revision: 2, version: 8 })).terminal).toBe("CANCELLED");
  });

  test("a completed order cannot be cancelled", () => {
    expect(requestCancel(order([line("a", 1, 1)], { terminal: "COMPLETED" }), fresh)).toEqual({ ok: false, code: "TERMINAL_ORDER" });
  });
});
