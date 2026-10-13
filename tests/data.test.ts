import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Scenario } from '../src/sim/types';
import { loadForms, loadTypes } from './helpers';

const root = join(__dirname, '..', 'data');

describe('data files', () => {
  const types = loadTypes();
  const forms = loadForms();

  it('formations are well formed', () => {
    for (const f of Object.values(forms)) {
      if (f.flank) expect(f.flank[0]).toBeLessThan(f.flank[1]);
      expect(f.turnRate).toBeGreaterThan(0);
      expect(f.formTicks).toBeGreaterThanOrEqual(0);
    }
    expect(forms.dispersed.selectable).toBe(false);
  });

  it('every unit type has sane stats and known formations', () => {
    for (const t of Object.values(types)) {
      expect(t.hp).toBeGreaterThan(0);
      expect(t.org).toBeGreaterThan(0);
      expect(t.run).toBeGreaterThanOrEqual(t.walk);
      const m = t.orgMarks;
      expect(m.shatter).toBeLessThan(m.route);
      expect(m.route).toBeLessThan(m.recover);
      expect(m.recover).toBeLessThan(m.rally);
      expect(t.formations[t.defaultFormation]).toBeDefined();
      for (const f of Object.keys(t.formations)) expect(forms[f], `${t.id}: ${f}`).toBeDefined();
      if (t.ranged) {
        expect(t.ranged.ammo).toBeGreaterThan(0);
        const bands = t.ranged.weapon.bands;
        for (let i = 1; i < bands.length; i++) expect(bands[i][0]).toBe(bands[i - 1][1]);
      }
    }
  });

  for (const f of readdirSync(join(root, 'scenarios'))) {
    const sc = JSON.parse(readFileSync(join(root, 'scenarios', f), 'utf8')) as Scenario;
    it(`${f}: units are known and deploy inside their zone`, () => {
      expect(sc.sides[sc.player]).toBeDefined();
      expect(sc.disclaimer.length).toBeGreaterThan(20);
      for (const side of Object.values(sc.sides)) {
        const [x0, z0, x1, z1] = side.deployZone;
        for (const u of side.units) {
          expect(types[u.type], u.type).toBeDefined();
          expect(u.pos[0] >= x0 && u.pos[0] <= x1 && u.pos[1] >= z0 && u.pos[1] <= z1, `${u.name} outside zone`).toBe(true);
        }
      }
    });
  }
});
