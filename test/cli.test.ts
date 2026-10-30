import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';

function capture() {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const text = (spy: typeof stdout) => spy.mock.calls.map((c) => String(c[0])).join('');
  return { out: () => text(stdout), err: () => text(stderr) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('main', () => {
  it.each([['--version'], ['-v']])('%s prints the version', async (flag) => {
    const io = capture();
    expect(await main([flag])).toBe(0);
    expect(io.out()).toBe('0.0.0\n');
    expect(io.err()).toBe('');
  });

  it.each([['--help'], ['-h'], []])('%s prints usage', async (...args: string[]) => {
    const io = capture();
    expect(await main(args)).toBe(0);
    expect(io.out()).toContain('Usage: waymark');
    expect(io.err()).toBe('');
  });

  it('rejects an unknown command', async () => {
    const io = capture();
    expect(await main(['foo'])).toBe(1);
    expect(io.out()).toBe('');
    expect(io.err()).toBe('error: unknown command "foo"\n');
  });
});
