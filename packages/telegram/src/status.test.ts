import { describe, expect, test } from "vitest";
import { reducedTarget, renderException, renderReply, renderStatus } from "./status.ts";

const lines = [
  { sku: "TS-BLK-M", requested: 3, picked: 3 },
  { sku: "CP-WHT", requested: 2, picked: 0 },
];

describe("renderStatus", () => {
  test("a queued order shows its size and waits for a picker", () => {
    expect(renderStatus({ ref: "ST-1042", revision: 1, terminal: null, picker: null, toteId: null, lines, hold: "NONE", note: "NONE" })).toBe(
      "ST-1042 · QUEUED · rev 1\nTS-BLK-M: 3/3\nCP-WHT: 0/2\n2 lines / 5 units. Awaiting picker.",
    );
  });

  test("a picking order names the tote and picker and counts confirmed units", () => {
    expect(renderStatus({ ref: "ST-1042", revision: 1, terminal: null, picker: "Picker 02", toteId: "A", lines, hold: "NONE", note: "NONE" })).toBe(
      "ST-1042 · PICKING · rev 1\nTote A · Picker 02\nTS-BLK-M: 3/3\nCP-WHT: 0/2\nProgress: 3/5 confirmed.",
    );
  });

  test("excess after a reduction shows as a return, never as more than 100%", () => {
    const text = renderStatus({ ref: "ST-1", revision: 2, terminal: null, picker: "P", toteId: "A", lines: [{ sku: "A", requested: 1, picked: 3 }], hold: "NONE", note: "NONE" });
    expect(text).toContain("A: 1/1 · return 2");
    expect(text).toContain("Progress: 1/1 confirmed.");
  });

  test("a completed order says the count is worker-confirmed", () => {
    const text = renderStatus({ ref: "ST-1", revision: 1, terminal: "COMPLETED", picker: "P", toteId: "A", lines: [{ sku: "A", requested: 2, picked: 2 }], hold: "NONE", note: "NONE" });
    expect(text.split("\n").at(-1)).toBe("2 units confirmed by the picker. Not independently verified.");
  });

  test("very long orders are cut below Telegram's limit with a marker", () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ sku: `SKU-${String(i).padStart(4, "0")}-LONG-NAME`, requested: 1, picked: 0 }));
    const text = renderStatus({ ref: "ST-1", revision: 1, terminal: null, picker: null, toteId: null, lines: many, hold: "NONE", note: "NONE" });
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text.endsWith("… (truncated)")).toBe(true);
  });
});

describe("holds", () => {
  test.each([
    ["AWAITING_PICKER_ACK", "AWAITING PICKER"],
    ["BLOCKED", "BLOCKED"],
    ["CANCELLING", "CANCELLING"],
    ["RELEASING", "RELEASING"],
    ["PAUSED", "PAUSED"],
  ] as const)("%s shows as %s in the header", (hold, label) => {
    const text = renderStatus({ ref: "ST-1", revision: 2, terminal: null, picker: "P", toteId: "A", lines, hold, note: "NONE" });
    expect(text.split("\n")[0]).toBe(`ST-1 · ${label} · rev 2`);
  });
});

describe("renderException", () => {
  const notice = { ref: "ST-1042", type: "SHORTAGE" as const, sku: "CP-WHT", requested: 4, picked: 2, reportedQty: 0, picker: "Picker 02", decision: null };

  test("asks for a decision with what the picker found", () => {
    expect(renderException(notice)).toBe("ST-1042 · SHORTAGE\nCP-WHT · 2/4 picked · 0 more found\nReported by Picker 02.\nAwaiting your decision.");
  });

  test("shows the decision once made", () => {
    expect(renderException({ ...notice, decision: "reduce to 2" }).split("\n").at(-1)).toBe("Decision: reduce to 2");
  });

  test.each([
    { picked: 2, reportedQty: 0, requested: 4, want: 2 },
    { picked: 0, reportedQty: 1, requested: 4, want: 1 },
    { picked: 1, reportedQty: null, requested: 4, want: 1 },
    { picked: 1, reportedQty: 9, requested: 4, want: 4 },
  ])("reduce offers picked $picked + found $reportedQty, capped at $requested", ({ want, ...input }) => {
    expect(reducedTarget(input)).toBe(want);
  });
});

describe("notes and replies", () => {
  test("the status message says whether the picker has read the note", () => {
    const base = { ref: "ST-1", revision: 1, terminal: null, picker: "P", toteId: "A", lines, hold: "NONE" as const };
    expect(renderStatus({ ...base, note: "UNREAD" }).split("\n").at(-1)).toBe("Note sent to the picker.");
    expect(renderStatus({ ...base, note: "READ" }).split("\n").at(-1)).toBe("Note read by the picker.");
  });

  test("a reply names the picker and the order", () => {
    expect(renderReply("Picker 02", "ST-1042", "Found them")).toBe("Picker 02 · ST-1042: Found them");
  });
});
