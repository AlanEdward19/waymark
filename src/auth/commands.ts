import { type AuditEventName, type AuditSink, fileAuditSink } from '../audit.js';
import { printable } from '../memory/people.js';
import type { WaymarkPaths } from '../paths.js';
import {
  type AuthDb,
  addUser,
  createToken,
  linkIdentity,
  listTokens,
  listUsers,
  openAuthDb,
  revokeToken,
  unlinkIdentity,
  updateUser,
} from './store.js';

export interface AuthFlags {
  display?: string;
  admin?: boolean;
  member?: boolean;
  group?: string[];
  disable?: boolean;
  enable?: boolean;
  label?: string;
  expires?: string;
  user?: string;
  json?: boolean;
}

function table(header: string[], rows: string[][]): string {
  const all = [header, ...rows.map((r) => r.map(printable))];
  const widths = header.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
  const line = (r: string[]) =>
    r
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return `${all.map(line).join('\n')}\n`;
}

function exclusive(a: boolean | undefined, b: boolean | undefined, names: string): void {
  if (a && b) throw new Error(`${names} cannot be used together`);
}

// per subcommand: how many positionals it takes and which flags apply
const SPECS: Record<string, { args: number; flags: (keyof AuthFlags)[] }> = {
  'user add': { args: 1, flags: ['display', 'admin', 'group'] },
  'user list': { args: 0, flags: ['json'] },
  'user update': { args: 1, flags: ['display', 'admin', 'member', 'group', 'disable', 'enable'] },
  'user link': { args: 3, flags: [] },
  'user unlink': { args: 2, flags: [] },
  'token create': { args: 1, flags: ['label', 'expires'] },
  'token list': { args: 0, flags: ['user', 'json'] },
  'token revoke': { args: 1, flags: [] },
};

function checkUsage(command: string, args: string[], flags: AuthFlags): void {
  const [sub, ...rest] = args;
  const key = `${command} ${sub}`;
  const spec = Object.hasOwn(SPECS, key) ? SPECS[key] : undefined;
  if (!spec) return; // the subcommand switch reports the usage
  const allowed = spec.flags.map((k) => `--${k}`);
  for (const [k, v] of Object.entries(flags)) {
    if (v === undefined || spec.flags.includes(k as keyof AuthFlags)) continue;
    throw new Error(
      `option --${k} does not apply to "waymark ${key}" (${allowed.length ? `allowed: ${allowed.join(', ')}` : 'it takes no options'})`,
    );
  }
  if (rest.length > spec.args) {
    throw new Error(
      `unexpected argument "${printable(rest[spec.args] ?? '')}" for "waymark ${key}"`,
    );
  }
}

type Log = (event: AuditEventName, object: string, detail?: Record<string, unknown>) => void;

function userCommand(db: AuthDb, args: string[], f: AuthFlags, log: Log): string {
  const [sub, name, ...rest] = args;
  switch (sub) {
    case 'add': {
      if (!name)
        throw new Error(
          'usage: waymark user add <name> [--display <text>] [--admin] [--group <g>]...',
        );
      addUser(db, { name, displayName: f.display, admin: f.admin, groups: f.group });
      log('user.created', name, { role: f.admin ? 'admin' : 'member', groups: f.group ?? [] });
      return `Created user ${name}\n`;
    }
    case 'list': {
      const users = listUsers(db);
      if (f.json) return `${JSON.stringify(users, null, 2)}\n`;
      return table(
        ['NAME', 'DISPLAY', 'ROLE', 'GROUPS', 'DISABLED', 'LINKED', 'TOKENS'],
        users.map((u) => [
          u.name,
          u.displayName,
          u.role,
          u.groups.join(',') || '-',
          u.disabled ? 'yes' : 'no',
          u.providers.join(',') || '-',
          String(u.activeTokens),
        ]),
      );
    }
    case 'update': {
      if (!name) throw new Error('usage: waymark user update <name> [options]');
      exclusive(f.admin, f.member, '--admin and --member');
      exclusive(f.disable, f.enable, '--disable and --enable');
      updateUser(db, name, {
        displayName: f.display,
        role: f.admin ? 'admin' : f.member ? 'member' : undefined,
        groups: f.group,
        disabled: f.disable ? true : f.enable ? false : undefined,
      });
      log('user.updated', name, {
        role: f.admin ? 'admin' : f.member ? 'member' : undefined,
        groups: f.group,
        disabled: f.disable ? true : f.enable ? false : undefined,
        displayName: f.display,
      });
      return `Updated user ${name}\n`;
    }
    case 'link': {
      const [provider, externalId] = rest;
      if (!name || !provider || !externalId) {
        throw new Error('usage: waymark user link <name> <provider> <externalId>');
      }
      linkIdentity(db, name, provider, externalId);
      log('user.linked', name, { provider });
      return `Linked ${name} to ${provider}:${externalId}\n`;
    }
    case 'unlink': {
      const [provider] = rest;
      if (!name || !provider) throw new Error('usage: waymark user unlink <name> <provider>');
      unlinkIdentity(db, name, provider);
      log('user.unlinked', name, { provider });
      return `Unlinked ${name} from ${provider}\n`;
    }
    default:
      throw new Error('usage: waymark user <add|list|update|link|unlink>');
  }
}

function tokenCommand(db: AuthDb, args: string[], f: AuthFlags, log: Log): string {
  const [sub, arg] = args;
  switch (sub) {
    case 'create': {
      if (!arg)
        throw new Error('usage: waymark token create <user> [--label <text>] [--expires <days>]');
      const { token, info } = createToken(db, {
        user: arg,
        label: f.label,
        expiresDays: f.expires,
      });
      log('token.created', info.id, { user: arg, label: info.label, expiresAt: info.expiresAt });
      process.stderr.write(`Token ${info.id} for ${arg}. Store it now: it is not shown again.\n`);
      return `${token}\n`;
    }
    case 'list': {
      const tokens = listTokens(db, f.user);
      if (f.json) return `${JSON.stringify(tokens, null, 2)}\n`;
      return table(
        ['ID', 'USER', 'LABEL', 'CREATED', 'EXPIRES', 'LAST USED', 'STATUS'],
        tokens.map((t) => [
          t.id,
          t.user,
          t.label || '-',
          t.createdAt,
          t.expiresAt ?? '-',
          t.lastUsedAt ?? '-',
          t.status,
        ]),
      );
    }
    case 'revoke': {
      if (!arg) throw new Error('usage: waymark token revoke <id>');
      revokeToken(db, arg);
      log('token.revoked', arg);
      return `Revoked ${arg}\n`;
    }
    default:
      throw new Error('usage: waymark token <create|list|revoke>');
  }
}

export function runAuthCommand(
  command: 'user' | 'token',
  args: string[],
  flags: AuthFlags,
  paths: WaymarkPaths,
  audit: AuditSink = fileAuditSink(paths.audit),
): string {
  checkUsage(command, args, flags);
  const db = openAuthDb(paths.authDb);
  const log: Log = (event, object, detail = {}) =>
    audit({
      at: new Date().toISOString(),
      event,
      object,
      detail,
      outcome: 'ok',
      user: 'owner',
      via: 'cli',
    });
  try {
    return command === 'user'
      ? userCommand(db, args, flags, log)
      : tokenCommand(db, args, flags, log);
  } finally {
    db.close();
  }
}
