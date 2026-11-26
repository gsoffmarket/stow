import { describe, expect, test } from "vitest";
import { clampQuantity, moreScreen, pairingScreen, quantityScreen, screenFor, type Snapshot } from "./screens.ts";

const order = { id: "o1", ref: "ST-1042", revision: 2, version: "7", isCancelRequested: false, toteId: "A" };
const quickReplies = [{ id: "ON_IT", text: "On it" }, { id: "FOUND", text: "Found them" }];
const empty = { changes: [], decision: null, lastCompleted: null, note: null, quickReplies };

function snapshot(plan: Snapshot["plan"], extra: Partial<Snapshot> = {}): Snapshot {
  return { workspaceId: "w", cursor: "9", order, plan, ...empty, ...extra };
}

function task(kind: "PICK" | "RETURN", bin: string | null = "A-03"): Snapshot["plan"] {
  return {
    kind: "TASK",
    taskToken: "t",
    task: { kind, lineId: "l1", quantity: 3, revision: 2, version: "7", orderRef: "ST-1042", sku: "TS-BLK-M", name: "Black T-shirt", bin, toteId: "A" },
    progress: { confirmed: 0, requested: 6 },
  };
}

describe("tasks", () => {
  test("a pick shows bin, item, SKU and quantity; tap confirms it; swipe offers reports and pause", () => {
    const screen = screenFor(snapshot(task("PICK")), "online");
    expect(screen).toMatchObject({
      header: "ST-1042   TOTE A   0/6",
      body: "BIN A-03\nBLACK T-SHIRT\nTS-BLK-M\n\nPICK × 3",
      primary: { type: "CONFIRM", quantity: 3 },
    });
    expect(screen.options.map((option) => option.label)).toEqual(["PICK FEWER", "REPORT SHORTAGE", "DAMAGED ITEM", "WRONG LOCATION", "MESSAGE GROUP", "PAUSE ORDER"]);
  });

  test("a return says RETURN, never PICK -1, and asks for the actual return", () => {
    const screen = screenFor(snapshot(task("RETURN")), "online");
    expect(screen.body).toBe("RETURN × 3\nBLACK T-SHIRT\nBIN A-03 · TS-BLK-M");
    expect(screen.footer).toBe("TAP TO CONFIRM ACTUAL RETURN");
    expect(screen.options[1]).toEqual({ label: "CANNOT RETURN", action: { type: "REPORT", report: "RETURN_BLOCKED" } });
  });

  test("a return during cancellation says why", () => {
    const cancelling = snapshot(task("RETURN"), { order: { ...order, isCancelRequested: true } });
    expect(screenFor(cancelling, "online").body.split("\n")[0]).toBe("CANCELLED — RETURN REQUIRED");
  });

  test("a missing bin is said out loud, never invented", () => {
    expect(screenFor(snapshot(task("PICK", null)), "online").body).toMatch(/^LOCATION NOT SET/);
  });
});

describe("changes", () => {
  test("a revision stops the picker and lists each change with any return", () => {
    const revised = snapshot(
      { kind: "REVISION_ACK", fromRevision: 1, toRevision: 2 },
      { changes: [{ sku: "CP-WHT", from: 2, to: 4, picked: 0 }, { sku: "TS-BLK-M", from: 3, to: 1, picked: 3 }] },
    );
    expect(screenFor(revised, "online")).toMatchObject({
      header: "ST-1042   REVISION 2",
      body: "STOP — ORDER CHANGED\nCP-WHT  2 → 4\nTS-BLK-M  3 → 1 · RETURN 2",
      footer: "TAP TO ACKNOWLEDGE",
      primary: { type: "ACK_REVISION" },
      options: [],
    });
  });

  test.each([
    { decision: { resolution: "REDUCE", sku: "CP-WHT", target: 2 }, body: "REDUCED: CP-WHT → 2" },
    { decision: { resolution: "RESUME", sku: "CP-WHT", target: 4 }, body: "CARRY ON AS ORDERED" },
    { decision: { resolution: "CANCEL", sku: "CP-WHT", target: 0 }, body: "ORDER CANCELLED\nReturn everything in the tote." },
  ])("a $decision.resolution decision is shown before work continues", ({ decision, body }) => {
    const decided = snapshot({ kind: "RESOLUTION_ACK", exceptionId: "x" }, { decision });
    expect(screenFor(decided, "online")).toMatchObject({ body, primary: { type: "ACK_RESOLUTION", exceptionId: "x" } });
  });

  test("while blocked, the picker is told to wait and nothing can be confirmed", () => {
    const screen = screenFor(snapshot({ kind: "BLOCKED", exceptionId: "x" }), "online");
    expect(screen.body).toMatch(/^PROBLEM REPORTED/);
    expect(screen.primary).toEqual({ type: "REFRESH" });
  });

  test("paused resumes on tap; a cancelled order is closed once empty", () => {
    expect(screenFor(snapshot({ kind: "PAUSED" }), "online").primary).toEqual({ type: "RESUME" });
    expect(screenFor(snapshot({ kind: "REVIEW_CANCEL" }), "online").primary).toEqual({ type: "CLOSE_CANCELLED" });
  });
});

describe("after closing an order", () => {
  const closed = { ref: "ST-1042", terminal: "COMPLETED" as const, units: 5, delivery: "PENDING" as const };

  test("says it is saved and whether Telegram has it, before offering the next order", () => {
    const next = snapshot({ kind: "OFFER" }, { order: { ...order, ref: "ST-1043" }, lastCompleted: closed });
    expect(screenFor(next, "online")).toMatchObject({
      header: "ST-1042   COMPLETED",
      body: "SAVED\n5 units confirmed\nTELEGRAM: PENDING",
      primary: { type: "DISMISS" },
    });
    expect(screenFor(next, "online", "ST-1042").primary).toEqual({ type: "CLAIM" });
  });

  test("an unconfirmed delivery is not called sent", () => {
    const uncertain = snapshot({ kind: "QUEUE_EMPTY" }, { lastCompleted: { ...closed, delivery: "UNCERTAIN" } });
    expect(screenFor(uncertain, "online").body).toContain("TELEGRAM: NOT CONFIRMED");
  });
});

describe("connection states", () => {
  test.each([
    { link: "saving" as const, body: /^SAVING/, primary: null },
    { link: "offline" as const, body: /^NOT CONNECTED/, primary: { type: "REFRESH" } },
    { link: "uncertain" as const, body: /^OUTCOME UNKNOWN/, primary: { type: "REFRESH" } },
    { link: "rejected" as const, body: /^NOT SAVED/, primary: { type: "REFRESH" } },
  ])("$link replaces the task so nothing can be confirmed against stale data", ({ link, body, primary }) => {
    const screen = screenFor(snapshot(task("PICK")), link);
    expect(screen.body).toMatch(body);
    expect(screen.primary).toEqual(primary);
    expect(screen.options).toEqual([]);
  });
});

describe("the More screen", () => {
  const base = screenFor(snapshot(task("PICK")), "online");

  test("lists the options with a cursor, ending in Back, and tap chooses the one under it", () => {
    expect(moreScreen(base.options, "ST-1042", 0)).toMatchObject({
      header: "ST-1042   MORE",
      body: "> PICK FEWER\n  REPORT SHORTAGE\n  DAMAGED ITEM\n  WRONG LOCATION\n  MESSAGE GROUP\n  PAUSE ORDER\n  BACK",
      primary: { type: "CHOOSE_QUANTITY" },
    });
    expect(moreScreen(base.options, "ST-1042", 6).primary).toEqual({ type: "BACK" });
  });

  test("the cursor wraps both ways", () => {
    expect(moreScreen(base.options, "ST-1042", 7).primary).toEqual({ type: "CHOOSE_QUANTITY" });
    expect(moreScreen(base.options, "ST-1042", -1).primary).toEqual({ type: "BACK" });
  });
});

describe("pairing", () => {
  test("shows the code and where to enter it", () => {
    expect(pairingScreen("K7Q4-M2XP", "online")).toMatchObject({
      header: "STOW   PAIR",
      body: "CODE  K7Q4-M2XP\n\nOpen Stow in Telegram\nand enter this code.",
      primary: { type: "REFRESH" },
    });
  });

  test("says when it cannot reach the server instead of showing a stale code", () => {
    expect(pairingScreen("K7Q4-M2XP", "offline").body).toMatch(/^NOT CONNECTED/);
  });
});

describe("coordinator notes", () => {
  const withNote = snapshot(task("PICK"), { note: { id: "n1", body: "White caps are on the top shelf.", author: "Coordinator" } });

  test("a note takes the screen with who sent it; tap marks it read", () => {
    expect(screenFor(withNote, "online")).toMatchObject({
      header: "ST-1042   NOTE · COORDINATOR",
      body: "White caps are on the top shelf.",
      footer: "TAP: GOT IT · SWIPE: REPLY",
      primary: { type: "MARK_READ", noteId: "n1" },
    });
  });

  test("swiping from a note offers quick replies that also mark it read", () => {
    const options = screenFor(withNote, "online").options;
    expect(options).toEqual([
      { label: "ON IT", action: { type: "REPLY", replyId: "ON_IT", noteId: "n1" } },
      { label: "FOUND THEM", action: { type: "REPLY", replyId: "FOUND", noteId: "n1" } },
    ]);
  });

  test("a note never covers a save in progress or an unknown outcome", () => {
    expect(screenFor(withNote, "saving").body).toMatch(/^SAVING/);
    expect(screenFor(withNote, "uncertain").body).toMatch(/^OUTCOME UNKNOWN/);
  });
});

describe("fewer than asked", () => {
  test("a chosen quantity is confirmed as exactly that, with what was asked alongside", () => {
    expect(quantityScreen(snapshot(task("PICK")), 2)).toMatchObject({
      header: "ST-1042   TOTE A   HOW MANY?",
      body: "PICK × 2\nof 3 asked\nBLACK T-SHIRT\nTS-BLK-M",
      primary: { type: "CONFIRM", quantity: 2 },
    });
  });

  test("zero is cancel, never a confirmation", () => {
    expect(quantityScreen(snapshot(task("RETURN")), 0)).toMatchObject({ body: "CANCEL\nRETURN × 3 stays as asked.", primary: { type: "BACK" } });
  });

  test("the choice stays between cancel and what was asked", () => {
    expect([clampQuantity(-1, 3), clampQuantity(4, 3), clampQuantity(2, 3)]).toEqual([0, 3, 2]);
  });

  test("a single unit has nothing fewer to choose", () => {
    const one = snapshot({ ...(task("PICK") as Extract<Snapshot["plan"], { kind: "TASK" }>), task: { ...(task("PICK") as Extract<Snapshot["plan"], { kind: "TASK" }>).task, quantity: 1 } });
    expect(screenFor(one, "online").options.map((option) => option.label)).not.toContain("PICK FEWER");
  });
});
