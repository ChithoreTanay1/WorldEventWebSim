import { describe, expect, it } from 'vitest';
import { Battle } from '../src/sim/battle';
import { sideOf } from '../src/sim/geometry';
import { WATER_LEVEL } from '../src/sim/terrain';
import { loadScenario, loadTypes, newBattle, runUntil } from './helpers';
import { chaserPlayer, goodPlayer } from './players';

function fingerprint(b: Battle): string {
  return b.units.map((u) => `${u.men}:${u.x.toFixed(3)}:${u.z.toFixed(3)}:${u.morale.toFixed(3)}:${u.state}`).join('|');
}

/** A two-unit duel on flat ground for testing combat rules in isolation. Unit 0 attacks unit 1. */
function duel(attackerPos: [number, number], attackerFacing: number, attacker = 'heavy-infantry', defender = 'heavy-infantry') {
  const sc = loadScenario();
  sc.terrain = { size: [400, 400], hills: [] };
  sc.sides = {
    a: { name: 'A', color: '#aa0000', rearX: 0, units: [{ type: attacker, pos: attackerPos, facing: attackerFacing }] },
    d: { name: 'D', color: '#0000aa', rearX: 400, units: [{ type: defender, pos: [200, 200], facing: 180 }] },
  };
  sc.player = 'a';
  return new Battle(sc, loadTypes());
}

describe('simulation', () => {
  it('is deterministic for the same seed and inputs', () => {
    const a = newBattle(), b = newBattle();
    runUntil(a, 120, goodPlayer);
    runUntil(b, 120, goodPlayer);
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it('never produces NaN positions or negative strengths over a full battle', () => {
    const b = newBattle();
    runUntil(b, 900, chaserPlayer);
    for (const u of b.units) {
      expect(Number.isFinite(u.x) && Number.isFinite(u.z) && Number.isFinite(u.facing)).toBe(true);
      expect(u.men).toBeGreaterThanOrEqual(0);
    }
  });

  it('classifies attack sides', () => {
    const u = { x: 0, z: 0, facing: 0 };
    expect(sideOf(u, 10, 0)).toBe('front');
    expect(sideOf(u, 0, 10)).toBe('flank');
    expect(sideOf(u, -10, 0)).toBe('rear');
  });

  it('a rear attack kills faster than a frontal one', () => {
    // The defender at (200, 200) faces west (180°), so its front is toward -x.
    const front = duel([170, 200], 0);
    const rear = duel([230, 200], 180);
    for (const b of [front, rear]) {
      b.orderAttack(0, 1);
      for (let i = 0; i < 20 * 20; i++) b.step();
    }
    const lossFront = front.unit(1).maxMen - front.unit(1).men;
    const lossRear = rear.unit(1).maxMen - rear.unit(1).men;
    expect(lossRear).toBeGreaterThan(lossFront * 1.5);
  });

  it('braced spears blunt a frontal cavalry charge', () => {
    const vsSpear = duel([60, 200], 0, 'heavy-cavalry', 'levy-spearmen');
    const vsArcher = duel([60, 200], 0, 'heavy-cavalry', 'archers');
    for (const b of [vsSpear, vsArcher]) {
      b.orderAttack(0, 1, true);
      for (let i = 0; i < 30 * 20; i++) b.step();
    }
    const spearLoss = (vsSpear.unit(1).maxMen - vsSpear.unit(1).men) / vsSpear.unit(1).maxMen;
    const archerLoss = (vsArcher.unit(1).maxMen - vsArcher.unit(1).men) / vsArcher.unit(1).maxMen;
    expect(spearLoss).toBeLessThan(archerLoss);
    expect(vsSpear.log.some((l) => l.text.includes('braced spears'))).toBe(true);
  });

  it('morale degrades steady -> wavering -> retreating under a rear charge, breaking a one-unit army', () => {
    const b = duel([300, 200], 180, 'heavy-cavalry', 'archers');
    b.orderAttack(0, 1, true);
    const seen: string[] = [];
    for (let i = 0; i < 90 * 20 && !b.result; i++) {
      b.step();
      if (seen[seen.length - 1] !== b.unit(1).state) seen.push(b.unit(1).state);
    }
    expect(seen.slice(0, 3)).toEqual(['steady', 'wavering', 'retreating']);
    expect(b.result?.winner).toBe('a');
  });

  it('formation moves pivot instead of sliding sideways', () => {
    const b = duel([100, 100], 0);
    // The target is off the unit's left; it must turn before covering much ground.
    b.orderMove(0, { x: 100, z: 160, facing: Math.PI / 2, files: 28 });
    for (let i = 0; i < 10; i++) b.step();
    expect(Math.abs(b.unit(0).z - 100)).toBeLessThan(1);
    for (let i = 0; i < 60 * 20; i++) b.step();
    expect(b.unit(0).z).toBeCloseTo(160, 0);
    expect(b.unit(0).facing).toBeCloseTo(Math.PI / 2, 1);
  });

  it('the river is water, and slower to cross away from the ford', () => {
    const t = newBattle().terrain;
    expect(t.height(460, 532)).toBeLessThan(WATER_LEVEL);
    expect(t.speedFactor(300, 556, 'infantry')).toBeLessThan(t.speedFactor(460, 532, 'infantry'));
    expect(t.speedFactor(300, 300, 'infantry')).toBe(1);
  });
});

describe('scenario balance (a regression guard, not a guarantee)', () => {
  const seeds = [1337, 7, 42];
  const outcome = (p?: (b: Battle) => void) =>
    seeds.map((s) => {
      const b = newBattle(s);
      runUntil(b, 1200, p);
      return b.result?.winner ?? 'draw';
    });

  it('the intended pattern (hold the centre, counter-charge the enemy horse) usually wins', () => {
    expect(outcome(goodPlayer).filter((w) => w === 'gupta').length).toBeGreaterThanOrEqual(2);
  }, 60000);

  it('doing nothing does not win', () => {
    expect(outcome(undefined).filter((w) => w === 'gupta').length).toBe(0);
  }, 60000);

  it('every battle ends within 20 minutes of game time', () => {
    for (const s of seeds) {
      const b = newBattle(s);
      runUntil(b, 1200, chaserPlayer);
      expect(b.result).not.toBeNull();
    }
  }, 60000);
});
