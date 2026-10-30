import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export type RunGit = (args: string[], cwd: string) => Promise<string>;

const execFileP = promisify(execFile);

// execFile captures stdout and stderr, so git output never reaches our own stdout.
export const defaultRun: RunGit = async (args, cwd) => {
  const { stdout } = await execFileP('git', args, {
    cwd,
    maxBuffer: 256 * 1024 * 1024,
    encoding: 'utf8',
  });
  return stdout;
};
