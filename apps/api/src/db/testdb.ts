// Integration tests run against real Postgres. Each test file gets its own
// freshly migrated database so files can run in parallel without sharing rows.

import { randomBytes } from "node:crypto";
import pg from "pg";
import { migrate } from "./migrate.ts";

const adminUrl = process.env.TEST_DATABASE_URL ?? "postgres://stow:stow@localhost:54329/stow";

/** TestDatabase is a migrated, throwaway database and a pool connected to it. */
export type TestDatabase = { readonly pool: pg.Pool; readonly url: string; drop(): Promise<void> };

/** createTestDatabase makes and migrates a database that drop() removes again. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `stow_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 5 });
  const client = await pool.connect();
  try {
    await migrate(client);
  } finally {
    client.release();
  }

  return {
    pool,
    url: url.toString(),
    async drop() {
      await pool.end();
      const cleanup = new pg.Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query(`drop database ${name} with (force)`);
      await cleanup.end();
    },
  };
}
