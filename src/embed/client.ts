import type { Config } from '../config.js';

export interface EmbedConfig {
  url: string;
  model: string;
  batchSize: number;
  apiKey?: string;
}

export type Embedder = (texts: string[]) => Promise<Float32Array[]>;

/** Embeddings settings from config (+ optional `WAYMARK_EMBED_API_KEY`), or null when off. */
export function embedConfigFrom(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): EmbedConfig | null {
  if (!config.embeddings) return null;
  const key = env.WAYMARK_EMBED_API_KEY;
  return { ...config.embeddings, ...(key ? { apiKey: key } : {}) };
}

/** Client for any OpenAI-compatible `POST <url>/embeddings` (OpenAI, Ollama, LM Studio, vLLM). */
export function createEmbedder(cfg: EmbedConfig, fetchImpl: typeof fetch = fetch): Embedder {
  const endpoint = `${cfg.url.replace(/\/+$/, '')}/embeddings`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

  return async (texts) => {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += cfg.batchSize) {
      const batch = texts.slice(i, i + cfg.batchSize);
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: cfg.model, input: batch }),
        signal: AbortSignal.timeout(60_000),
      });
      // never echo the key or the request body: errors end up in logs
      if (!res.ok) throw new Error(`Embeddings request failed: ${res.status} ${res.statusText}`);
      const json = (await res.json()) as { data?: Array<{ embedding?: unknown; index?: unknown }> };
      const data = json?.data;
      if (!Array.isArray(data) || data.length !== batch.length) {
        throw new Error('Embeddings response malformed');
      }
      const vectors: Float32Array[] = new Array(batch.length);
      for (const [pos, item] of data.entries()) {
        const idx = typeof item.index === 'number' ? item.index : pos;
        if (!Array.isArray(item.embedding) || idx < 0 || idx >= batch.length) {
          throw new Error('Embeddings response malformed');
        }
        vectors[idx] = Float32Array.from(item.embedding as number[]);
      }
      const dim = vectors[0]?.length ?? 0;
      if (dim === 0 || vectors.some((v) => !v || v.length !== dim)) {
        throw new Error('Embeddings response malformed');
      }
      out.push(...vectors);
    }
    return out;
  };
}
