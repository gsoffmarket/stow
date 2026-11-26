// Process entry point: validate config, connect to Postgres, serve HTTP.

import pg from "pg";
import { loadConfig } from "./config.ts";
import { buildHttp } from "./http.ts";

const config = loadConfig(process.env);
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10, connectionTimeoutMillis: 5_000 });
const app = buildHttp({ pool, taskTokenSecret: config.TASK_TOKEN_SECRET, corsAllowedOrigins: config.CORS_ALLOWED_ORIGINS, logger: true });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await app.close();
    await pool.end();
  });
}

await app.listen({ host: "0.0.0.0", port: config.PORT });
