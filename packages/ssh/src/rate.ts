export interface Rate {
	readonly burst: number;
	readonly perSecond: number;
}

const PRUNE_AT = 1024;

export interface TokenBuckets {
	readonly has: (key: string, now: number) => boolean;
	readonly take: (key: string, now: number) => boolean;
}

export const tokenBuckets = (rate: Rate): TokenBuckets => {
	const buckets = new Map<string, { tokens: number; at: number }>();

	const refill = (bucket: { tokens: number; at: number }, now: number) => {
		bucket.tokens = Math.min(
			rate.burst,
			bucket.tokens + (Math.max(0, now - bucket.at) / 1000) * rate.perSecond
		);
		bucket.at = now;
	};

	const bucketOf = (key: string, now: number) => {
		if (buckets.size > PRUNE_AT) {
			for (const [k, b] of buckets) {
				refill(b, now);

				if (b.tokens >= rate.burst) {
					buckets.delete(k);
				}
			}
		}

		let bucket = buckets.get(key);

		if (!bucket) {
			buckets.set(key, (bucket = { tokens: rate.burst, at: now }));
		}

		refill(bucket, now);

		return bucket;
	};

	return {
		has: (key, now) => bucketOf(key, now).tokens >= 1,
		take: (key, now) => {
			const bucket = bucketOf(key, now);

			if (bucket.tokens < 1) {
				return false;
			}

			bucket.tokens -= 1;

			return true;
		},
	};
};

export const rateLimiter = (
	rate: Rate
): ((key: string, now: number) => boolean) => tokenBuckets(rate).take;
