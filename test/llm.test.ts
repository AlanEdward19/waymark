import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { createLlm, type LlmConfig, llmConfigFrom } from '../src/llm/client.js';

const cfg: LlmConfig = {
  url: 'http://llm.test/v1/',
  model: 'm1',
  maxTokens: 800,
  timeoutMs: 5000,
};
const msgs = [{ role: 'user' as const, content: 'hi' }];

function reply(content: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), init);
}
function fake(...responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body)) });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return r ?? reply('ok');
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('createLlm', () => {
  it('sends model, messages, max_tokens; no temperature, key or response_format by default', async () => {
    const f = fake(reply('  hello \n'));
    expect(await createLlm(cfg, f.impl)(msgs)).toBe('hello');
    expect(f.calls[0]?.url).toBe('http://llm.test/v1/chat/completions');
    expect(f.calls[0]?.body).toEqual({ model: 'm1', messages: msgs, max_tokens: 800 });
    expect(f.calls[0]?.init.headers).not.toHaveProperty('authorization');
  });

  it('adds temperature when configured or overridden, and response_format for json', async () => {
    const f = fake();
    await createLlm({ ...cfg, temperature: 0.2 }, f.impl)(msgs);
    await createLlm(cfg, f.impl)(msgs, { temperature: 1, maxTokens: 5, json: true });
    expect(f.calls[0]?.body.temperature).toBe(0.2);
    expect(f.calls[1]?.body).toMatchObject({
      temperature: 1,
      max_tokens: 5,
      response_format: { type: 'json_object' },
    });
  });

  it('sends the Bearer header only when the env var is set', async () => {
    const config = { version: 1 as const, sources: [], llm: { ...cfg, url: 'http://llm.test/v1' } };
    expect(llmConfigFrom(config, {})?.apiKey).toBeUndefined();
    const withKey = llmConfigFrom(config, { WAYMARK_LLM_API_KEY: 'sk-secret' });
    const f = fake();
    await createLlm(withKey as LlmConfig, f.impl)(msgs);
    expect(f.calls[0]?.init.headers).toMatchObject({ authorization: 'Bearer sk-secret' });
  });

  it('returns null config when llm is absent', () => {
    expect(llmConfigFrom({ version: 1, sources: [] })).toBeNull();
  });

  it('retries 429 then succeeds', async () => {
    const f = fake(
      new Response('', { status: 429, headers: { 'retry-after': '0' } }),
      reply('done'),
    );
    expect(await createLlm(cfg, f.impl)(msgs)).toBe('done');
    expect(f.calls).toHaveLength(2);
  });

  it('throws the exact errors and never leaks the key or bodies', async () => {
    const key = 'sk-secret';
    const keyed = { ...cfg, apiKey: key };
    const errors: string[] = [];
    const run = async (...r: Array<Response | Error>) => {
      try {
        await createLlm(keyed, fake(...r).impl)(msgs);
      } catch (err) {
        errors.push((err as Error).message);
      }
    };
    await run(new Response(`body with ${key}`, { status: 500, statusText: 'Server Error' }));
    await run(reply(42));
    await run(new Response('not json'));
    await run(new DOMException('t', 'TimeoutError') as unknown as Error);
    await run(new Error(`connect failed ${key}`));
    expect(errors).toEqual([
      'LLM request failed: 500 Server Error from llm.test',
      'LLM response malformed',
      'LLM response malformed',
      'LLM request timed out after 5000 ms',
      'LLM request failed: network error from llm.test',
    ]);
    expect(errors.join()).not.toContain(key);
  });
});

describe('waymark llm test', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
    vi.stubEnv('WAYMARK_HOME', tmp);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await main(['init']);
    vi.restoreAllMocks();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('errors when llm is not configured', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await main(['llm', 'test'])).toBe(1);
    expect(err.mock.calls.map((c) => String(c[0])).join('')).toBe(
      'error: llm is not configured (add "llm" to config.json)\n',
    );
  });

  it('prints the success line with a fake fetch', async () => {
    await fs.writeFile(
      path.join(tmp, 'config.json'),
      JSON.stringify({
        version: 1,
        sources: [],
        llm: { url: 'http://llm.test:11434/v1', model: 'm1' },
      }),
    );
    const f = fake(reply('OK'));
    vi.stubGlobal('fetch', f.impl);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await main(['llm', 'test'])).toBe(0);
    expect(out.mock.calls.map((c) => String(c[0])).join('')).toMatch(
      /^LLM ok: m1 at llm\.test:11434 replied "OK" in \d+ ms\n$/,
    );
    expect(f.calls[0]?.body.messages).toEqual([
      { role: 'user', content: 'Reply with the single word OK.' },
    ]);
  });
});
