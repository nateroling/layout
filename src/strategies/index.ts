// Strategy registry. Add new strategies here.
import type { Strategy } from '../engine.ts';
import { city, metro, metroSpiral } from './city.ts';
import { metroHex, metroPack, metroSeams, metroWarp } from './metrogrid.ts';
import { hindsight } from './hindsight.ts';
import { recompute } from './recompute.ts';
import { slack } from './slack.ts';
import { tombstone } from './tombstone.ts';

export const strategies: Record<string, Strategy<any>> = {
  recompute,
  hindsight,
  slack,
  tombstone,
  city,
  metro,
  'metro-spiral': metroSpiral,
  'metro-seams': metroSeams,
  'metro-hex': metroHex,
  'metro-warp': metroWarp,
  'metro-pack': metroPack,
};

export function getStrategy(name: string): Strategy<any> {
  const s = strategies[name];
  if (!s) throw new Error(`unknown strategy "${name}". Known: ${Object.keys(strategies).join(', ')}`);
  return s;
}
