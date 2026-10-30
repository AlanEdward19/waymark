import type { WaymarkPaths } from '../paths.js';
import { handleHook as handleClaudeCodeHook } from './claude-code.js';
import { handleHermesHook } from './hermes.js';

export type HookHandler = (stdin: string, paths: WaymarkPaths) => Promise<string>;

export const HOOK_HANDLERS: Record<string, HookHandler> = {
  'claude-code': handleClaudeCodeHook,
  hermes: handleHermesHook,
};
