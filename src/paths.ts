import os from 'node:os';
import path from 'node:path';

export interface WaymarkPaths {
  home: string;
  config: string;
  wiki: string;
  db: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): WaymarkPaths {
  const home = env.WAYMARK_HOME
    ? path.resolve(env.WAYMARK_HOME)
    : path.join(os.homedir(), '.waymark');
  return {
    home,
    config: path.join(home, 'config.json'),
    wiki: path.join(home, 'wiki'),
    db: path.join(home, 'db', 'waymark.db'),
  };
}
