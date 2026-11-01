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
    const config = {
      version: 1 as const,
      sources: [],
      llm: { ...cfg, url: 'https://llm.test/v1' },
    };
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

  it('retries 503 then succeeds', async () => {
    const f = fake(
      new Response('', { status: 503, headers: { 'retry-after': '0' } }),
      reply('done'),
    );
    expect(await createLlm(cfg, f.impl)(msgs)).toBe('done');
    expect(f.calls).toHaveLength(2);
  });

  it('passes timeoutMs to the request signal', async () => {
    const hang = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    ) as unknown as typeof fetch;
    await expect(createLlm({ ...cfg, timeoutMs: 20 }, hang)(msgs)).rejects.toThrow(
      'LLM request timed out after 20 ms',
    );
  });

  it('throws the exact errors and never leaks the key or bodies', async () => {
    const key = 'sk-secret';
    const keyed = { ...cfg, url: 'https://llm.test/v1', apiKey: key };
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

describe('createLlm hardening', () => {
  const ok = () => reply('ok');
  const always429 = (ra: string) => {
    const f = fake();
    f.impl = vi.fn(async () => {
      f.calls.push({ url: '', init: {}, body: {} });
      return new Response('', {
        status: 429,
        statusText: 'Too Many',
        headers: { 'retry-after': ra },
      });
    }) as unknown as typeof fetch;
    return f;
  };

  it('gives up after 4 calls of 429 with retry-after 0', async () => {
    const f = always429('0');
    await expect(createLlm(cfg, f.impl)(msgs)).rejects.toThrow(
      'LLM request failed: 429 Too Many from llm.test',
    );
    expect(f.calls).toHaveLength(4);
  });

  it('does not wait when retry-after is over the cap', async () => {
    const f = always429('120');
    await expect(createLlm(cfg, f.impl)(msgs)).rejects.toThrow(
      'LLM request failed: 429 Too Many from llm.test',
    );
    expect(f.calls).toHaveLength(1);
  });

  it('refuses a key over remote http, allows localhost http and keyless remote http', () => {
    const msg =
      'LLM url must be https when WAYMARK_LLM_API_KEY is set (http is allowed only for localhost)';
    const key = { apiKey: 'k' };
    expect(() => createLlm({ ...cfg, ...key, url: 'http://remote.test/v1' })).toThrow(msg);
    expect(() => createLlm({ ...cfg, ...key, url: 'http://localhost:11434/v1' })).not.toThrow();
    expect(() => createLlm({ ...cfg, ...key, url: 'http://127.0.0.1:1/v1' })).not.toThrow();
    expect(() => createLlm({ ...cfg, ...key, url: 'http://[::1]:1/v1' })).not.toThrow();
    expect(() => createLlm({ ...cfg, url: 'http://remote.test/v1' })).not.toThrow();
    expect(() => createLlm({ ...cfg, ...key, url: 'https://remote.test/v1' })).not.toThrow();
  });

  it('rejects a response over 1 MB (declared or actual)', async () => {
    const big = 'x'.repeat(1_000_001);
    const declared = new Response('{}', { headers: { 'content-length': '2000000' } });
    const actual = new Response(JSON.stringify({ choices: [{ message: { content: big } }] }));
    for (const r of [declared, actual]) {
      await expect(createLlm(cfg, fake(r).impl)(msgs)).rejects.toThrow('LLM response malformed');
    }
  });

  it('sends redirect: error', async () => {
    const f = fake(ok());
    await createLlm(cfg, f.impl)(msgs);
    expect(f.calls[0]?.init.redirect).toBe('error');
  });

  it('per-call temperature beats the configured one', async () => {
    const f = fake(ok());
    await createLlm({ ...cfg, temperature: 0.2 }, f.impl)(msgs, { temperature: 0 });
    expect(f.calls[0]?.body.temperature).toBe(0);
  });

  it('empty WAYMARK_LLM_API_KEY sends no Authorization header', async () => {
    const config = {
      version: 1 as const,
      sources: [],
      people: [],
      llm: { ...cfg, url: 'http://llm.test/v1' },
    };
    const c = llmConfigFrom(config, { WAYMARK_LLM_API_KEY: '' }) as LlmConfig;
    const f = fake(ok());
    await createLlm(c, f.impl)(msgs);
    expect(f.calls[0]?.init.headers).not.toHaveProperty('authorization');
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
  it('truncates a long reply to 40 chars', async () => {
    await fs.writeFile(
      path.join(tmp, 'config.json'),
      JSON.stringify({ version: 1, sources: [], llm: { url: 'http://llm.test/v1', model: 'm1' } }),
    );
    vi.stubGlobal('fetch', fake(reply('y'.repeat(60))).impl);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await main(['llm', 'test'])).toBe(0);
    expect(out.mock.calls.map((c) => String(c[0])).join('')).toContain(
      `replied "${'y'.repeat(40)}" in`,
    );
  });

  it('strips control characters from the reply', async () => {
    await fs.writeFile(
      path.join(tmp, 'config.json'),
      JSON.stringify({ version: 1, sources: [], llm: { url: 'http://llm.test/v1', model: 'm1' } }),
    );
    vi.stubGlobal('fetch', fake(reply('\u001b[31mOK\u0007')).impl);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await main(['llm', 'test'])).toBe(0);
    expect(out.mock.calls.map((c) => String(c[0])).join('')).toContain('replied "[31mOK" in');
  });

  it('prints the usage error without a subcommand', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await main(['llm'])).toBe(1);
    expect(err.mock.calls.map((c) => String(c[0])).join('')).toBe(
      'error: usage: waymark llm test\n',
    );
  });
});
