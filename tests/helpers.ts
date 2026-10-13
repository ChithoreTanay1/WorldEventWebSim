import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Battle } from '../src/sim/battle';
import type { Scenario, UnitType } from '../src/sim/types';

const root = join(__dirname, '..', 'data');

export function loadTypes(): Record<string, UnitType> {
  const out: Record<string, UnitType> = {};
  for (const f of readdirSync(join(root, 'units'))) {
    const t = JSON.parse(readFileSync(join(root, 'units', f), 'utf8')) as UnitType;
    out[t.id] = t;
  }
  return out;
}

export function loadScenario(id = 'gupta-frontier-battle'): Scenario {
  return JSON.parse(readFileSync(join(root, 'scenarios', `${id}.json`), 'utf8'));
}

export function newBattle(seed?: number): Battle {
  const sc = loadScenario();
  if (seed !== undefined) sc.seed = seed;
  return new Battle(sc, loadTypes());
}

/** Run until a result or the time cap (seconds). */
export function runUntil(b: Battle, cap = 900, onSecond?: (b: Battle) => void) {
  while (!b.result && b.time < cap) {
    b.step();
    if (onSecond && b.ticks % 20 === 0) onSecond(b);
  }
}
