export interface FetchJsonOptions extends RequestInit {
  retries?: number;
  fetchImpl?: typeof fetch;
}

const MAX_WAIT_S = 60;

function retryAfterSeconds(header: string | null): number {
  if (header === null || header.trim() === '') return 5;
  const n = Number(header);
  if (Number.isFinite(n)) return Math.max(0, n);
  const at = Date.parse(header);
  return Number.isNaN(at) ? 5 : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/** Errors carry host and status only: never headers, tokens or bodies. */
export async function fetchJson<T>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const { retries = 3, fetchImpl = fetch, ...init } = opts;
  const host = new URL(url).host;
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(60_000) });
    if ((res.status === 429 || res.status === 503) && attempt < retries) {
      const wait = retryAfterSeconds(res.headers.get('retry-after'));
      if (wait > MAX_WAIT_S) throw new Error(`Rate limited by ${host}; retry after ${wait}s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`${host} responded ${res.status} ${res.statusText}`);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}

export function envToken(sourceId: string, names: string[], tip: string): string {
  for (const name of names) {
    const v = process.env[name];
    if (v) return v;
  }
  throw new Error(`Source "${sourceId}": set ${names.join(' or ')} to sync. ${tip}`);
}
