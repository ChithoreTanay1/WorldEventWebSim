import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Scenario } from '../src/sim/types';
import { loadTypes } from './helpers';

const root = join(__dirname, '..', 'data');

describe('data files', () => {
  const types = loadTypes();

  it('every unit type has sane stats', () => {
    for (const t of Object.values(types)) {
      expect(t.men).toBeGreaterThan(0);
      expect(t.minRanks).toBeLessThanOrEqual(t.maxRanks);
      expect(t.runSpeed).toBeGreaterThanOrEqual(t.speed);
      expect(t.morale).toBeGreaterThanOrEqual(1);
      expect(t.morale).toBeLessThanOrEqual(10);
      if (t.range) expect(t.ammo! > 0 && t.reload! > 0 && t.accuracy! > 0).toBe(true);
    }
  });

  for (const f of readdirSync(join(root, 'scenarios'))) {
    const sc = JSON.parse(readFileSync(join(root, 'scenarios', f), 'utf8')) as Scenario;
    it(`${f} references known unit types and stays on the map`, () => {
      expect(sc.sides[sc.player]).toBeDefined();
      expect(sc.disclaimer.length).toBeGreaterThan(20);
      for (const side of Object.values(sc.sides)) {
        for (const u of side.units) {
          expect(types[u.type], u.type).toBeDefined();
          expect(u.pos[0]).toBeGreaterThan(0);
          expect(u.pos[0]).toBeLessThan(sc.terrain.size[0]);
          expect(u.pos[1]).toBeGreaterThan(0);
          expect(u.pos[1]).toBeLessThan(sc.terrain.size[1]);
        }
      }
    });
  }
});
