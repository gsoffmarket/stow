// Parsing of the explicit bot commands Stow accepts in a bound work group.
// Only messages that start with a slash command are ever looked at; ordinary
// chat is ignored before it reaches this module.
//
// The order grammar is deliberately strict. Anything the parser is unsure of
// becomes an error the coordinator can fix, never a guess:
//
//   /order [REF]
//   ITEM x QTY       (x, X or ×; one line per item; QTY is a positive integer)
//
// ITEM is a SKU or one of a product's aliases, as typed. Matching it to the
// catalogue happens on the server, which can say an item is unknown or
// matches several products.

/** Command is a recognised slash command with the text that followed it. */
export type Command = { readonly name: string; readonly args: string; readonly body: readonly string[] };

/**
 * parseCommand reads `/name[@bot] args` on the first line. It returns null for
 * anything that is not a command, or a command addressed to a different bot.
 */
export function parseCommand(text: string, botUsername: string): Command | null {
  const [first = "", ...rest] = text.normalize("NFKC").split(/\r?\n/);
  const match = /^\/([a-z_]{1,32})(?:@([A-Za-z0-9_]{5,32}))?(?:\s+(.*))?$/.exec(first.trim());
  if (!match) return null;
  const [, name = "", addressee, args = ""] = match;
  if (addressee && addressee.toLowerCase() !== botUsername.toLowerCase()) return null;
  return { name, args: args.trim(), body: rest.map((line) => line.trim()).filter((line) => line !== "") };
}

export const orderLimits = { lines: 100, unitsPerLine: 10_000, unitsPerOrder: 20_000 } as const;

/** OrderRequest is an order whose lines name catalogue SKUs. */
export type OrderRequest = { readonly ref: string | null; readonly lines: readonly { sku: string; quantity: number }[] };

/** TypedOrder is a syntactically valid /order; its items are not yet matched to the catalogue. */
export type TypedOrder = { readonly ref: string | null; readonly lines: readonly { item: string; quantity: number }[] };

/** OrderError names one problem, with the 1-based body line it came from where there is one. */
export type OrderError = {
  readonly code: "INVALID_REF" | "NO_LINES" | "TOO_MANY_LINES" | "BAD_LINE" | "QUANTITY_OUT_OF_RANGE" | "DUPLICATE_SKU" | "ORDER_TOO_LARGE";
  readonly line?: number;
};

export type OrderParse = { readonly ok: true; readonly order: TypedOrder } | { readonly ok: false; readonly errors: readonly OrderError[] };

/** parseOrder turns an /order command into lines, or every error found in one pass. */
export function parseOrder(command: Command): OrderParse {
  const errors: OrderError[] = [];
  const ref = command.args === "" ? null : command.args;
  if (ref !== null && !isRef(ref)) errors.push({ code: "INVALID_REF" });
  const parsed = parseItemLines(command.body);
  errors.push(...parsed.errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, order: { ref, lines: parsed.lines } };
}

/** itemKey is how two typed items are compared: Unicode-normalised, case-folded, single-spaced. */
export function itemKey(item: string): string {
  return item.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

// Order lines name an item as typed, so an alias with spaces ("black tee x 2")
// reads as one item. The item is everything before the last x and quantity.
function parseItemLines(body: readonly string[]): { lines: { item: string; quantity: number }[]; errors: OrderError[] } {
  const errors: OrderError[] = [];
  if (body.length === 0) errors.push({ code: "NO_LINES" });
  if (body.length > orderLimits.lines) return { lines: [], errors: [...errors, { code: "TOO_MANY_LINES" }] };
  const lines: { item: string; quantity: number }[] = [];
  const seen = new Set<string>();
  body.forEach((text, index) => {
    const line = index + 1;
    const match = /^([^\s\p{Cc}](?:[^\p{Cc}]{0,62}[^\s\p{Cc}])?)\s*[xX×]\s*([0-9]{1,6})$/u.exec(text);
    if (!match) {
      errors.push({ code: "BAD_LINE", line });
      return;
    }
    const item = match[1]!.replace(/\s+/g, " ");
    const quantity = Number(match[2]);
    if (quantity < 1 || quantity > orderLimits.unitsPerLine) errors.push({ code: "QUANTITY_OUT_OF_RANGE", line });
    // A repeated item is ambiguous (two picks, or a correction?), so it is
    // refused rather than summed or overwritten.
    if (seen.has(itemKey(item))) errors.push({ code: "DUPLICATE_SKU", line });
    seen.add(itemKey(item));
    lines.push({ item, quantity });
  });
  const units = lines.reduce((sum, line) => sum + line.quantity, 0);
  if (units > orderLimits.unitsPerOrder) errors.push({ code: "ORDER_TOO_LARGE" });
  return { lines, errors };
}

/**
 * parseRevise reads `/revise REF` followed by `SKU x QTY` lines, or the
 * one-line form `/revise REF SKU QTY`. Quantities are absolute targets and
 * may be zero, which removes the line's demand.
 */
export function parseRevise(command: Command): { ok: true; ref: string; lines: { sku: string; quantity: number }[] } | { ok: false; errors: readonly OrderError[] } {
  const [ref = "", ...rest] = command.args.split(/\s+/);
  if (!isRef(ref)) return { ok: false, errors: [{ code: "INVALID_REF" }] };
  const body = rest.length > 0 ? [rest.join(" ").replace(/^(\S+)\s+(\d+)$/, "$1 x $2"), ...command.body] : command.body;
  const parsed = parseLines(body);
  if (parsed.errors.length > 0) return { ok: false, errors: parsed.errors };
  return { ok: true, ref, lines: parsed.lines };
}

/** parseRefAndText reads `REF free text`, as in `/cancel ST-1 customer changed mind`. */
export function parseRefAndText(args: string): { ref: string; text: string } | null {
  const match = /^(\S+)(?:\s+(.*))?$/.exec(args.trim());
  if (!match || !isRef(match[1]!)) return null;
  return { ref: match[1]!, text: (match[2] ?? "").slice(0, 280) };
}

function isRef(ref: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(ref);
}

// Revision lines name SKUs already in the order, or new SKUs; zero removes demand.
function parseLines(body: readonly string[]): { lines: { sku: string; quantity: number }[]; errors: OrderError[] } {
  const errors: OrderError[] = [];
  if (body.length === 0) errors.push({ code: "NO_LINES" });
  if (body.length > orderLimits.lines) return { lines: [], errors: [...errors, { code: "TOO_MANY_LINES" }] };
  const lines: { sku: string; quantity: number }[] = [];
  const seen = new Set<string>();
  body.forEach((text, index) => {
    const line = index + 1;
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s*[xX×]\s*([0-9]{1,6})$/.exec(text);
    if (!match) {
      errors.push({ code: "BAD_LINE", line });
      return;
    }
    const sku = match[1]!.toUpperCase();
    const quantity = Number(match[2]);
    if (quantity > orderLimits.unitsPerLine) errors.push({ code: "QUANTITY_OUT_OF_RANGE", line });
    // A repeated SKU is ambiguous (two picks, or a correction?), so it is
    // refused rather than summed or overwritten.
    if (seen.has(sku)) errors.push({ code: "DUPLICATE_SKU", line });
    seen.add(sku);
    lines.push({ sku, quantity });
  });
  const units = lines.reduce((sum, line) => sum + line.quantity, 0);
  if (units > orderLimits.unitsPerOrder) errors.push({ code: "ORDER_TOO_LARGE" });
  return { lines, errors };
}
