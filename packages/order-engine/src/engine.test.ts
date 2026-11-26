import { describe, expect, test } from "vitest";
import { plan, type Line, type Order } from "./engine.ts";

const worker = "worker-1";

function line(id: string, requested: number, picked: number, overrides: Partial<Line> = {}): Line {
  return { id, sku: id.toUpperCase(), name: id, bin: "A-01", routeRank: 0, creationIndex: 0, requested, picked, ...overrides };
}

function order(lines: Line[], overrides: Partial<Order> = {}): Order {
  return {
    id: "order-1",
    ref: "ST-1",
    revision: 2,
    version: 7,
    terminal: null,
    isPaused: false,
    isCancelRequested: false,
    isReleaseRequested: false,
    exception: null,
    assignment: { workerId: worker, toteId: "A", isAccepted: true, ackRevision: 2 },
    lines,
    ...overrides,
  };
}

describe("plan after an acknowledged revision", () => {
  // The PRD's §7.4 revision table: requested/picked after the change, and the
  // work the picker must do next.
  test.each([
    { name: "increase picks the difference", lines: [line("a", 6, 2)], want: { kind: "PICK", lineId: "a", quantity: 4 } },
    { name: "decrease above picked picks the rest", lines: [line("a", 3, 2)], want: { kind: "PICK", lineId: "a", quantity: 1 } },
    { name: "decrease below picked returns the excess", lines: [line("a", 1, 2)], want: { kind: "RETURN", lineId: "a", quantity: 1 } },
    { name: "zero target returns everything picked", lines: [line("a", 0, 2)], want: { kind: "RETURN", lineId: "a", quantity: 2 } },
    {
      name: "a return comes before a pick on another line",
      lines: [line("b", 2, 0, { routeRank: 0 }), line("a", 1, 3, { routeRank: 5 })],
      want: { kind: "RETURN", lineId: "a", quantity: 2 },
    },
  ])("$name", ({ lines, want }) => {
    const got = plan(order(lines), worker);
    expect(got).toEqual({ kind: "TASK", task: { ...want, orderId: "order-1", revision: 2, version: 7 } });
  });

  test("zero target with nothing picked goes straight to review", () => {
    expect(plan(order([line("a", 0, 0)]), worker)).toEqual({ kind: "REVIEW_COMPLETE" });
  });
});

describe("plan gates", () => {
  test.each([
    { name: "terminal order", overrides: { terminal: "COMPLETED" as const }, want: { kind: "TERMINAL", terminal: "COMPLETED" } },
    { name: "no assignment", overrides: { assignment: null }, want: { kind: "OFFER" } },
    {
      name: "assignment not accepted",
      overrides: { assignment: { workerId: worker, toteId: null, isAccepted: false, ackRevision: 2 } },
      want: { kind: "OFFER" },
    },
    {
      name: "another worker owns the order",
      overrides: { assignment: { workerId: "worker-2", toteId: "B", isAccepted: true, ackRevision: 2 } },
      want: { kind: "CONFLICT" },
    },
    { name: "paused", overrides: { isPaused: true }, want: { kind: "PAUSED" } },
    {
      name: "revision not acknowledged",
      overrides: { assignment: { workerId: worker, toteId: "A", isAccepted: true, ackRevision: 1 } },
      want: { kind: "REVISION_ACK", fromRevision: 1, toRevision: 2 },
    },
    { name: "open exception", overrides: { exception: { id: "x", status: "OPEN" as const } }, want: { kind: "BLOCKED", exceptionId: "x" } },
    {
      name: "resolved exception awaiting ack",
      overrides: { exception: { id: "x", status: "RESOLVED_AWAITING_ACK" as const } },
      want: { kind: "RESOLUTION_ACK", exceptionId: "x" },
    },
  ])("$name blocks picking", ({ overrides, want }) => {
    expect(plan(order([line("a", 3, 0)], overrides), worker)).toEqual(want);
  });
});

describe("plan for cancellation and release", () => {
  test("cancellation returns every picked unit, then asks to close", () => {
    const pending = order([line("a", 0, 2), line("b", 0, 0)], { isCancelRequested: true });
    expect(plan(pending, worker)).toMatchObject({ kind: "TASK", task: { kind: "RETURN", lineId: "a", quantity: 2 } });

    const cleared = order([line("a", 0, 0), line("b", 0, 0)], { isCancelRequested: true });
    expect(plan(cleared, worker)).toEqual({ kind: "REVIEW_CANCEL" });
  });

  test("release returns picked units even when the target still wants them", () => {
    const releasing = order([line("a", 3, 2)], { isReleaseRequested: true });
    expect(plan(releasing, worker)).toMatchObject({ kind: "TASK", task: { kind: "RETURN", quantity: 2 } });
    expect(plan(order([line("a", 3, 0)], { isReleaseRequested: true }), worker)).toEqual({ kind: "REVIEW_RELEASE" });
  });
});

describe("route order", () => {
  test("picks by route rank, then bin, then line order, regardless of input order", () => {
    const lines = [
      line("late", 1, 0, { routeRank: 2, bin: "A-01" }),
      line("second", 1, 0, { routeRank: 1, bin: "B-01" }),
      line("first", 1, 0, { routeRank: 1, bin: "A-09" }),
    ];
    const order1 = order(lines);
    const order2 = order([...lines].reverse());
    expect(plan(order1, worker)).toMatchObject({ task: { lineId: "first" } });
    expect(plan(order2, worker)).toMatchObject({ task: { lineId: "first" } });
  });
});
