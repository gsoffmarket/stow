import { describe, expect, test } from "vitest";
import { acknowledgeResolution, confirm, pause, plan, report, resolve, resume, type Line, type Order, type Outcome } from "./engine.ts";

const worker = "worker-1";

function line(id: string, requested: number, picked: number, creationIndex: number): Line {
  return { id, sku: id.toUpperCase(), name: id, bin: "A-01", routeRank: 0, creationIndex, requested, picked };
}

// White caps: 4 wanted, 2 found and picked. A tote of black shirts already done.
const start: Order = {
  id: "o",
  ref: "ST-1042",
  revision: 2,
  version: 10,
  terminal: null,
  isPaused: false,
  isCancelRequested: false,
  isReleaseRequested: false,
  exception: null,
  assignment: { workerId: worker, toteId: "A", isAccepted: true, ackRevision: 2 },
  lines: [line("shirt", 1, 1, 0), line("cap", 4, 2, 1)],
};

function ok(outcome: Outcome): Order {
  if (!outcome.ok) throw new Error(`expected ok, got ${outcome.code}`);
  return outcome.order;
}

const at = (order: Order) => ({ revision: order.revision, version: order.version });

function blocked(): Order {
  return ok(report(start, worker, { exceptionId: "x", type: "SHORTAGE", reportedQty: 2 }, at(start)));
}

describe("report", () => {
  test("blocks the order on the current task's line", () => {
    const order = blocked();
    expect(order.exception).toEqual({ id: "x", status: "OPEN", type: "SHORTAGE", lineId: "cap", reportedQty: 2 });
    expect(plan(order, worker)).toEqual({ kind: "BLOCKED", exceptionId: "x" });
    expect(confirm(order, worker, { ...at(order), kind: "PICK", lineId: "cap", quantity: 1 })).toEqual({ ok: false, code: "TASK_CHANGED" });
  });

  test("allows one open exception per order", () => {
    const order = blocked();
    expect(report(order, worker, { exceptionId: "y", type: "DAMAGED", reportedQty: null }, at(order))).toEqual({ ok: false, code: "OPEN_EXCEPTION" });
  });

  test("needs a current task to report against", () => {
    const done: Order = { ...start, lines: [line("shirt", 1, 1, 0)] };
    expect(report(done, worker, { exceptionId: "x", type: "OTHER", reportedQty: null }, at(done))).toEqual({ ok: false, code: "INVALID_TRANSITION" });
  });
});

describe("resolve then acknowledge", () => {
  test("resume keeps the target; the picker acknowledges and carries on", () => {
    const resolved = ok(resolve(blocked(), { kind: "RESUME" }, at(blocked())));
    expect(resolved.revision).toBe(2);
    expect(plan(resolved, worker)).toEqual({ kind: "RESOLUTION_ACK", exceptionId: "x" });
    const acked = ok(acknowledgeResolution(resolved, worker, "x", at(resolved)));
    expect(acked.exception).toBeNull();
    expect(plan(acked, worker)).toMatchObject({ task: { kind: "PICK", lineId: "cap", quantity: 2 } });
  });

  test("reduce lowers the target as a revision, and one acknowledgement covers both", () => {
    const resolved = ok(resolve(blocked(), { kind: "REDUCE", quantity: 2 }, at(blocked())));
    expect(resolved).toMatchObject({ revision: 3, lines: [{ requested: 1 }, { requested: 2, picked: 2 }] });
    const acked = ok(acknowledgeResolution(resolved, worker, "x", at(resolved)));
    expect(acked.assignment?.ackRevision).toBe(3);
    expect(plan(acked, worker)).toEqual({ kind: "REVIEW_COMPLETE" });
  });

  test("substitute keeps the old line in history and adds the replacement", () => {
    const substitute = { id: "grey", sku: "CP-GRY", name: "Grey cap", bin: "B-12", routeRank: 0 };
    const resolved = ok(resolve(blocked(), { kind: "SUBSTITUTE", quantity: 2, substitute, substituteQuantity: 2 }, at(blocked())));
    expect(resolved.lines.map((l) => [l.sku, l.requested, l.picked])).toEqual([["SHIRT", 1, 1], ["CAP", 2, 2], ["CP-GRY", 2, 0]]);
    const acked = ok(acknowledgeResolution(resolved, worker, "x", at(resolved)));
    expect(plan(acked, worker)).toMatchObject({ task: { kind: "PICK", lineId: "grey", quantity: 2 } });
  });

  test("cancel returns everything already in the tote", () => {
    const resolved = ok(resolve(blocked(), { kind: "CANCEL" }, at(blocked())));
    const acked = ok(acknowledgeResolution(resolved, worker, "x", at(resolved)));
    expect(acked.isCancelRequested).toBe(true);
    expect(plan(acked, worker)).toMatchObject({ task: { kind: "RETURN", lineId: "shirt", quantity: 1 } });
  });

  test.each([
    { name: "raising the target", resolution: { kind: "REDUCE" as const, quantity: 5 }, code: "QUANTITY_OUT_OF_RANGE" },
  ])("rejects $name", ({ resolution, code }) => {
    expect(resolve(blocked(), resolution, at(blocked()))).toEqual({ ok: false, code });
  });

  test("rejects a stale decision, a second decision and the wrong acknowledgement", () => {
    const order = blocked();
    expect(resolve(order, { kind: "RESUME" }, at(start))).toEqual({ ok: false, code: "STALE_VERSION" });
    const resolved = ok(resolve(order, { kind: "RESUME" }, at(order)));
    expect(resolve(resolved, { kind: "RESUME" }, at(resolved))).toEqual({ ok: false, code: "INVALID_TRANSITION" });
    expect(acknowledgeResolution(resolved, worker, "other", at(resolved))).toEqual({ ok: false, code: "INVALID_TRANSITION" });
  });
});

describe("pause", () => {
  test("pauses and resumes without touching the assignment", () => {
    const paused = ok(pause(start, worker, at(start)));
    expect(plan(paused, worker)).toEqual({ kind: "PAUSED" });
    expect(pause(paused, worker, at(paused))).toEqual({ ok: false, code: "NO_CHANGE" });
    const resumed = ok(resume(paused, worker, at(paused)));
    expect(resumed.assignment).toEqual(start.assignment);
    expect(plan(resumed, worker)).toMatchObject({ task: { lineId: "cap" } });
  });

  test("only the assigned worker can pause", () => {
    expect(pause(start, "worker-2", at(start))).toEqual({ ok: false, code: "ASSIGNMENT_CONFLICT" });
  });
});
