import { describe, expect, test } from "vitest";
import { cancelRelease, claim, confirm, plan, prepareRelease, release, type Line, type Order, type Outcome } from "./engine.ts";

const worker = "worker-1";

function line(id: string, requested: number, picked: number): Line {
  return { id, sku: id.toUpperCase(), name: id, bin: "A-01", routeRank: 0, creationIndex: 0, requested, picked };
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

function ok(outcome: Outcome): Order {
  if (!outcome.ok) throw new Error(`expected ok, got ${outcome.code}`);
  return outcome.order;
}

const at = (o: Order) => ({ revision: o.revision, version: o.version });

describe("release", () => {
  test("is refused while units are in the tote, then allowed once all are returned", () => {
    const releasing = ok(prepareRelease(order([line("a", 3, 2)]), worker, at(order([]))));
    expect(release(releasing, worker, at(releasing))).toEqual({ ok: false, code: "INVALID_TRANSITION" });
    expect(plan(releasing, worker)).toMatchObject({ kind: "TASK", task: { kind: "RETURN", lineId: "a", quantity: 2 } });

    const returned = ok(confirm(releasing, worker, { ...at(releasing), kind: "RETURN", lineId: "a", quantity: 2 }));
    expect(plan(returned, worker)).toEqual({ kind: "REVIEW_RELEASE" });
    const released = ok(release(returned, worker, at(returned)));
    expect(released).toMatchObject({ assignment: null, isReleaseRequested: false, lines: [{ requested: 3, picked: 0 }] });
  });

  test("puts the order back in the queue for another picker", () => {
    const empty = ok(prepareRelease(order([line("a", 3, 0)]), worker, { revision: 1, version: 5 }));
    const released = ok(release(empty, worker, at(empty)));
    expect(plan(released, "worker-2")).toEqual({ kind: "OFFER" });
    expect(claim(released, "worker-2", "B", at(released)).ok).toBe(true);
  });

  test("can be called off, and the returned units are picked again", () => {
    const releasing = ok(prepareRelease(order([line("a", 3, 2)]), worker, { revision: 1, version: 5 }));
    const returned = ok(confirm(releasing, worker, { ...at(releasing), kind: "RETURN", lineId: "a", quantity: 2 }));
    const kept = ok(cancelRelease(returned, worker, at(returned)));
    expect(plan(kept, worker)).toMatchObject({ kind: "TASK", task: { kind: "PICK", quantity: 3 } });
  });

  test.each([
    { name: "another picker", overrides: { assignment: { workerId: "worker-2", toteId: "A", isAccepted: true, ackRevision: 1 } }, code: "ASSIGNMENT_CONFLICT" },
    { name: "an open problem", overrides: { exception: { id: "e", status: "OPEN" as const, type: "SHORTAGE" as const, lineId: "a", reportedQty: 0 } }, code: "OPEN_EXCEPTION" },
    { name: "a cancellation in progress", overrides: { isCancelRequested: true }, code: "INVALID_TRANSITION" },
    { name: "a paused order", overrides: { isPaused: true }, code: "INVALID_TRANSITION" },
    { name: "a release already pending", overrides: { isReleaseRequested: true }, code: "INVALID_TRANSITION" },
  ])("cannot start with $name", ({ overrides, code }) => {
    expect(prepareRelease(order([line("a", 3, 1)], overrides), worker, { revision: 1, version: 5 })).toEqual({ ok: false, code });
  });
});
