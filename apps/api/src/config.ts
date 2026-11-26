// Configuration is read once from the environment at startup. Anything
// missing or malformed stops the process before it serves a request.

import { z } from "zod";

const schema = z.object({
  APP_ENV: z.enum(["local", "test", "staging", "production"]),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  DATABASE_URL: z.url(),
  TASK_TOKEN_SECRET: z.string().min(32, "TASK_TOKEN_SECRET must be at least 32 characters"),
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default("")
    .transform((value) => value.split(",").map((origin) => origin.trim()).filter((origin) => origin !== "")),
  TELEGRAM_BOT_TOKEN: z.string().regex(/^[0-9]+:[A-Za-z0-9_-]{30,}$/, "TELEGRAM_BOT_TOKEN is not a bot token").optional(),
  TELEGRAM_BOT_USERNAME: z.string().regex(/^[A-Za-z0-9_]{5,32}$/).optional(),
});

/** Config is the validated process configuration. */
export type Config = z.infer<typeof schema>;

/** loadConfig parses env, naming every invalid variable but never echoing its value. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  // `KEY=` in an env file means "not set", so empty values count as missing.
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
  const parsed = schema.safeParse(present);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  throw new Error(`invalid configuration: ${problems.join("; ")}`);
}
