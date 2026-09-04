import type { Adapter } from './types.ts';
import { claudeAdapter } from './claude.ts';
import { codexAdapter } from './codex.ts';
import { geminiAdapter } from './gemini.ts';
import { agyAdapter } from './agy.ts';
import { fakeAdapter } from './fake.ts';

export const ADAPTERS: Record<string, Adapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
  agy: agyAdapter,
  fake: fakeAdapter,
};

export function getAdapter(name: string): Adapter {
  const adapter = ADAPTERS[name];
  if (!adapter) throw new Error(`Unknown adapter "${name}". Available: ${Object.keys(ADAPTERS).join(', ')}.`);
  return adapter;
}

export type { Adapter, AdapterOptions, AdapterInvocation, AdapterResult } from './types.ts';
