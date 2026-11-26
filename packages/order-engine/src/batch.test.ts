import { describe, expect, test } from "vitest";
import { planBatch, type Line, type Order } from "./engine.ts";

const worker = "worker-1";

function line(id: string, requested: number, picked: number, overrides: Partial<Line> = {}): Line {
  return { id, sku: id.toUpperCase(), name: id, bin: "A-01", routeRank: 0, creationIndex: 0, requested, picked, ...overrides };
}

function order(id: string, tote: string, lines: Line[], overrides: Partial<Order> = {}): Order {
  return {
    id,
    ref: id.toUpperCase(),
    revision: 1,
    version: 3,
    terminal: null,
    isPaused: false,
    isCancelRequested: false,
    isReleaseRequested: false,
    exception: null,
    assignment: { workerId: worker, toteId: tote, isAccepted: true, ackRevision: 1 },
    lines,
    ...overrides,
  };
}

const step = (orders: Order[]) => {
  const next = planBatch(orders, worker);
  return next && { orderId: next.orderId, kind: next.plan.kind, ...(next.plan.kind === "TASK" ? { lineId: next.plan.task.lineId, task: next.plan.task.kind } : {}) };
};

describe("planBatch", () => {
  test("picks in walking order across orders", () => {
    const orders = [order("o1", "A", [line("far", 1, 0, { routeRank: 9 })]), order("o2", "B", [line("near", 1, 0, { routeRank: 1 })])];
    expect(step(orders)).toEqual({ orderId: "o2", kind: "TASK", lineId: "near", task: "PICK" });
  });

  test("breaks a route tie by bin, then by order ref", () => {
    const orders = [
      order("o2", "B", [line("x", 1, 0, { bin: "A-02" })]),
      order("o1", "A", [line("y", 1, 0, { bin: "A-02" })]),
      order("o3", "C", [line("z", 1, 0, { bin: "B-01" })]),
    ];
    expect(step(orders)).toEqual({ orderId: "o1", kind: "TASK", lineId: "y", task: "PICK" });
  });

  test("a return on any order comes before every pick", () => {
    const orders = [order("o1", "A", [line("near", 1, 0, { routeRank: 0 })]), order("o2", "B", [line("far", 0, 2, { routeRank: 9 })])];
    expect(step(orders)).toEqual({ orderId: "o2", kind: "TASK", lineId: "far", task: "RETURN" });
  });

  test("an unseen revision is shown before any work", () => {
    const revised = order("o2", "B", [line("b", 1, 0, { routeRank: 9 })], { revision: 2 });
    expect(step([order("o1", "A", [line("a", 1, 0)]), revised])).toEqual({ orderId: "o2", kind: "REVISION_ACK" });
  });

  test("a finished order is reviewed before more picking", () => {
    const orders = [order("o1", "A", [line("a", 1, 0)]), order("o2", "B", [line("b", 1, 1)])];
    expect(step(orders)).toEqual({ orderId: "o2", kind: "REVIEW_COMPLETE" });
  });

  test("a blocked order waits while the others continue", () => {
    const exception = { id: "e1", status: "OPEN", type: "SHORTAGE", lineId: "a", reportedQty: 0 } as const;
    const orders = [order("o1", "A", [line("a", 2, 0)], { exception }), order("o2", "B", [line("b", 1, 0, { routeRank: 5 })])];
    expect(step(orders)).toEqual({ orderId: "o2", kind: "TASK", lineId: "b", task: "PICK" });
  });

  test("when nothing can move, the first open order says why", () => {
    const orders = [order("o1", "A", [line("a", 1, 1)], { terminal: "COMPLETED" }), order("o2", "B", [line("b", 1, 0)], { isPaused: true })];
    expect(step(orders)).toEqual({ orderId: "o2", kind: "PAUSED" });
  });

  test("returns null once every order is closed", () => {
    expect(planBatch([order("o1", "A", [line("a", 1, 1)], { terminal: "COMPLETED" })], worker)).toBeNull();
  });
});
