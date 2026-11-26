// The product catalogue: importing it from CSV, and reading it back.
//
// Import is two steps with the same parser: preview shows every row's fate
// and every error with its row number; commit re-parses the same text and
// writes it all or nothing. Re-parsing at commit, rather than trusting a
// stored preview, means the rows written are exactly the rows validated.
//
// Products already in the catalogue are only changed when the import says so
// explicitly, and active orders keep their own snapshot of names and bins.

import type pg from "pg";
import { transaction } from "./fulfilment.ts";

export const importLimits = { bytes: 2 * 1024 * 1024, rows: 5000 } as const;

const columns = ["sku", "name", "bin", "route_rank"] as const;

export type CatalogueRow = { readonly line: number; readonly sku: string; readonly name: string; readonly bin: string | null; readonly routeRank: number };
export type RowError = { readonly line: number; readonly field: string; readonly problem: string };

/** parseCatalogue reads CSV with a header row; sku and name are required, bin and route_rank optional. */
export function parseCatalogue(text: string): { rows: CatalogueRow[]; errors: RowError[] } {
  const errors: RowError[] = [];
  if (Buffer.byteLength(text) > importLimits.bytes) return { rows: [], errors: [{ line: 0, field: "file", problem: "larger than 2 MB" }] };
  const records = splitCsv(text.replace(/^﻿/, ""));
  const header = (records.shift() ?? []).map((cell) => cell.trim().toLowerCase());
  const unknown = header.filter((name) => !(columns as readonly string[]).includes(name));
  if (!header.includes("sku") || !header.includes("name")) errors.push({ line: 1, field: "header", problem: "needs sku and name columns" });
  for (const name of unknown) errors.push({ line: 1, field: name, problem: "unknown column" });
  if (records.length > importLimits.rows) errors.push({ line: 0, field: "file", problem: `more than ${importLimits.rows} rows` });
  if (errors.length > 0) return { rows: [], errors };

  const rows: CatalogueRow[] = [];
  const seen = new Map<string, number>();
  records.forEach((cells, index) => {
    const line = index + 2;
    if (cells.every((cell) => cell.trim() === "")) return;
    const value = (name: string) => (cells[header.indexOf(name)] ?? "").trim();
    const sku = value("sku").normalize("NFKC").toUpperCase();
    const name = value("name");
    const bin = value("bin");
    const rank = value("route_rank");
    if (!/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(sku)) errors.push({ line, field: "sku", problem: "use 1–64 letters, digits, dot, dash or underscore" });
    else if (seen.has(sku)) errors.push({ line, field: "sku", problem: `repeats line ${seen.get(sku)}` });
    if (name.length < 1 || name.length > 120) errors.push({ line, field: "name", problem: "needs 1–120 characters" });
    if (bin.length > 32) errors.push({ line, field: "bin", problem: "longer than 32 characters" });
    if (rank !== "" && !/^-?[0-9]{1,6}$/.test(rank)) errors.push({ line, field: "route_rank", problem: "must be a whole number" });
    seen.set(sku, line);
    rows.push({ line, sku, name, bin: bin || null, routeRank: rank === "" ? 0 : Number(rank) });
  });
  return { rows: errors.length > 0 ? [] : rows, errors };
}

// RFC 4180: quoted fields may contain commas, quotes ("") and line breaks.
function splitCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else field += char;
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

export type Fate = "NEW" | "UPDATE" | "UNCHANGED";
export type Preview = { readonly rows: readonly (CatalogueRow & { readonly fate: Fate })[]; readonly errors: readonly RowError[] };

/** preview validates an import and says what each row would do, without writing anything. */
export async function preview(pool: pg.Pool, workspaceId: string, csv: string): Promise<Preview> {
  const parsed = parseCatalogue(csv);
  if (parsed.errors.length > 0) return { rows: [], errors: parsed.errors };
  const existing = await pool.query<{ normalized_sku: string; name: string; bin: string | null; route_rank: number }>(
    "select normalized_sku, name, bin, route_rank from products where workspace_id = $1 and normalized_sku = any($2)",
    [workspaceId, parsed.rows.map((row) => row.sku)],
  );
  const bySku = new Map(existing.rows.map((product) => [product.normalized_sku, product]));
  return {
    errors: [],
    rows: parsed.rows.map((row) => {
      const current = bySku.get(row.sku);
      const fate: Fate = !current ? "NEW" : current.name === row.name && current.bin === row.bin && current.route_rank === row.routeRank ? "UNCHANGED" : "UPDATE";
      return { ...row, fate };
    }),
  };
}

export type Commit =
  | { readonly ok: true; readonly added: number; readonly updated: number; readonly unchanged: number }
  | { readonly ok: false; readonly code: "IMPORT_ERRORS"; readonly errors: readonly RowError[] }
  | { readonly ok: false; readonly code: "UPDATES_NOT_ALLOWED"; readonly skus: readonly string[] };

/**
 * commit writes a validated import in one transaction. Rows that would change
 * an existing product are refused unless allowUpdates is set, so a stray file
 * cannot quietly rename half the catalogue.
 */
export async function commit(pool: pg.Pool, workspaceId: string, csv: string, allowUpdates: boolean): Promise<Commit> {
  const checked = await preview(pool, workspaceId, csv);
  if (checked.errors.length > 0) return { ok: false, code: "IMPORT_ERRORS", errors: checked.errors };
  const updates = checked.rows.filter((row) => row.fate === "UPDATE");
  if (updates.length > 0 && !allowUpdates) return { ok: false, code: "UPDATES_NOT_ALLOWED", skus: updates.map((row) => row.sku) };
  await transaction(pool, async (client) => {
    for (const row of checked.rows.filter((candidate) => candidate.fate !== "UNCHANGED")) {
      await client.query(
        `insert into products (workspace_id, sku, normalized_sku, name, bin, route_rank) values ($1, $2, $2, $3, $4, $5)
         on conflict (workspace_id, normalized_sku) do update set name = excluded.name, bin = excluded.bin, route_rank = excluded.route_rank, is_active = true, updated_at = now()`,
        [workspaceId, row.sku, row.name, row.bin, row.routeRank],
      );
    }
  });
  const count = (fate: Fate) => checked.rows.filter((row) => row.fate === fate).length;
  return { ok: true, added: count("NEW"), updated: count("UPDATE"), unchanged: count("UNCHANGED") };
}

export type Product = { readonly sku: string; readonly name: string; readonly bin: string | null; readonly routeRank: number };

/** products lists the active catalogue in walking order. */
export async function products(pool: pg.Pool, workspaceId: string): Promise<Product[]> {
  const { rows } = await pool.query<{ sku: string; name: string; bin: string | null; route_rank: number }>(
    "select sku, name, bin, route_rank from products where workspace_id = $1 and is_active order by route_rank, bin nulls last, sku limit 5000",
    [workspaceId],
  );
  return rows.map((row) => ({ sku: row.sku, name: row.name, bin: row.bin, routeRank: row.route_rank }));
}
