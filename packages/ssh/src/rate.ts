/** How fast one sender may go: `burst` at once, then `perSecond` on average. */
export interface Rate {
  readonly burst: number;
  readonly perSecond: number;
}

/** Past this many senders, ones that have caught up are forgotten. */
const PRUNE_AT = 1024;

/** Token buckets, one per key, that can be looked at without spending. */
export interface TokenBuckets {
  /** Whether `key` has a token now, spending nothing. */
  readonly has: (key: string, now: number) => boolean;
  /** Spends one of `key`'s tokens, or says no when it has none left. */
  readonly take: (key: string, now: number) => boolean;
}

/** Token buckets, one per key. Pure over the clock it's handed, so the caller owns time. */
export function tokenBuckets(rate: Rate): TokenBuckets {
  const buckets = new Map<string, { tokens: number; at: number }>();
  const refill = (bucket: { tokens: number; at: number }, now: number) => {
    bucket.tokens = Math.min(
      rate.burst,
      bucket.tokens + ((now - bucket.at) / 1000) * rate.perSecond,
    );
    bucket.at = now;
  };
  const bucketOf = (key: string, now: number) => {
    if (buckets.size > PRUNE_AT) {
      for (const [k, b] of buckets) {
        refill(b, now);
        if (b.tokens >= rate.burst) buckets.delete(k);
      }
    }
    let bucket = buckets.get(key);
    if (!bucket) buckets.set(key, (bucket = { tokens: rate.burst, at: now }));
    refill(bucket, now);
    return bucket;
  };
  return {
    has: (key, now) => bucketOf(key, now).tokens >= 1,
    take: (key, now) => {
      const bucket = bucketOf(key, now);
      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    },
  };
}

/**
 * Token buckets, one per key. `take(key, now)` spends one token, or says no when the key has
 * none left. Pure over the clock it's handed, so the caller owns time.
 */
export const rateLimiter = (rate: Rate): ((key: string, now: number) => boolean) =>
  tokenBuckets(rate).take;
