// Per-key token buckets for the API's rate limits (PRD §15.3). Stow runs as
// one process, so the buckets live in memory; a restart resets them, which
// only ever errs on the side of letting a request through.
//
// A bucket holds up to `burst` tokens and refills at `perMinute` tokens a
// minute. Each request takes one; an empty bucket answers with how long
// until the next token.

/** Limit is a bucket's size and refill rate. */
export type Limit = { readonly perMinute: number; readonly burst: number };

export const limits = {
  pairingStart: { perMinute: 5, burst: 5 },
  pairingApprove: { perMinute: 10, burst: 5 },
  signIn: { perMinute: 10, burst: 10 },
  commands: { perMinute: 60, burst: 10 },
  reads: { perMinute: 120, burst: 30 },
  replies: { perMinute: 30, burst: 10 },
} satisfies Record<string, Limit>;

// Keeps memory bounded: when the table is this large, full buckets (keys
// that have gone quiet) are dropped before a new one is added.
const maxKeys = 50_000;

type Bucket = { tokens: number; at_ms: number };

/** Limiter decides whether a key may make another request now. */
export class Limiter {
  #buckets = new Map<string, Bucket>();
  #now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
  }

  /** take spends one token for key, or returns the seconds to wait. */
  take(key: string, limit: Limit): { ok: true } | { ok: false; retryAfter_s: number } {
    const now_ms = this.#now();
    const bucket = this.#buckets.get(key) ?? this.#add(key, limit, now_ms);
    const refill = ((now_ms - bucket.at_ms) / 60_000) * limit.perMinute;
    bucket.tokens = Math.min(limit.burst, bucket.tokens + refill);
    bucket.at_ms = now_ms;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryAfter_s: Math.ceil(((1 - bucket.tokens) / limit.perMinute) * 60) };
  }

  #add(key: string, limit: Limit, now_ms: number): Bucket {
    if (this.#buckets.size >= maxKeys) {
      for (const [old, bucket] of this.#buckets) {
        if (bucket.tokens >= limit.burst || now_ms - bucket.at_ms > 600_000) this.#buckets.delete(old);
      }
    }
    const bucket = { tokens: limit.burst, at_ms: now_ms };
    this.#buckets.set(key, bucket);
    return bucket;
  }
}
