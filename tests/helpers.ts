import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Battle } from '../src/sim/battle';
import type { FormationDef, Scenario, UnitType } from '../src/sim/types';

const root = join(__dirname, '..', 'data');

function loadDir<T extends { id: string }>(dir: string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const f of readdirSync(join(root, dir))) {
    const t = JSON.parse(readFileSync(join(root, dir, f), 'utf8')) as T;
    out[t.id] = t;
  }
  return out;
}

export const loadTypes = () => loadDir<UnitType>('units');
export const loadForms = () => loadDir<FormationDef>('formations');

export function loadScenario(id = 'gupta-frontier-battle'): Scenario {
  return JSON.parse(readFileSync(join(root, 'scenarios', `${id}.json`), 'utf8'));
}

export function newBattle(seed?: number, edit?: (s: Scenario) => void): Battle {
  const sc = loadScenario();
  if (seed !== undefined) sc.seed = seed;
  edit?.(sc);
  return new Battle(sc, loadTypes(), loadForms());
}

/** Play turns until the battle ends or `maxTurns` battle turns pass. `player` issues orders each planning phase. */
export function playOut(b: Battle, player?: (b: Battle) => void, maxTurns = 40, onTurn?: (b: Battle) => void) {
  if (b.phase === 'deployment') b.endTurn();
  while (!b.result && b.battleTurn() <= maxTurns) {
    player?.(b);
    b.resolveTurn();
    onTurn?.(b);
  }
}
