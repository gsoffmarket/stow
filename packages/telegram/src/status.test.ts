import { describe, expect, test } from "vitest";
import { renderStatus } from "./status.ts";

const lines = [
  { sku: "TS-BLK-M", requested: 3, picked: 3 },
  { sku: "CP-WHT", requested: 2, picked: 0 },
];

describe("renderStatus", () => {
  test("a queued order shows its size and waits for a picker", () => {
    expect(renderStatus({ ref: "ST-1042", revision: 1, terminal: null, picker: null, toteId: null, lines })).toBe(
      "ST-1042 · QUEUED · rev 1\nTS-BLK-M: 3/3\nCP-WHT: 0/2\n2 lines / 5 units. Awaiting picker.",
    );
  });

  test("a picking order names the tote and picker and counts confirmed units", () => {
    expect(renderStatus({ ref: "ST-1042", revision: 1, terminal: null, picker: "Picker 02", toteId: "A", lines })).toBe(
      "ST-1042 · PICKING · rev 1\nTote A · Picker 02\nTS-BLK-M: 3/3\nCP-WHT: 0/2\nProgress: 3/5 confirmed.",
    );
  });

  test("excess after a reduction shows as a return, never as more than 100%", () => {
    const text = renderStatus({ ref: "ST-1", revision: 2, terminal: null, picker: "P", toteId: "A", lines: [{ sku: "A", requested: 1, picked: 3 }] });
    expect(text).toContain("A: 1/1 · return 2");
    expect(text).toContain("Progress: 1/1 confirmed.");
  });

  test("a completed order says the count is worker-confirmed", () => {
    const text = renderStatus({ ref: "ST-1", revision: 1, terminal: "COMPLETED", picker: "P", toteId: "A", lines: [{ sku: "A", requested: 2, picked: 2 }] });
    expect(text.split("\n").at(-1)).toBe("2 units confirmed by the picker. Not independently verified.");
  });

  test("very long orders are cut below Telegram's limit with a marker", () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ sku: `SKU-${String(i).padStart(4, "0")}-LONG-NAME`, requested: 1, picked: 0 }));
    const text = renderStatus({ ref: "ST-1", revision: 1, terminal: null, picker: null, toteId: null, lines: many });
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text.endsWith("… (truncated)")).toBe(true);
  });
});
