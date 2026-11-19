// Strategy registry. Add new strategies here.
import type { Strategy } from '../engine.ts';
import { recompute } from './recompute.ts';

export const strategies: Record<string, Strategy<any>> = {
  recompute,
};

export function getStrategy(name: string): Strategy<any> {
  const s = strategies[name];
  if (!s) throw new Error(`unknown strategy "${name}". Known: ${Object.keys(strategies).join(', ')}`);
  return s;
}
