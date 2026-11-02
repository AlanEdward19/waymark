import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type AuthDb = Database.Database;

export type Role = 'admin' | 'member';

export interface User {
  name: string;
  displayName: string;
  role: Role;
  groups: string[];
  disabled: boolean;
  createdAt: string;
}

export interface TokenInfo {
  id: string;
  user: string;
  label: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  status: 'active' | 'expired' | 'revoked';
}

export type VerifyResult =
  | { ok: true; user: User; tokenId: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'revoked' | 'disabled' };

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const NAME_HINT =
  'lowercase letters, digits, ".", "_" and "-", 1-63 characters, starting with a letter or digit';
const GUID = /^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/;

interface ProviderSpec {
  re: RegExp;
  hint: string;
  normalize?: (v: string) => string;
}

const PROVIDERS: Record<string, ProviderSpec> = {
  github: {
    re: /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/,
    hint: 'a GitHub login',
    normalize: (v) => v.toLowerCase(),
  },
  slack: { re: /^[UW][A-Z0-9]{2,}$/, hint: 'a Slack user id like U01ABC23DEF' },
  teams: { re: GUID, hint: 'an Entra object id (GUID)', normalize: (v) => v.toLowerCase() },
  discord: { re: /^\d{17,20}$/, hint: 'a Discord user id (17-20 digits)' },
  linear: { re: GUID, hint: 'a Linear user UUID', normalize: (v) => v.toLowerCase() },
  oidc: { re: /^[^|\s]+\|[^|\s]+$/, hint: '<issuer>|<subject>' },
};
export const PROVIDER_NAMES = Object.keys(PROVIDERS);

const TOKEN_RE = /^wmk_[A-Za-z0-9_-]{43}$/;
const TOUCH_INTERVAL_MS = 60_000;
const DAY_MS = 86_400_000;

const SCHEMA = `
CREATE TABLE users (
  name         TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role         TEXT NOT NULL,
  disabled     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);
CREATE TABLE user_groups (
  user TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE,
  grp  TEXT NOT NULL,
  PRIMARY KEY (user, grp)
);
CREATE TABLE identities (
  provider    TEXT NOT NULL,
  external_id TEXT NOT NULL,
  user        TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE,
  PRIMARY KEY (provider, external_id),
  UNIQUE (user, provider)
);
CREATE TABLE tokens (
  id           TEXT PRIMARY KEY,
  user         TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE,
  hash         TEXT NOT NULL UNIQUE,  -- SHA-256 hex of the token; the token is never stored
  label        TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT,
  last_used_at TEXT,
  revoked_at   TEXT
);
`;
const SCHEMA_VERSION = 1;

function bestEffortChmod(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch {
    // the OS may not support modes
  }
}

// accounts are state, not cache: this file lives outside db/ and reindex never touches it
export function openAuthDb(file: string): AuthDb {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  bestEffortChmod(path.dirname(file), 0o700);
  const db = new Database(file);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    const version = db.pragma('user_version', { simple: true }) as number;
    if (version > SCHEMA_VERSION) {
      throw new Error('Auth database schema is newer than this Waymark version');
    }
    if (version < 1) {
      db.transaction(() => {
        db.exec(SCHEMA);
        db.pragma(`user_version = ${SCHEMA_VERSION}`);
      })();
    }
    bestEffortChmod(file, 0o600);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

function checkName(name: string): void {
  if (!NAME_RE.test(name)) throw new Error(`invalid user name "${name}" (${NAME_HINT})`);
}

function checkGroup(group: string): void {
  if (!NAME_RE.test(group)) throw new Error(`invalid group "${group}" (${NAME_HINT})`);
}

interface UserRow {
  name: string;
  display_name: string;
  role: Role;
  disabled: number;
  created_at: string;
}

function toUser(db: AuthDb, row: UserRow): User {
  const groups = db
    .prepare('SELECT grp FROM user_groups WHERE user = ? ORDER BY grp')
    .all(row.name) as { grp: string }[];
  return {
    name: row.name,
    displayName: row.display_name,
    role: row.role,
    groups: groups.map((g) => g.grp),
    disabled: row.disabled === 1,
    createdAt: row.created_at,
  };
}

export function getUser(db: AuthDb, name: string): User | undefined {
  const row = db.prepare('SELECT * FROM users WHERE name = ?').get(name) as UserRow | undefined;
  return row && toUser(db, row);
}

function requireUser(db: AuthDb, name: string): User {
  const user = getUser(db, name);
  if (!user) throw new Error(`user not found: ${name}`);
  return user;
}

function setGroups(db: AuthDb, name: string, groups: string[]): void {
  for (const g of groups) checkGroup(g);
  db.prepare('DELETE FROM user_groups WHERE user = ?').run(name);
  const ins = db.prepare('INSERT OR IGNORE INTO user_groups (user, grp) VALUES (?, ?)');
  for (const g of groups) ins.run(name, g);
}

export function addUser(
  db: AuthDb,
  input: { name: string; displayName?: string; admin?: boolean; groups?: string[] },
  now: Date = new Date(),
): User {
  checkName(input.name);
  return db.transaction(() => {
    if (getUser(db, input.name)) throw new Error(`user "${input.name}" already exists`);
    db.prepare(
      'INSERT INTO users (name, display_name, role, disabled, created_at) VALUES (?, ?, ?, 0, ?)',
    ).run(
      input.name,
      input.displayName ?? input.name,
      input.admin ? 'admin' : 'member',
      now.toISOString(),
    );
    setGroups(db, input.name, input.groups ?? []);
    return requireUser(db, input.name);
  })();
}

export function updateUser(
  db: AuthDb,
  name: string,
  patch: { displayName?: string; role?: Role; groups?: string[]; disabled?: boolean },
): User {
  return db.transaction(() => {
    requireUser(db, name);
    if (patch.displayName !== undefined) {
      db.prepare('UPDATE users SET display_name = ? WHERE name = ?').run(patch.displayName, name);
    }
    if (patch.role !== undefined) {
      db.prepare('UPDATE users SET role = ? WHERE name = ?').run(patch.role, name);
    }
    if (patch.disabled !== undefined) {
      db.prepare('UPDATE users SET disabled = ? WHERE name = ?').run(patch.disabled ? 1 : 0, name);
    }
    if (patch.groups !== undefined) setGroups(db, name, patch.groups);
    return requireUser(db, name);
  })();
}

export type UserSummary = User & { providers: string[]; activeTokens: number };

export function listUsers(db: AuthDb, now: Date = new Date()): UserSummary[] {
  const rows = db.prepare('SELECT * FROM users ORDER BY name').all() as UserRow[];
  const providers = db.prepare('SELECT provider FROM identities WHERE user = ? ORDER BY provider');
  const active = db.prepare(
    'SELECT COUNT(*) AS n FROM tokens WHERE user = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)',
  );
  return rows.map((row) => ({
    ...toUser(db, row),
    providers: (providers.all(row.name) as { provider: string }[]).map((r) => r.provider),
    activeTokens: (active.get(row.name, now.toISOString()) as { n: number }).n,
  }));
}

function providerSpec(provider: string): ProviderSpec {
  if (!Object.hasOwn(PROVIDERS, provider)) {
    throw new Error(`invalid provider "${provider}" (valid: ${PROVIDER_NAMES.join(', ')})`);
  }
  return PROVIDERS[provider] as ProviderSpec;
}

export function linkIdentity(db: AuthDb, name: string, provider: string, externalId: string): void {
  const spec = providerSpec(provider);
  if (!spec.re.test(externalId)) {
    throw new Error(`invalid ${provider} id "${externalId}" (expected ${spec.hint})`);
  }
  const id = spec.normalize ? spec.normalize(externalId) : externalId;
  db.transaction(() => {
    requireUser(db, name);
    const owner = db
      .prepare('SELECT user FROM identities WHERE provider = ? AND external_id = ?')
      .get(provider, id) as { user: string } | undefined;
    if (owner && owner.user !== name) {
      throw new Error(`${provider} id "${id}" is already linked to user "${owner.user}"`);
    }
    // one identity per provider per user: linking again replaces the previous id
    db.prepare('DELETE FROM identities WHERE user = ? AND provider = ?').run(name, provider);
    db.prepare('INSERT INTO identities (provider, external_id, user) VALUES (?, ?, ?)').run(
      provider,
      id,
      name,
    );
  })();
}

export function unlinkIdentity(db: AuthDb, name: string, provider: string): void {
  providerSpec(provider);
  requireUser(db, name);
  const r = db
    .prepare('DELETE FROM identities WHERE user = ? AND provider = ?')
    .run(name, provider);
  if (r.changes === 0) throw new Error(`user "${name}" has no ${provider} identity`);
}

export function findUserByIdentity(
  db: AuthDb,
  provider: string,
  externalId: string,
): User | undefined {
  const spec = providerSpec(provider);
  const row = db
    .prepare(
      'SELECT u.* FROM identities i JOIN users u ON u.name = i.user WHERE i.provider = ? AND i.external_id = ?',
    )
    .get(provider, spec.normalize ? spec.normalize(externalId) : externalId) as UserRow | undefined;
  return row && toUser(db, row);
}

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

interface TokenRow {
  id: string;
  user: string;
  hash: string;
  label: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

const isExpired = (r: TokenRow, now: Date): boolean =>
  r.expires_at !== null && Date.parse(r.expires_at) <= now.getTime();

function toTokenInfo(r: TokenRow, now: Date): TokenInfo {
  return {
    id: r.id,
    user: r.user,
    label: r.label,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
    status: r.revoked_at ? 'revoked' : isExpired(r, now) ? 'expired' : 'active',
  };
}

export function createToken(
  db: AuthDb,
  input: { user: string; label?: string; expiresDays?: number | string },
  now: Date = new Date(),
): { token: string; info: TokenInfo } {
  const { expiresDays } = input;
  let expiresAt: string | null = null;
  if (expiresDays !== undefined) {
    const days = Number(expiresDays);
    const at = new Date(now.getTime() + days * DAY_MS);
    if (!(Number.isInteger(days) && days >= 1) || Number.isNaN(at.getTime())) {
      throw new Error(`invalid expiry "${expiresDays}" (a whole number of days, at least 1)`);
    }
    expiresAt = at.toISOString();
  }
  requireUser(db, input.user);
  const token = `wmk_${randomBytes(32).toString('base64url')}`;
  const id = `tok_${randomBytes(4).toString('hex')}`;
  db.prepare(
    'INSERT INTO tokens (id, user, hash, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, input.user, hashToken(token), input.label ?? '', now.toISOString(), expiresAt);
  const row = db.prepare('SELECT * FROM tokens WHERE id = ?').get(id) as TokenRow;
  return { token, info: toTokenInfo(row, now) };
}

export function listTokens(db: AuthDb, user?: string, now: Date = new Date()): TokenInfo[] {
  const rows = (
    user === undefined
      ? db.prepare('SELECT * FROM tokens ORDER BY created_at, id').all()
      : db.prepare('SELECT * FROM tokens WHERE user = ? ORDER BY created_at, id').all(user)
  ) as TokenRow[];
  return rows.map((r) => toTokenInfo(r, now));
}

export function revokeToken(db: AuthDb, id: string, now: Date = new Date()): void {
  const r = db
    .prepare('UPDATE tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?')
    .run(now.toISOString(), id);
  if (r.changes === 0) throw new Error(`token not found: ${id}`);
}

// Exported for the network server (#95). The token is hashed before the lookup, so no timing
// difference reveals anything about the secret; timingSafeEqual on the hashes is defence in depth.
// Updates lastUsedAt at most once per minute per token.
export function verifyToken(db: AuthDb, token: string, now: Date = new Date()): VerifyResult {
  if (!TOKEN_RE.test(token)) return { ok: false, reason: 'invalid' };
  const hash = hashToken(token);
  const row = db.prepare('SELECT * FROM tokens WHERE hash = ?').get(hash) as TokenRow | undefined;
  // both are 64 hex chars, so timingSafeEqual cannot throw
  if (!row || !timingSafeEqual(Buffer.from(row.hash), Buffer.from(hash))) {
    return { ok: false, reason: 'invalid' };
  }
  if (row.revoked_at) return { ok: false, reason: 'revoked' };
  if (isExpired(row, now)) return { ok: false, reason: 'expired' };
  const user = requireUser(db, row.user);
  if (user.disabled) return { ok: false, reason: 'disabled' };
  if (!row.last_used_at || now.getTime() - Date.parse(row.last_used_at) >= TOUCH_INTERVAL_MS) {
    db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(now.toISOString(), row.id);
  }
  return { ok: true, user, tokenId: row.id };
}
