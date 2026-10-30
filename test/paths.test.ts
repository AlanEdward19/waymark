import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePaths } from '../src/paths.js';

describe('resolvePaths', () => {
  it('uses WAYMARK_HOME', () => {
    const home = path.resolve(os.tmpdir(), 'waymark-x');
    const p = resolvePaths({ WAYMARK_HOME: home });
    expect(p).toEqual({
      home,
      config: path.join(home, 'config.json'),
      wiki: path.join(home, 'wiki'),
      db: path.join(home, 'db', 'waymark.db'),
    });
  });

  it('defaults to ~/.waymark', () => {
    expect(resolvePaths({}).home).toBe(path.join(os.homedir(), '.waymark'));
  });
});
