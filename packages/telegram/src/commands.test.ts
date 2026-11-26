import { describe, expect, test } from "vitest";
import { parseCommand, parseOrder, parseRefAndText, parseRevise, type Command } from "./commands.ts";

const bot = "stow_test_bot";

describe("parseCommand", () => {
  test.each([
    { text: "/order ST-1\nA x 1", want: { name: "order", args: "ST-1", body: ["A x 1"] } },
    { text: "/order@Stow_Test_Bot\n  A x 1  \n\n", want: { name: "order", args: "", body: ["A x 1"] } },
    { text: "/stow_bind 1234", want: { name: "stow_bind", args: "1234", body: [] } },
  ])("parses $text", ({ text, want }) => {
    expect(parseCommand(text, bot)).toEqual(want);
  });

  test.each(["hello team", "order ST-1", "/order@other_bot\nA x 1", "/ORDER", ""])("ignores %j", (text) => {
    expect(parseCommand(text, bot)).toBeNull();
  });
});

function order(args: string, ...body: string[]): Command {
  return { name: "order", args, body };
}

describe("parseOrder", () => {
  test("reads lines with x, X or × and upper-cases SKUs", () => {
    expect(parseOrder(order("ST-1042", "ts-blk-m x 3", "CP-WHT X 2", "TB-NAT×1"))).toEqual({
      ok: true,
      order: {
        ref: "ST-1042",
        lines: [
          { sku: "TS-BLK-M", quantity: 3 },
          { sku: "CP-WHT", quantity: 2 },
          { sku: "TB-NAT", quantity: 1 },
        ],
      },
    });
  });

  test("a missing ref is left for the server to generate", () => {
    expect(parseOrder(order("", "A x 1"))).toMatchObject({ ok: true, order: { ref: null } });
  });

  test.each([
    { name: "a negative quantity", body: ["A x -1"], code: "BAD_LINE" },
    { name: "a decimal quantity", body: ["A x 1.5"], code: "BAD_LINE" },
    { name: "a missing quantity", body: ["A"], code: "BAD_LINE" },
    { name: "zero units", body: ["A x 0"], code: "QUANTITY_OUT_OF_RANGE" },
    { name: "more than 10,000 units", body: ["A x 10001"], code: "QUANTITY_OUT_OF_RANGE" },
    { name: "a repeated SKU", body: ["A x 1", "a x 2"], code: "DUPLICATE_SKU" },
    { name: "no lines", body: [], code: "NO_LINES" },
  ])("rejects $name", ({ body, code }) => {
    const got = parseOrder(order("", ...body));
    expect(got.ok).toBe(false);
    expect(!got.ok && got.errors.map((error) => error.code)).toContain(code);
  });

  test("reports the body line of each bad row", () => {
    expect(parseOrder(order("", "A x 1", "nonsense", "B x 0"))).toEqual({
      ok: false,
      errors: [
        { code: "BAD_LINE", line: 2 },
        { code: "QUANTITY_OUT_OF_RANGE", line: 3 },
      ],
    });
  });

  test("rejects a ref with spaces or punctuation", () => {
    expect(parseOrder(order("ST 1", "A x 1"))).toEqual({ ok: false, errors: [{ code: "INVALID_REF" }] });
  });

  test("rejects more than 100 lines and more than 20,000 units", () => {
    const many = Array.from({ length: 101 }, (_, i) => `S${i} x 1`);
    expect(parseOrder(order("", ...many))).toEqual({ ok: false, errors: [{ code: "TOO_MANY_LINES" }] });
    const heavy = ["A x 10000", "B x 10000", "C x 1"];
    expect(parseOrder(order("", ...heavy))).toEqual({ ok: false, errors: [{ code: "ORDER_TOO_LARGE" }] });
  });
});

describe("parseRevise", () => {
  test("takes the one-line form and the multi-line form, with zero allowed", () => {
    expect(parseRevise({ name: "revise", args: "ST-1042 cp-wht 4", body: [] })).toEqual({ ok: true, ref: "ST-1042", lines: [{ sku: "CP-WHT", quantity: 4 }] });
    expect(parseRevise({ name: "revise", args: "ST-1042", body: ["TS-BLK-M x 0", "CP-GRY x 2"] })).toEqual({
      ok: true,
      ref: "ST-1042",
      lines: [{ sku: "TS-BLK-M", quantity: 0 }, { sku: "CP-GRY", quantity: 2 }],
    });
  });

  test("needs a ref and at least one line", () => {
    expect(parseRevise({ name: "revise", args: "", body: ["A x 1"] })).toEqual({ ok: false, errors: [{ code: "INVALID_REF" }] });
    expect(parseRevise({ name: "revise", args: "ST-1", body: [] })).toEqual({ ok: false, errors: [{ code: "NO_LINES" }] });
  });
});

describe("parseRefAndText", () => {
  test("splits a ref from the reason", () => {
    expect(parseRefAndText("ST-1 customer changed their mind")).toEqual({ ref: "ST-1", text: "customer changed their mind" });
    expect(parseRefAndText("ST-1")).toEqual({ ref: "ST-1", text: "" });
    expect(parseRefAndText("")).toBeNull();
  });
});
