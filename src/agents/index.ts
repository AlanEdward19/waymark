import type { WaymarkPaths } from '../paths.js';
import { handleHook as handleClaudeCodeHook } from './claude-code.js';
import { handleCursorHook } from './cursor.js';

export type HookHandler = (stdin: string, paths: WaymarkPaths) => Promise<string>;

export const HOOK_HANDLERS: Record<string, HookHandler> = {
  'claude-code': handleClaudeCodeHook,
  cursor: handleCursorHook,
};
