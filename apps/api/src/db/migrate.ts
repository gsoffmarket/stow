// Forward-only SQL migrations. Each file in db/migrations runs once, in name
// order, inside its own transaction, and is recorded in schema_migrations.
// An advisory lock keeps two deploys from migrating at the same time.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

/** migrationsDir is the repository's db/migrations folder. */
export const migrationsDir = join(import.meta.dirname, "../../../../db/migrations");

const lockKey = 4_242_001;

/** migrate applies every pending migration and returns the names it applied. */
export async function migrate(client: pg.ClientBase, dir = migrationsDir): Promise<string[]> {
  const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  await client.query("select pg_advisory_lock($1)", [lockKey]);
  try {
    await client.query(
      "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    const { rows } = await client.query<{ name: string }>("select name from schema_migrations");
    const done = new Set(rows.map((row) => row.name));
    const applied: string[] = [];
    for (const name of files.filter((file) => !done.has(file))) {
      const sql = await readFile(join(dir, name), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [name]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw new Error(`migration ${name}: ${(error as Error).message}`, { cause: error });
      }
      applied.push(name);
    }
    return applied;
  } finally {
    await client.query("select pg_advisory_unlock($1)", [lockKey]);
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("set DATABASE_MIGRATION_URL or DATABASE_URL to run migrations");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const applied = await migrate(client);
    console.log(JSON.stringify({ msg: "migrations applied", applied }));
  } finally {
    await client.end();
  }
}
