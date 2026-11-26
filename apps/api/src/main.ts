// Process entry point: validate config, connect to Postgres, serve HTTP, and
// run the Telegram loop when a bot is configured.

import pg from "pg";
import { createBotApi } from "@stow/telegram/botapi";
import { loadConfig } from "./config.ts";
import { buildHttp } from "./http.ts";
import { runTelegram } from "./telegram.ts";

const config = loadConfig(process.env);
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10, connectionTimeoutMillis: 5_000 });
const app = buildHttp({
  pool,
  taskTokenSecret: config.TASK_TOKEN_SECRET,
  botToken: config.TELEGRAM_BOT_TOKEN ?? null,
  now: () => new Date(),
  corsAllowedOrigins: config.CORS_ALLOWED_ORIGINS,
  logger: true,
});
const stop = new AbortController();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    stop.abort();
    await app.close();
    await pool.end();
  });
}

await app.listen({ host: "0.0.0.0", port: config.PORT });

if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_BOT_USERNAME) {
  const api = createBotApi(config.TELEGRAM_BOT_TOKEN);
  const me = await api.getMe();
  if (me.kind !== "ok") throw new Error(`telegram getMe: ${me.kind}; check TELEGRAM_BOT_TOKEN`);
  if (me.value.username.toLowerCase() !== config.TELEGRAM_BOT_USERNAME.toLowerCase()) {
    throw new Error(`TELEGRAM_BOT_USERNAME is ${config.TELEGRAM_BOT_USERNAME} but the token belongs to ${me.value.username}`);
  }
  const telegram = { pool, api, botAlias: me.value.username.toLowerCase(), botUsername: me.value.username };
  app.log.info({ bot: me.value.username }, "telegram polling started");
  void runTelegram(telegram, stop.signal, (msg, data) => app.log.warn(data ?? {}, msg));
} else {
  app.log.info("telegram disabled: TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_USERNAME not set");
}
