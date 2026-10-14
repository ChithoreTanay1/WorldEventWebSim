// Flanking must matter: the same charge or melee into a flank or rear does far more harm than into
// the front, and heavy chargers (elephants, cataphracts) can break a unit with a rear charge.
import { describe, expect, it } from 'vitest';
import { chargeImpact, flankOf, meleeSwing } from '../src/sim/combat';
import type { Battle } from '../src/sim/battle';
import type { Unit } from '../src/sim/unit';
import { newBattle } from './helpers';

/** Put attacker `a` against defender `d` (a line of foot facing +x) on its front, side or rear. */
function setup(attacker: string, where: 'front' | 'side' | 'rear'): { b: Battle; a: Unit; d: Unit } {
  const b = newBattle();
  b.endTurn();
  const d = b.units.find((u) => u.side === 'gupta' && u.type.id === 'heavy-infantry')!;
  const a = b.units.find((u) => u.side !== 'gupta' && u.type.id === attacker) ?? b.units.find((u) => u.type.id === attacker)!;
  for (const u of b.units) if (u !== a && u !== d) u.x = u.z = 5; // everyone else far away
  d.x = 500;
  d.z = 300;
  d.facing = 0;
  const off = { front: [d.depth / 2 + a.depth / 2, 0], side: [0, d.frontage / 2 + a.frontage / 2], rear: [-(d.depth / 2 + a.depth / 2), 0] }[where];
  a.x = d.x + off[0];
  a.z = d.z + off[1];
  a.facing = Math.atan2(d.z - a.z, d.x - a.x);
  return { b, a, d };
}

describe('flanking', () => {
  it('reads the side of a wide line as its flank and the back as its rear', () => {
    expect(flankOf(setup('steppe-lancers', 'front').b, setup('steppe-lancers', 'front').d, setup('steppe-lancers', 'front').a)).toBe(0);
    const s = setup('steppe-lancers', 'side');
    expect(flankOf(s.b, s.d, s.a)).toBeCloseTo(0.5, 1);
    const r = setup('steppe-lancers', 'rear');
    expect(flankOf(r.b, r.d, r.a)).toBe(1);
  });

  it('a heavy charge into the rear does several times the harm of one into the front', () => {
    const f = setup('steppe-lancers', 'front'), r = setup('steppe-lancers', 'rear');
    const front = chargeImpact(f.b, f.a, f.d).defender, rear = chargeImpact(r.b, r.a, r.d).defender;
    expect(rear.hp).toBeGreaterThan(front.hp * 2);
    expect(rear.org).toBeGreaterThan(front.org * 3);
    // The charger also takes no backlash from a rear charge.
    expect(chargeImpact(r.b, r.a, r.d).attacker.hp).toBeLessThanOrEqual(chargeImpact(f.b, f.a, f.d).attacker.hp);
  });

  it('an elephant charge into the rear can all but break a line on its own', () => {
    const r = setup('war-elephants', 'rear');
    const hit = chargeImpact(r.b, r.a, r.d).defender;
    expect(hit.org).toBeGreaterThan(r.d.maxOrg * 0.4);
  });

  it('melee from the flank costs the defender more men and nerve, and it hits back weaker', () => {
    const f = setup('steppe-lancers', 'front'), s = setup('steppe-lancers', 'side');
    const front = meleeSwing(f.b, f.a, f.d), side = meleeSwing(s.b, s.a, s.d);
    expect(side.hp).toBeGreaterThan(front.hp * 1.3);
    expect(side.org).toBeGreaterThan(front.org * 1.5);
    expect(meleeSwing(s.b, s.d, s.a).hp).toBeLessThan(meleeSwing(f.b, f.d, f.a).hp);
  });
});
