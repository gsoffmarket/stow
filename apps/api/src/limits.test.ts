import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "./db/testdb.ts";
import { buildHttp } from "./http.ts";
import { Limiter } from "./limits.ts";

describe("Limiter", () => {
  test("allows a burst, then refills at the per-minute rate", () => {
    let now_ms = 0;
    const limiter = new Limiter(() => now_ms);
    const limit = { perMinute: 6, burst: 2 };
    expect(limiter.take("k", limit)).toEqual({ ok: true });
    expect(limiter.take("k", limit)).toEqual({ ok: true });
    expect(limiter.take("k", limit)).toEqual({ ok: false, retryAfter_s: 10 });
    now_ms += 10_000;
    expect(limiter.take("k", limit)).toEqual({ ok: true });
  });

  test("keys are independent", () => {
    const limiter = new Limiter(() => 0);
    const limit = { perMinute: 1, burst: 1 };
    expect(limiter.take("a", limit).ok).toBe(true);
    expect(limiter.take("a", limit).ok).toBe(false);
    expect(limiter.take("b", limit).ok).toBe(true);
  });
});

describe("rate limits over HTTP", () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  beforeAll(async () => {
    db = await createTestDatabase();
    app = buildHttp({ pool: db.pool, taskTokenSecret: "x".repeat(32), botToken: null, now: () => new Date(), corsAllowedOrigins: [], logger: false });
  });
  afterAll(async () => {
    await app.close();
    await db.drop();
  });

  test("a sixth pairing request in a minute from one address gets 429 with Retry-After", async () => {
    const start = () => app.inject({ method: "POST", url: "/v1/devices/pairings", payload: { label: "G2" } });
    for (let i = 0; i < 5; i++) expect((await start()).statusCode).toBe(200);
    const limited = await start();
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(limited.json().error).toMatchObject({ code: "RATE_LIMITED", retryable: true });
  });
});
