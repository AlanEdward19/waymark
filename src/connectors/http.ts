export interface FetchJsonOptions extends RequestInit {
  retries?: number;
  fetchImpl?: typeof fetch;
}

const MAX_WAIT_S = 60;

export function retryAfterSeconds(header: string | null): number {
  if (header === null || header.trim() === '') return 5;
  const n = Number(header);
  if (Number.isFinite(n)) return Math.max(0, n);
  const at = Date.parse(header);
  return Number.isNaN(at) ? 5 : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

export interface RetryOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  /** Error to throw instead of waiting when Retry-After is over the cap. */
  giveUp?: (res: Response, waitS: number) => Error;
}

/** Fetch with a per-attempt timeout; retries 429/503 honouring Retry-After (capped). */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: RetryOptions = {},
): Promise<Response> {
  const { fetchImpl = fetch, timeoutMs = 60_000, retries = 3, giveUp } = opts;
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if ((res.status === 429 || res.status === 503) && attempt < retries) {
      const wait = retryAfterSeconds(res.headers.get('retry-after'));
      if (wait > MAX_WAIT_S && giveUp) {
        await res.body?.cancel();
        throw giveUp(res, wait);
      }
      if (wait <= MAX_WAIT_S) {
        await res.body?.cancel();
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
    }
    return res;
  }
}

/** Errors carry host and status only: never headers, tokens or bodies. */
export async function fetchJson<T>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const { retries = 3, fetchImpl = fetch, ...init } = opts;
  const host = new URL(url).host;
  const res = await fetchWithRetry(url, init, {
    fetchImpl,
    retries,
    giveUp: (_r, wait) => new Error(`Rate limited by ${host}; retry after ${wait}s`),
  });
  if (!res.ok) throw new Error(`${host} responded ${res.status} ${res.statusText}`);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function envToken(sourceId: string, names: string[], tip: string): string {
  for (const name of names) {
    const v = process.env[name];
    if (v) return v;
  }
  throw new Error(`Source "${sourceId}": set ${names.join(' or ')} to sync. ${tip}`);
}
