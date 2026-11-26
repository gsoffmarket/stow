// The product catalogue: importing it from CSV, and reading it back.
//
// Import is two steps with the same parser: preview shows every row's fate
// and every error with its row number; commit re-parses the same text and
// writes it all or nothing. Re-parsing at commit, rather than trusting a
// stored preview, means the rows written are exactly the rows validated.
//
// Products already in the catalogue are only changed when the import says so
// explicitly, and active orders keep their own snapshot of names and bins.
//
// Aliases are other names a coordinator may type in /order. A file without an
// aliases column leaves existing aliases alone; with one, each row's list
// replaces that product's aliases.

import { itemKey } from "@stow/telegram/commands";
import type pg from "pg";
import { readCsv, writeCsv } from "./csv.ts";
import { transaction } from "./fulfilment.ts";

export const importLimits = { bytes: 2 * 1024 * 1024, rows: 5000 } as const;

const columns = ["sku", "name", "bin", "route_rank", "aliases"] as const;
const aliasesPerProduct_max = 20;

/** CatalogueRow is one product from an import; aliases is null when the file has no aliases column. */
export type CatalogueRow = {
  readonly line: number;
  readonly sku: string;
  readonly name: string;
  readonly bin: string | null;
  readonly routeRank: number;
  readonly aliases: readonly string[] | null;
};
export type RowError = { readonly line: number; readonly field: string; readonly problem: string };

/** parseCatalogue reads CSV with a header row; sku and name are required, bin, route_rank and aliases optional. */
export function parseCatalogue(text: string): { rows: CatalogueRow[]; errors: RowError[] } {
  const errors: RowError[] = [];
  if (Buffer.byteLength(text) > importLimits.bytes) return { rows: [], errors: [{ line: 0, field: "file", problem: "larger than 2 MB" }] };
  const records = readCsv(text.replace(/^﻿/, ""));
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
    const aliases = header.includes("aliases") ? parseAliases(value("aliases")) : null;
    if (aliases?.some((alias) => alias.length > 64)) errors.push({ line, field: "aliases", problem: "each alias needs 1–64 characters" });
    if (aliases && aliases.length > aliasesPerProduct_max) errors.push({ line, field: "aliases", problem: `more than ${aliasesPerProduct_max} aliases` });
    seen.set(sku, line);
    rows.push({ line, sku, name, bin: bin || null, routeRank: rank === "" ? 0 : Number(rank), aliases });
  });
  return { rows: errors.length > 0 ? [] : rows, errors };
}

// Aliases are separated by semicolons; one typed twice is kept once.
function parseAliases(field: string): string[] {
  const kept = new Map<string, string>();
  for (const alias of field.split(";").map((part) => part.trim().replace(/\s+/g, " "))) {
    if (alias !== "" && !kept.has(itemKey(alias))) kept.set(itemKey(alias), alias);
  }
  return [...kept.values()];
}

export type Fate = "NEW" | "UPDATE" | "UNCHANGED";
export type Preview = { readonly rows: readonly (CatalogueRow & { readonly fate: Fate })[]; readonly errors: readonly RowError[] };

/** preview validates an import and says what each row would do, without writing anything. */
export async function preview(pool: pg.Pool, workspaceId: string, csv: string): Promise<Preview> {
  const parsed = parseCatalogue(csv);
  if (parsed.errors.length > 0) return { rows: [], errors: parsed.errors };
  const existing = await pool.query<{ normalized_sku: string; name: string; bin: string | null; route_rank: number; aliases: string[] }>(
    `select p.normalized_sku, p.name, p.bin, p.route_rank,
            coalesce(array_agg(a.alias order by a.normalized_alias) filter (where a.alias is not null), '{}') as aliases
     from products p left join product_aliases a on a.product_id = p.id
     where p.workspace_id = $1 and p.normalized_sku = any($2)
     group by p.id`,
    [workspaceId, parsed.rows.map((row) => row.sku)],
  );
  const bySku = new Map(existing.rows.map((product) => [product.normalized_sku, product]));
  const sameAliases = (row: CatalogueRow, current: readonly string[]) =>
    row.aliases === null || [...row.aliases].map(itemKey).sort().join(";") === current.map(itemKey).sort().join(";");
  return {
    errors: [],
    rows: parsed.rows.map((row) => {
      const current = bySku.get(row.sku);
      const isSame = current && current.name === row.name && current.bin === row.bin && current.route_rank === row.routeRank && sameAliases(row, current.aliases);
      const fate: Fate = !current ? "NEW" : isSame ? "UNCHANGED" : "UPDATE";
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
      const written = await client.query<{ id: string }>(
        `insert into products (workspace_id, sku, normalized_sku, name, bin, route_rank) values ($1, $2, $2, $3, $4, $5)
         on conflict (workspace_id, normalized_sku) do update set name = excluded.name, bin = excluded.bin, route_rank = excluded.route_rank, is_active = true, updated_at = now()
         returning id`,
        [workspaceId, row.sku, row.name, row.bin, row.routeRank],
      );
      if (row.aliases === null) continue;
      const productId = written.rows[0]!.id;
      await client.query("delete from product_aliases where product_id = $1", [productId]);
      await client.query(
        `insert into product_aliases (workspace_id, product_id, alias, normalized_alias)
         select $1, $2, alias, normalized from unnest($3::text[], $4::text[]) as given (alias, normalized)`,
        [workspaceId, productId, row.aliases, row.aliases.map(itemKey)],
      );
    }
  });
  const count = (fate: Fate) => checked.rows.filter((row) => row.fate === fate).length;
  return { ok: true, added: count("NEW"), updated: count("UPDATE"), unchanged: count("UNCHANGED") };
}

export type Product = { readonly sku: string; readonly name: string; readonly bin: string | null; readonly routeRank: number; readonly aliases: readonly string[] };

/** products lists the active catalogue in walking order. */
export async function products(pool: pg.Pool, workspaceId: string): Promise<Product[]> {
  const { rows } = await pool.query<{ sku: string; name: string; bin: string | null; route_rank: number; aliases: string[] }>(
    `select p.sku, p.name, p.bin, p.route_rank,
            coalesce(array_agg(a.alias order by a.alias) filter (where a.alias is not null), '{}') as aliases
     from products p left join product_aliases a on a.product_id = p.id
     where p.workspace_id = $1 and p.is_active
     group by p.id
     order by p.route_rank, p.bin nulls last, p.sku limit 5000`,
    [workspaceId],
  );
  return rows.map((row) => ({ sku: row.sku, name: row.name, bin: row.bin, routeRank: row.route_rank, aliases: row.aliases }));
}

/** Match is what one typed order item names in the catalogue. */
export type Match = { readonly kind: "MATCHED"; readonly sku: string } | { readonly kind: "UNKNOWN" } | { readonly kind: "AMBIGUOUS"; readonly skus: readonly string[] };

/**
 * matchItems finds the product each typed item names. An exact SKU always
 * wins; otherwise an alias held by exactly one active product matches it.
 * An alias held by several is ambiguous, and nothing is ever matched by
 * similarity: a near miss is unknown, for a person to fix.
 */
export async function matchItems(client: pg.ClientBase | pg.Pool, workspaceId: string, items: readonly string[]): Promise<Match[]> {
  const skuOf = (item: string) => item.normalize("NFKC").toUpperCase().trim();
  const { rows } = await client.query<{ key: string; sku: string; via: "SKU" | "ALIAS" }>(
    `select p.normalized_sku as key, p.sku, 'SKU' as via from products p
     where p.workspace_id = $1 and p.is_active and p.normalized_sku = any($2)
     union all
     select a.normalized_alias, p.sku, 'ALIAS' from product_aliases a join products p on p.id = a.product_id
     where a.workspace_id = $1 and p.is_active and a.normalized_alias = any($3)`,
    [workspaceId, items.map(skuOf), items.map(itemKey)],
  );
  return items.map((item): Match => {
    const exact = rows.find((row) => row.via === "SKU" && row.key === skuOf(item));
    if (exact) return { kind: "MATCHED", sku: exact.sku };
    const named = rows.filter((row) => row.via === "ALIAS" && row.key === itemKey(item)).map((row) => row.sku).sort();
    if (named.length === 1) return { kind: "MATCHED", sku: named[0]! };
    return named.length === 0 ? { kind: "UNKNOWN" } : { kind: "AMBIGUOUS", skus: named };
  });
}

/**
 * catalogueCsv is the active catalogue in the same columns import reads, so an
 * owner can edit it in a spreadsheet and import it back.
 */
export async function catalogueCsv(pool: pg.Pool, workspaceId: string): Promise<string> {
  const listed = await products(pool, workspaceId);
  return writeCsv([columns, ...listed.map((product) => [product.sku, product.name, product.bin ?? "", product.routeRank, product.aliases.join("; ")])]);
}
