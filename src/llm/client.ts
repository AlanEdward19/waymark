import type { Config } from '../config.js';
import { fetchWithRetry } from '../connectors/http.js';

export interface LlmConfig {
  url: string;
  model: string;
  maxTokens: number;
  temperature?: number;
  timeoutMs: number;
  apiKey?: string;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmOptions {
  maxTokens?: number;
  temperature?: number;
  /** Ask for a JSON object (`response_format: json_object`). */
  json?: boolean;
}

export type Llm = (messages: LlmMessage[], opts?: LlmOptions) => Promise<string>;

const MAX_RESPONSE_BYTES = 1_000_000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Response text, or null when it is over the cap (a hostile endpoint must not fill memory). */
async function readCapped(res: Response): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) return null;
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** LLM settings from config (+ optional `WAYMARK_LLM_API_KEY`), or null when off. */
export function llmConfigFrom(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): LlmConfig | null {
  if (!config.llm) return null;
  const key = env.WAYMARK_LLM_API_KEY;
  return { ...config.llm, ...(key ? { apiKey: key } : {}) };
}

/** Client for any OpenAI-compatible `POST <url>/chat/completions` (OpenAI, Ollama, gateways). */
export function createLlm(cfg: LlmConfig, fetchImpl: typeof fetch = fetch): Llm {
  const endpoint = `${cfg.url.replace(/\/+$/, '')}/chat/completions`;
  const host = new URL(endpoint).host;
  const { protocol, hostname } = new URL(endpoint);
  if (cfg.apiKey && protocol === 'http:' && !LOCAL_HOSTS.has(hostname)) {
    throw new Error(
      'LLM url must be https when WAYMARK_LLM_API_KEY is set (http is allowed only for localhost)',
    );
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

  return async (messages, opts = {}) => {
    const temperature = opts.temperature ?? cfg.temperature;
    const body = JSON.stringify({
      model: cfg.model,
      messages,
      max_tokens: opts.maxTokens ?? cfg.maxTokens,
      ...(temperature === undefined ? {} : { temperature }),
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    });
    // errors never include the key, the request body or the response body: they end up in logs
    let res: Response;
    try {
      res = await fetchWithRetry(
        endpoint,
        { method: 'POST', headers, body, redirect: 'error' },
        {
          fetchImpl,
          timeoutMs: cfg.timeoutMs,
          giveUp: (r) => new Error(`LLM request failed: ${r.status} ${r.statusText} from ${host}`),
        },
      );
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('LLM request failed')) throw err;
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error(`LLM request timed out after ${cfg.timeoutMs} ms`);
      }
      throw new Error(`LLM request failed: network error from ${host}`);
    }
    if (!res.ok)
      throw new Error(`LLM request failed: ${res.status} ${res.statusText} from ${host}`);
    let content: unknown;
    try {
      const text = await readCapped(res);
      const json = JSON.parse(text ?? '') as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      content = json?.choices?.[0]?.message?.content;
    } catch {
      // falls through to malformed
    }
    if (typeof content !== 'string') throw new Error('LLM response malformed');
    return content.trim();
  };
}
