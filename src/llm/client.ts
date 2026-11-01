import type { Config } from '../config.js';
import { retryAfterSeconds } from '../connectors/http.js';

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

const RETRIES = 3;
const MAX_WAIT_S = 60;

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
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetchImpl(endpoint, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'TimeoutError') {
          throw new Error(`LLM request timed out after ${cfg.timeoutMs} ms`);
        }
        throw new Error(`LLM request failed: network error from ${host}`);
      }
      if ((res.status === 429 || res.status === 503) && attempt < RETRIES) {
        const wait = retryAfterSeconds(res.headers.get('retry-after'));
        if (wait <= MAX_WAIT_S) {
          await new Promise((r) => setTimeout(r, wait * 1000));
          continue;
        }
      }
      if (!res.ok)
        throw new Error(`LLM request failed: ${res.status} ${res.statusText} from ${host}`);
      let content: unknown;
      try {
        const json = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
        content = json?.choices?.[0]?.message?.content;
      } catch {
        // falls through to malformed
      }
      if (typeof content !== 'string') throw new Error('LLM response malformed');
      return content.trim();
    }
  };
}
