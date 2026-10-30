import { describe, expect, it } from 'vitest';
import { type SessionMeta, sessionDoc } from '../src/agents/session.js';

const meta: SessionMeta = { harness: 'claude-code', sessionId: 's-1', cwd: '/work/my-proj' };
const now = new Date('2026-10-30T00:00:00.000Z');

describe('sessionDoc', () => {
  it('returns null without user turns', () => {
    expect(sessionDoc(meta, [{ role: 'assistant', text: 'hi' }], now)).toBeNull();
  });

  it('maps fields and truncates the title', () => {
    const turns = [
      { role: 'user' as const, text: 'Fix the login bug', timestamp: '2026-10-01T10:00:00.000Z' },
      { role: 'assistant' as const, text: 'On it.', timestamp: '2026-10-01T10:05:00.000Z' },
    ];
    const doc = sessionDoc(meta, turns, now);
    expect(doc?.id).toBe('agent/session/s-1');
    expect(doc?.tags).toEqual(['harness:claude-code', 'project:my-proj']);
    expect(doc?.createdAt).toBe('2026-10-01T10:00:00.000Z');
    expect(doc?.updatedAt).toBe('2026-10-01T10:05:00.000Z');
    expect(doc?.body).toMatch(/^Claude Code session `s-1` in `\/work\/my-proj`\n\n## Transcript/);
    const long = sessionDoc(meta, [{ role: 'user', text: `${'a'.repeat(100)}\nrest` }], now);
    expect(long?.title).toBe(`${'a'.repeat(80)}…`);
    expect(sessionDoc(meta, [{ role: 'user', text: 'x' }], now)?.createdAt).toBe(now.toISOString());
  });

  it('labels other harnesses', () => {
    const doc = sessionDoc({ ...meta, harness: 'cursor' }, [{ role: 'user', text: 'x' }], now);
    expect(doc?.tags).toContain('harness:cursor');
    expect(doc?.body.startsWith('Cursor session `s-1`')).toBe(true);
  });

  it('caps the transcript keeping the newest turns', () => {
    const turns = Array.from({ length: 5 }, (_, i) => ({
      role: 'user' as const,
      text: `${i}`.repeat(60_000),
    }));
    const body = sessionDoc(meta, turns, now)?.body ?? '';
    expect(body).toContain('_[earlier turns omitted]_');
    expect(body).toContain('4'.repeat(60_000));
    expect(body).not.toContain('0'.repeat(60_000));
    expect(body.length).toBeLessThan(210_000);
  });
});
