export interface TokenProvider {
  getToken(): Promise<string>;
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Caches a token until 5 minutes before `expiresAt` (epoch ms). Concurrent callers share one fetch. */
export function cachedToken(
  fetchToken: () => Promise<{ token: string; expiresAt: number }>,
  now: () => number = Date.now,
): TokenProvider {
  let cached: { token: string; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;
  return {
    async getToken() {
      if (cached !== undefined && now() < cached.expiresAt - REFRESH_MARGIN_MS) return cached.token;
      inflight ??= fetchToken()
        .then((t) => {
          cached = t;
          return t.token;
        })
        .finally(() => {
          inflight = undefined;
        });
      return inflight;
    },
  };
}
