import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AuthDb,
  addUser,
  createToken,
  findUserByIdentity,
  linkIdentity,
  listTokens,
  listUsers,
  openAuthDb,
  revokeToken,
  unlinkIdentity,
  updateUser,
  verifyToken,
} from '../src/auth/store.js';
import { redact } from '../src/redact.js';

let tmp: string;
let db: AuthDb;
const T0 = new Date('2026-11-01T00:00:00.000Z');
const later = (ms: number) => new Date(T0.getTime() + ms);

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'waymark-'));
  db = openAuthDb(path.join(tmp, 'auth', 'auth.db'));
});

afterEach(async () => {
  db.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('users', () => {
  it('adds, updates and lists users', () => {
    const u = addUser(db, { name: 'alice', displayName: 'Alice', groups: ['b', 'a'] }, T0);
    expect(u).toEqual({
      name: 'alice',
      displayName: 'Alice',
      role: 'member',
      groups: ['a', 'b'],
      disabled: false,
      createdAt: T0.toISOString(),
    });
    updateUser(db, 'alice', { role: 'admin', groups: ['c'], disabled: true, displayName: 'A' });
    expect(listUsers(db)).toEqual([
      {
        ...u,
        role: 'admin',
        groups: ['c'],
        disabled: true,
        displayName: 'A',
        providers: [],
        activeTokens: 0,
      },
    ]);
  });

  it('rejects bad names, bad groups, duplicates and unknown users with exact messages', () => {
    const hint =
      'lowercase letters, digits, ".", "_" and "-", 1-63 characters, starting with a letter or digit';
    expect(() => addUser(db, { name: 'Bad Name' })).toThrow(
      `invalid user name "Bad Name" (${hint})`,
    );
    expect(() => addUser(db, { name: 'x', groups: ['Nope'] })).toThrow(
      `invalid group "Nope" (${hint})`,
    );
    expect(getCount()).toBe(0);
    addUser(db, { name: 'alice' });
    expect(() => addUser(db, { name: 'alice' })).toThrow('user "alice" already exists');
    expect(() => updateUser(db, 'ghost', {})).toThrow('user not found: ghost');
  });
});

function getCount(): number {
  return listUsers(db).length;
}

describe('linked identities', () => {
  beforeEach(() => {
    addUser(db, { name: 'alice' });
    addUser(db, { name: 'bob' });
  });

  it('links, finds (github case-insensitive) and unlinks', () => {
    linkIdentity(db, 'alice', 'github', 'Alice-S');
    expect(findUserByIdentity(db, 'github', 'ALICE-s')?.name).toBe('alice');
    expect(listUsers(db)[0]?.providers).toEqual(['github']);
    unlinkIdentity(db, 'alice', 'github');
    expect(findUserByIdentity(db, 'github', 'alice-s')).toBeUndefined();
    expect(() => unlinkIdentity(db, 'alice', 'github')).toThrow(
      'user "alice" has no github identity',
    );
  });

  it('validates provider and id format per provider', () => {
    expect(() => linkIdentity(db, 'alice', 'irc', 'x')).toThrow(
      'invalid provider "irc" (valid: github, slack, teams, discord, linear, oidc)',
    );
    expect(() => linkIdentity(db, 'alice', 'slack', 'alice')).toThrow(
      'invalid slack id "alice" (expected a Slack user id like U01ABC23DEF)',
    );
    expect(() => linkIdentity(db, 'alice', 'teams', 'nope')).toThrow(
      'invalid teams id "nope" (expected an Entra object id (GUID))',
    );
    expect(() => linkIdentity(db, 'alice', 'discord', '12')).toThrow(
      'invalid discord id "12" (expected a Discord user id (17-20 digits))',
    );
    expect(() => linkIdentity(db, 'alice', 'oidc', 'no-pipe')).toThrow(
      'invalid oidc id "no-pipe" (expected <issuer>|<subject>)',
    );
    expect(() => linkIdentity(db, 'ghost', 'slack', 'U01ABC23DEF')).toThrow(
      'user not found: ghost',
    );
    linkIdentity(db, 'alice', 'teams', '123e4567-e89b-12d3-a456-426614174000');
    linkIdentity(db, 'alice', 'discord', '123456789012345678');
    linkIdentity(db, 'alice', 'oidc', 'https://idp.example.com|sub-1');
  });

  it('refuses an identity already linked to another user, naming that user', () => {
    linkIdentity(db, 'alice', 'github', 'octo');
    expect(() => linkIdentity(db, 'bob', 'github', 'OCTO')).toThrow(
      'github id "octo" is already linked to user "alice"',
    );
    linkIdentity(db, 'alice', 'github', 'octo'); // same user again is fine
  });
});

describe('tokens', () => {
  beforeEach(() => {
    addUser(db, { name: 'alice' });
  });

  it('stores only the SHA-256, never the token', async () => {
    const { token, info } = createToken(db, { user: 'alice', label: 'laptop' }, T0);
    expect(token).toMatch(/^wmk_[A-Za-z0-9_-]{43}$/);
    expect(info.id).toMatch(/^tok_[0-9a-f]{8}$/);
    const { createHash } = await import('node:crypto');
    const stored = db.prepare('SELECT hash FROM tokens').all() as { hash: string }[];
    expect(stored).toEqual([{ hash: createHash('sha256').update(token).digest('hex') }]);
    db.pragma('wal_checkpoint(TRUNCATE)');
    const file = await fs.readFile(path.join(tmp, 'auth', 'auth.db'));
    expect(file.includes(token)).toBe(false);
    expect(JSON.stringify(listTokens(db))).not.toContain(token);
    expect(JSON.stringify(listTokens(db))).not.toContain('hash');
  });

  it('verifies valid, invalid, expired, revoked and disabled', () => {
    const { token, info } = createToken(db, { user: 'alice', expiresDays: 1 }, T0);
    const ok = verifyToken(db, token, later(1000));
    expect(ok).toMatchObject({ ok: true, tokenId: info.id, user: { name: 'alice' } });
    expect(verifyToken(db, `wmk_${'A'.repeat(43)}`, T0)).toEqual({ ok: false, reason: 'invalid' });
    expect(verifyToken(db, 'garbage', T0)).toEqual({ ok: false, reason: 'invalid' });
    expect(verifyToken(db, token, later(86_400_000))).toEqual({ ok: false, reason: 'expired' });
    updateUser(db, 'alice', { disabled: true });
    expect(verifyToken(db, token, later(1000))).toEqual({ ok: false, reason: 'disabled' });
    updateUser(db, 'alice', { disabled: false });
    revokeToken(db, info.id, later(2000));
    expect(verifyToken(db, token, later(3000))).toEqual({ ok: false, reason: 'revoked' });
  });

  it('updates lastUsedAt at most once per minute', () => {
    const { token, info } = createToken(db, { user: 'alice' }, T0);
    const last = () => listTokens(db)[0]?.lastUsedAt;
    expect(last()).toBeNull();
    verifyToken(db, token, later(1000));
    expect(last()).toBe(later(1000).toISOString());
    verifyToken(db, token, later(30_000));
    expect(last()).toBe(later(1000).toISOString());
    verifyToken(db, token, later(61_000));
    expect(last()).toBe(later(61_000).toISOString());
    expect(info.status).toBe('active');
  });

  it('reports status in the listing and counts active tokens', () => {
    const a = createToken(db, { user: 'alice', expiresDays: 1 }, T0);
    const b = createToken(db, { user: 'alice' }, T0);
    createToken(db, { user: 'alice' }, T0);
    revokeToken(db, b.info.id, T0);
    const now = later(2 * 86_400_000);
    const status = Object.fromEntries(listTokens(db, 'alice', now).map((t) => [t.id, t.status]));
    expect(status[a.info.id]).toBe('expired');
    expect(status[b.info.id]).toBe('revoked');
    expect(listUsers(db, now)[0]?.activeTokens).toBe(1);
  });

  it('rejects unknown ids, unknown users and bad expiry', () => {
    expect(() => revokeToken(db, 'tok_deadbeef')).toThrow('token not found: tok_deadbeef');
    expect(() => createToken(db, { user: 'ghost' })).toThrow('user not found: ghost');
    expect(() => createToken(db, { user: 'alice', expiresDays: 0 })).toThrow(
      'invalid expiry "0" (a whole number of days, at least 1)',
    );
  });
});

describe('redaction', () => {
  it('redacts a waymark token, including one ending in "-"', () => {
    const { token } = createToken(addAlice(), { user: 'alice' });
    expect(redact(`my token is ${token}.`)).toBe('my token is [REDACTED:waymark-token].');
    expect(redact(`wmk_${'a'.repeat(42)}-`)).toBe('[REDACTED:waymark-token]');
    expect(redact(`wmk_${'a'.repeat(42)}`)).toBe(`wmk_${'a'.repeat(42)}`);
  });
});

function addAlice(): AuthDb {
  addUser(db, { name: 'alice' });
  return db;
}
