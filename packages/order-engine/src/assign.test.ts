import { describe, expect, test } from "vitest";
import { assign, claim, plan, type Line, type Order, type Outcome } from "./engine.ts";

const lines: Line[] = [{ id: "a", sku: "A", name: "a", bin: "A-01", routeRank: 0, creationIndex: 0, requested: 2, picked: 0 }];

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: "o", ref: "ST-1", revision: 1, version: 1, terminal: null, isPaused: false, isCancelRequested: false,
    isReleaseRequested: false, exception: null, assignment: null, lines, ...overrides,
  };
}

function ok(outcome: Outcome): Order {
  if (!outcome.ok) throw new Error(`expected ok, got ${outcome.code}`);
  return outcome.order;
}

const at = (o: Order) => ({ revision: o.revision, version: o.version });

describe("assign", () => {
  test("offers the order to the assignee only, who starts it by claiming", () => {
    const assigned = ok(assign(order(), "picker-1", at(order())));
    expect(plan(assigned, "picker-1")).toEqual({ kind: "OFFER" });
    expect(plan(assigned, "picker-2")).toEqual({ kind: "CONFLICT" });
    expect(claim(assigned, "picker-2", "A", at(assigned))).toEqual({ ok: false, code: "ASSIGNMENT_CONFLICT" });
    const started = ok(claim(assigned, "picker-1", "A", at(assigned)));
    expect(started.assignment).toEqual({ workerId: "picker-1", toteId: "A", isAccepted: true, ackRevision: 1 });
  });

  test("can move an order nobody has started to another picker", () => {
    const assigned = ok(assign(order(), "picker-1", at(order())));
    const moved = ok(assign(assigned, "picker-2", at(assigned)));
    expect(plan(moved, "picker-2")).toEqual({ kind: "OFFER" });
    expect(plan(moved, "picker-1")).toEqual({ kind: "CONFLICT" });
  });

  test.each([
    { name: "an order being picked", overrides: { assignment: { workerId: "picker-1", toteId: "A", isAccepted: true, ackRevision: 1 } }, worker: "picker-2", code: "ASSIGNMENT_CONFLICT" },
    { name: "the same picker again", overrides: { assignment: { workerId: "picker-1", toteId: null, isAccepted: false, ackRevision: 1 } }, worker: "picker-1", code: "NO_CHANGE" },
    { name: "a cancelled order", overrides: { isCancelRequested: true }, worker: "picker-1", code: "INVALID_TRANSITION" },
  ])("refuses $name", ({ overrides, worker, code }) => {
    expect(assign(order(overrides), worker, { revision: 1, version: 1 })).toEqual({ ok: false, code });
  });
});
