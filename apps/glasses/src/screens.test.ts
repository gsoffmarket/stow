import { describe, expect, test } from "vitest";
import { screenFor, type Snapshot } from "./screens.ts";

const order = { id: "o1", ref: "ST-1042", revision: 1, version: "3", toteId: "A" };

function taskSnapshot(kind: "PICK" | "RETURN", bin: string | null = "A-03"): Snapshot {
  return {
    workspaceId: "w",
    cursor: "9",
    order,
    plan: {
      kind: "TASK",
      taskToken: "t",
      task: { kind, lineId: "l1", quantity: 3, revision: 1, version: "3", orderRef: "ST-1042", sku: "TS-BLK-M", name: "Black T-shirt", bin, toteId: "A" },
      progress: { confirmed: 0, requested: 6 },
    },
  };
}

describe("screenFor", () => {
  test("a pick shows bin, item, SKU and quantity, and a tap confirms the shown quantity", () => {
    expect(screenFor(taskSnapshot("PICK"), "online")).toEqual({
      header: "ST-1042   TOTE A   0/6",
      body: "BIN A-03\nBLACK T-SHIRT\nTS-BLK-M\n\nPICK × 3",
      footer: "TAP TO CONFIRM",
      primary: { type: "CONFIRM", quantity: 3 },
    });
  });

  test("a return says RETURN and asks for the actual return", () => {
    const screen = screenFor(taskSnapshot("RETURN"), "online");
    expect(screen.body).toContain("RETURN × 3");
    expect(screen.footer).toBe("TAP TO CONFIRM ACTUAL RETURN");
  });

  test("a missing bin is said out loud, never invented", () => {
    expect(screenFor(taskSnapshot("PICK", null), "online").body).toMatch(/^LOCATION NOT SET/);
  });

  test.each([
    { link: "saving" as const, body: /^SAVING/, primary: null },
    { link: "offline" as const, body: /^NOT CONNECTED/, primary: { type: "REFRESH" } },
    { link: "uncertain" as const, body: /^OUTCOME UNKNOWN/, primary: { type: "REFRESH" } },
    { link: "rejected" as const, body: /^NOT SAVED/, primary: { type: "REFRESH" } },
  ])("$link replaces the task so nothing can be confirmed against stale data", ({ link, body, primary }) => {
    const screen = screenFor(taskSnapshot("PICK"), link);
    expect(screen.body).toMatch(body);
    expect(screen.primary).toEqual(primary);
  });

  test("an offer starts the order and review completes it", () => {
    expect(screenFor({ workspaceId: "w", cursor: "1", order, plan: { kind: "OFFER" } }, "online").primary).toEqual({ type: "CLAIM" });
    expect(screenFor({ workspaceId: "w", cursor: "1", order, plan: { kind: "REVIEW_COMPLETE" } }, "online").primary).toEqual({ type: "COMPLETE" });
  });
});
