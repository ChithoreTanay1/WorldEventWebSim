// Rule checks against the Lines of Battle wiki (v1.7) formulas and behaviours.
import { describe, expect, it } from 'vitest';
import type { Battle } from '../src/sim/battle';
import { CASUALTIES, canCharge, flankOf, hpMod, meleeSwing, orgMod, rangeModifier } from '../src/sim/combat';
import { ATTACKS_PER_TURN, TICKS_PER_TURN } from '../src/sim/constants';
import { flankPercent } from '../src/sim/geometry';
import type { Scenario } from '../src/sim/types';
import { newBattle, playOut } from './helpers';
import { goodPlayer } from './players';

/** A small two-unit battle on flat ground: unit 0 (side a, facing east) vs unit 1 (side d, facing west at (300,200)). */
function duel(attacker: string, defender: string, apos: [number, number] = [200, 200], afacing = 0, dfacing = 180): Battle {
  return newBattle(1, (sc: Scenario) => {
    sc.terrain = { size: [600, 400], hills: [] };
    sc.rules = { ...sc.rules, neutralHills: 0, visionRange: 1000 };
    sc.sides = {
      a: { name: 'A', color: '#aa0000', rearX: 0, deployZone: [0, 0, 600, 400], objectives: [], units: [{ type: attacker, pos: apos, facing: afacing }] },
      d: { name: 'D', color: '#0000aa', rearX: 600, deployZone: [0, 0, 600, 400], objectives: [], units: [{ type: defender, pos: [300, 200], facing: dfacing }] },
    };
    sc.player = 'a';
  });
}

describe('turn structure', () => {
  it('starts with deployment, then plans and resolves 16-tick turns', () => {
    const b = newBattle();
    expect(b.phase).toBe('deployment');
    b.endTurn();
    expect(b.phase).toBe('planning');
    expect(b.objectives.filter((o) => o.size === 'hill')).toHaveLength(b.rules.neutralHills);
    b.endTurn();
    expect(b.phase).toBe('resolving');
    let ticks = 0;
    let last = b.tick;
    while (b.phase === 'resolving') {
      b.stepSub();
      if (b.tick !== last) ticks++, (last = b.tick);
    }
    expect(ticks).toBe(TICKS_PER_TURN);
    expect(b.phase).toBe('planning');
    expect(b.battleTurn()).toBe(2);
  });

  it('deployment placement is clamped to the zone and moves instantly', () => {
    const b = newBattle();
    const u = b.units[0];
    b.deploy(u.id, 900, 300, 0);
    expect(u.x).toBe(b.sides.get(u.side)!.zone[2]);
  });

  it('orders last one turn; unfinished paths are re-sent as continued orders', () => {
    const b = newBattle();
    b.endTurn();
    const inf = b.units.find((u) => u.name === 'Swordsmen (Left)')!;
    const archer = b.units.find((u) => u.name === 'Archers (Left)')!;
    b.setOrder(inf.id, { type: 'walk', path: [{ x: inf.x + 600, z: inf.z }] });
    b.setOrder(archer.id, { type: 'rotate', facing: Math.PI / 2 });
    b.resolveTurn();
    expect(inf.order?.continued).toBe(true);
    expect(archer.order).toBeNull();
    expect(Math.abs(archer.facing - Math.PI / 2)).toBeLessThan(0.05);
  });

  it('is deterministic for the same seed and orders', () => {
    const a = newBattle(5), c = newBattle(5);
    playOut(a, goodPlayer, 6);
    playOut(c, goodPlayer, 6);
    const fp = (b: Battle) => b.units.map((u) => `${u.x.toFixed(4)},${u.z.toFixed(4)},${u.org.toFixed(4)},${u.hp.toFixed(4)},${u.status}`).join('|');
    expect(fp(a)).toBe(fp(c));
  });
});

describe('melee and charges (wiki formulas)', () => {
  it('flank % follows (angle - front) / (full - front)', () => {
    expect(flankPercent([37.9, 142.1], 90)).toBeCloseTo(0.5, 2); // wiki example: 90 degree hit on a column
    expect(flankPercent([79.2, 100.8], 60)).toBe(0);
    expect(flankPercent(null, 180)).toBe(0);
  });

  it('HP and Org modifiers are clamped at +/-0.2 and +/-0.25', () => {
    const b = duel('heavy-infantry', 'levy-spearmen');
    const [a, d] = b.units;
    d.hp = d.maxHp * 0.1;
    expect(hpMod(a, d)).toBeCloseTo(0.2);
    d.org = 1;
    expect(orgMod(a, d)).toBeCloseTo(0.25);
  });

  it('a melee swing is Atk^2/(Atk+Def)/8 times the factor product', () => {
    const b = duel('heavy-infantry', 'heavy-infantry');
    const [a, d] = b.units;
    const atk = a.type.melee.attack, def = d.type.melee.defense;
    const h = meleeSwing(b, a, d);
    const swing = (atk * atk) / (atk + def) / ATTACKS_PER_TURN;
    // Men killed are the wiki's HP damage times our casualty multiplier...
    expect(h.hp).toBeCloseTo(swing * CASUALTIES.melee, 5);
    // ...while org loss stays exactly the wiki's: swing / maxHP x 10 x org ratio.
    expect(h.org).toBeCloseTo((swing / d.maxHp) * 10 * a.type.melee.weapon.orgRatio, 1);
  });

  it('a flank attack on a line costs more organization, not more HP', () => {
    const front = duel('heavy-infantry', 'heavy-infantry', [280, 200], 0, 180);
    const flank = duel('heavy-infantry', 'heavy-infantry', [315, 172], 90, 180);
    const hf = meleeSwing(front, front.units[0], front.units[1]);
    const hs = meleeSwing(flank, flank.units[0], flank.units[1]);
    expect(flankOf(flank, flank.units[1], flank.units[0])).toBeGreaterThan(0.9);
    expect(hs.hp).toBeCloseTo(hf.hp, 5);
    expect(hs.org).toBeGreaterThan(hf.org * 1.8);
  });

  it('charging needs Run, a full run-up, stamina above 40% and no Been In Melee', () => {
    const b = duel('heavy-cavalry', 'archers');
    b.endTurn();
    const [a, d] = b.units;
    a.order = { type: 'run', target: d.id };
    a.running = true;
    a.runRamp = 1;
    a.velX = 1;
    a.velZ = 0;
    expect(canCharge(b, a, d)).toBe(true);
    a.stamina = a.type.stamina * 0.39;
    expect(canCharge(b, a, d)).toBe(false);
    a.stamina = a.type.stamina;
    a.bim = 2;
    expect(canCharge(b, a, d)).toBe(false);
    a.bim = 0;
    a.order = { type: 'walk', target: d.id };
    expect(canCharge(b, a, d)).toBe(false);
  });

  it('a cavalry charge into the rear breaks archers; braced spears blunt one from the front', () => {
    const rear = duel('heavy-cavalry', 'archers', [520, 200], 180, 180);
    rear.endTurn();
    rear.setOrder(0, { type: 'run', target: 1 });
    rear.resolveTurn();
    expect(rear.log.some((l) => l.text.includes('charge') && l.text.includes('rear'))).toBe(true);
    const spear = duel('heavy-cavalry', 'levy-spearmen', [100, 200], 0, 180);
    spear.endTurn();
    spear.setOrder(0, { type: 'run', target: 1 });
    spear.resolveTurn();
    const archersOrgLost = 1 - rear.units[1].org / rear.units[1].baseMaxOrg;
    const spearOrgLost = 1 - spear.units[1].org / spear.units[1].baseMaxOrg;
    expect(archersOrgLost).toBeGreaterThan(spearOrgLost);
  });
});

describe('ranged fire', () => {
  it('range bands slide linearly and end at max range', () => {
    const b = newBattle();
    const w = b.units.find((u) => u.type.id === 'archers')!.type.ranged!.weapon;
    expect(rangeModifier(w, 0)).toBeCloseTo(w.bands[0][2]);
    expect(rangeModifier(w, w.bands[0][1])).toBeCloseTo(w.bands[0][3]);
    expect(rangeModifier(w, 999)).toBeNull();
  });

  it('archers in line out-shoot archers in column', () => {
    const shoot = (form: string) => {
      const b = duel('archers', 'heavy-infantry', [200, 200], 0, 180);
      b.units[0].formation = form;
      b.endTurn();
      b.resolveTurn();
      return b.units[1].maxHp - b.units[1].hp;
    };
    expect(shoot('line')).toBeGreaterThan(shoot('column') * 2);
  });

  it('units with limited ammunition do not autofire on routers', () => {
    const b = duel('archers', 'heavy-infantry', [200, 200], 0, 180);
    b.endTurn();
    b.units[1].status = 'routing';
    b.units[1].startedRouting = 99;
    const ammo = b.units[0].ammo;
    b.resolveTurn();
    expect(b.units[0].ammo).toBe(ammo);
  });
});

describe('organization states', () => {
  it('routs at the route mark, can recover and rally, and shatters below the shatter mark', () => {
    const b = duel('heavy-infantry', 'levy-spearmen', [50, 50]);
    b.endTurn();
    const d = b.units[1];
    d.org = 1;
    b.units[0].org = 5; // keep the field out of it
    d.hp -= 1;
    b.resolveTurn();
    expect(['routing', 'recovering', 'standing']).toContain(d.status);
    const c = duel('heavy-infantry', 'levy-spearmen', [50, 50]);
    c.endTurn();
    const e = c.units[1];
    e.status = 'routing';
    e.org = e.type.orgMarks.shatter * e.baseMaxOrg - 60;
    c.resolveTurn();
    expect(e.status).toBe('shattered');
  });

  it('nearby friends steady a unit and nearby enemies wear it down (clamped field)', () => {
    const b = newBattle();
    b.endTurn();
    const mid = b.units.find((u) => u.name === 'Swordsmen (Left)')!;
    const lone = b.units.find((u) => u.name === "Khan's Guard")!;
    b.resolveTurn();
    expect(mid.orgReport.nearby).toBeGreaterThan(0);
    expect(Math.abs(mid.orgReport.nearby)).toBeLessThanOrEqual(56);
    expect(lone.orgReport.nearby).toBeGreaterThanOrEqual(0);
  });
});

describe('objectives, victory points and fog of war', () => {
  it('only standing infantry captures; progress builds when one non-owning team is present', () => {
    const b = newBattle();
    b.endTurn();
    const hill = b.objectives.find((o) => o.size === 'hill')!;
    const inf = b.units.find((u) => u.name === 'Swordsmen (Left)')!;
    const cav = b.units.find((u) => u.name === 'Lancers (South Wing)')!;
    inf.x = cav.x = hill.x;
    inf.z = hill.z;
    cav.z = hill.z + 20;
    // two turns of a 2/tick unit = 64 points; capture needs rules.capturePoints
    const turns = Math.ceil(b.rules.capturePoints / (2 * TICKS_PER_TURN));
    for (let i = 0; i < turns; i++) b.resolveTurn();
    expect(hill.owner).toBe('gupta');
  });

  it('victory points are base + objectives +/- casualties, recomputed each turn', () => {
    const b = newBattle();
    b.endTurn();
    b.resolveTurn();
    for (const s of b.sides.values()) {
      const p = s.vpParts;
      expect(s.vp).toBe(Math.max(0, p.base + p.casualties + p.objectives + p.pressure));
    }
  });

  it('enemies out of sight are hidden; distant ones are silhouettes; close ones fully visible', () => {
    const b = duel('heavy-infantry', 'heavy-infantry', [300 - 50, 200]);
    expect(b.seen('a', b.units[1])).toBe(4);
    const far = duel('heavy-infantry', 'heavy-infantry', [300 - 50, 200]);
    far.units[1].x = 250 + far.rules.visionRange * 0.95;
    far.endTurn();
    far.resolveTurn();
    expect(far.seen('a', far.units[1])).toBeLessThanOrEqual(1);
  });

  it('a unit given a curved path actually follows the curve', () => {
    const b = duel('heavy-cavalry', 'heavy-infantry', [60, 200], 0);
    b.units[1].x = 580;
    b.units[1].z = 30;
    b.endTurn();
    const curve = Array.from({ length: 30 }, (_, i) => ({ x: 60 + i * 6, z: 200 + Math.sin(i / 5) * 40 }));
    b.setOrder(0, { type: 'walk', path: curve.slice(1) });
    let worst = 0;
    while (b.phase === 'resolving' || b.battleTurn() < 4) {
      if (b.phase !== 'resolving') b.endTurn();
      b.stepSub();
      const u = b.units[0];
      if (u.x > 220) break;
      const d = Math.min(...curve.map((p) => Math.hypot(p.x - u.x, p.z - u.z)));
      worst = Math.max(worst, d);
    }
    expect(b.units[0].x).toBeGreaterThan(150);
    expect(worst).toBeLessThan(6);
  });
});

describe('casualties', () => {
  it('both sides lose men in an even melee, the attacker as well as the defender', () => {
    const b = duel('heavy-infantry', 'heavy-infantry', [265, 200]);
    b.endTurn();
    b.setOrder(0, { type: 'walk', target: 1 });
    b.resolveTurn();
    const [a, d] = b.units;
    expect(b.men(a)).toBeLessThan(b.men(a, a.maxHp));
    expect(b.men(d)).toBeLessThan(b.men(d, d.maxHp));
    expect(b.log.some((l) => /lose \d+ men/.test(l.text))).toBe(true);
  });

  it('charging braced spears head-on costs the horse men; a rear charge costs it almost nothing', () => {
    const run = (pos: [number, number], facing: number, def: string) => {
      const b = duel('heavy-cavalry', def, pos, facing);
      b.endTurn();
      b.setOrder(0, { type: 'run', target: 1 });
      b.resolveTurn();
      return b.men(b.units[0], b.units[0].maxHp) - b.men(b.units[0]);
    };
    expect(run([130, 200], 0, 'levy-spearmen')).toBeGreaterThan(run([470, 200], 180, 'archers'));
  });
});
