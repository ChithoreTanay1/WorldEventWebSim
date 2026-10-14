// Weight, dashes and quirks: heavier units hit harder, lighter ones recoil, wavering units suffer,
// a dash lands a smaller blow, and the unit quirks (arrows vs elephants, braced spears, horses fearing
// elephants, scattering skirmishers, armour against missiles) all bite.
import { describe, expect, it } from 'vitest';
import { IMPACT, armourOf, chargeImpact, rangedShot, unitQuirks, weightOf } from '../src/sim/combat';
import type { Battle } from '../src/sim/battle';
import type { Unit } from '../src/sim/unit';
import { loadTypes, newBattle } from './helpers';

const types = loadTypes();

/** Attacker of type `at` meeting defender of type `dt` head-on (both taken from a fresh battle, retyped). */
function duel(at: string, dt: string): { b: Battle; a: Unit; d: Unit } {
  const b = newBattle();
  b.endTurn();
  const d = b.units.find((u) => u.side === 'gupta')!;
  const a = b.units.find((u) => u.side !== 'gupta')!;
  (d as { type: unknown }).type = types[dt];
  (a as { type: unknown }).type = types[at];
  d.hp = types[dt].hp;
  a.hp = types[at].hp;
  (d as { maxHp: number }).maxHp = d.hp;
  (a as { maxHp: number }).maxHp = a.hp;
  d.org = types[dt].org;
  a.org = types[at].org;
  for (const u of b.units) if (u !== a && u !== d) u.x = u.z = 5;
  d.x = 500; d.z = 300; d.facing = 0;
  a.x = d.x + 20; a.z = d.z; a.facing = Math.PI;
  return { b, a, d };
}
const share = (u: Unit, org: number) => org / u.maxOrg;

describe('weight', () => {
  it('ranks elephants above horse above foot above archers, armour adding', () => {
    expect(weightOf(types['war-elephants'])).toBeGreaterThan(weightOf(types['heavy-cavalry']));
    expect(weightOf(types['heavy-cavalry'])).toBeGreaterThan(weightOf(types['heavy-infantry']));
    expect(weightOf(types['heavy-infantry'])).toBeGreaterThan(weightOf(types['archers']));
    expect(armourOf(types['heavy-infantry'])).toBe('heavy');
    expect(armourOf(types['skirmishers'])).toBe('light');
  });

  it('a heavy charge hits a light unit far harder than a heavy one', () => {
    const light = duel('heavy-cavalry', 'archers'), heavy = duel('heavy-cavalry', 'war-elephants');
    const onLight = chargeImpact(light.b, light.a, light.d).defender, onHeavy = chargeImpact(heavy.b, heavy.a, heavy.d).defender;
    expect(share(light.d, onLight.org)).toBeGreaterThan(share(heavy.d, onHeavy.org) * 2);
  });

  it('a wavering unit (low organization) takes more from the same charge', () => {
    const fresh = duel('heavy-cavalry', 'levy-spearmen'), shaken = duel('heavy-cavalry', 'levy-spearmen');
    shaken.d.org = shaken.d.maxOrg * 0.15;
    expect(chargeImpact(shaken.b, shaken.a, shaken.d).defender.hp).toBeGreaterThan(chargeImpact(fresh.b, fresh.a, fresh.d).defender.hp * 1.3);
  });

  it('a light unit crashing into a heavy one recoils, more than a heavy unit would', () => {
    const light = duel('horse-archers', 'heavy-infantry'), heavy = duel('heavy-cavalry', 'heavy-infantry');
    const l = chargeImpact(light.b, light.a, light.d, 0.6), hv = chargeImpact(heavy.b, heavy.a, heavy.d, 0.6);
    expect(share(light.a, l.attacker.org) / Math.max(1e-9, share(light.d, l.defender.org)))
      .toBeGreaterThan(share(heavy.a, hv.attacker.org) / Math.max(1e-9, share(heavy.d, hv.defender.org)));
  });

  it('a dash lands a smaller blow than a full charge, but a real one', () => {
    const x = duel('heavy-cavalry', 'archers');
    const full = chargeImpact(x.b, x.a, x.d).defender.hp;
    const dash = chargeImpact(x.b, x.a, x.d, IMPACT.dashBase + IMPACT.dashRamp * 0.5).defender.hp;
    expect(dash).toBeGreaterThan(full * 0.3);
    expect(dash).toBeLessThan(full * 0.8);
  });
});

describe('quirks', () => {
  it('massed arrows blunt an elephant charge', () => {
    const calm = duel('war-elephants', 'heavy-infantry'), shot = duel('war-elephants', 'heavy-infantry');
    shot.a.volleys = 4;
    expect(chargeImpact(shot.b, shot.a, shot.d).defender.hp).toBeLessThan(chargeImpact(calm.b, calm.a, calm.d).defender.hp * 0.4);
  });

  it('arrows madden elephants: more morale lost per volley than the same arrows on foot of equal size', () => {
    const e = duel('archers', 'war-elephants'), f = duel('archers', 'heavy-infantry');
    const he = rangedShot(e.b, e.a, e.d, 60, 1), hf = rangedShot(f.b, f.a, f.d, 60, 1);
    expect(he.org / he.hp).toBeGreaterThan((hf.org / hf.hp) * 1.4);
  });

  it('armour turns arrows: heavy foot loses fewer men than light troops to the same volley', () => {
    const heavy = duel('archers', 'heavy-infantry'), light = duel('archers', 'skirmishers');
    expect(rangedShot(heavy.b, heavy.a, heavy.d, 60, 1).hp).toBeLessThan(rangedShot(light.b, light.a, light.d, 60, 1).hp * 0.8);
  });

  it('braced spears punish horse charging their front', () => {
    const spears = duel('heavy-cavalry', 'levy-spearmen'), plain = duel('heavy-cavalry', 'levy-spearmen');
    (plain.d as { type: unknown }).type = { ...types['levy-spearmen'], melee: { ...types['levy-spearmen'].melee, antiCavalry: undefined } };
    expect(chargeImpact(spears.b, spears.a, spears.d).attacker.org).toBeGreaterThan(chargeImpact(plain.b, plain.a, plain.d).attacker.org);
  });

  it('horses fear elephants and skirmishers scatter before a charge', () => {
    const eles = duel('heavy-cavalry', 'war-elephants'), foot = duel('steppe-lancers', 'war-elephants');
    (foot.a as { type: unknown }).type = { ...types['heavy-cavalry'], category: 'infantry' };
    expect(chargeImpact(eles.b, eles.a, eles.d).defender.hp).toBeLessThan(chargeImpact(foot.b, foot.a, foot.d).defender.hp);
    const sk = duel('heavy-cavalry', 'skirmishers'), ar = duel('heavy-cavalry', 'skirmishers');
    (ar.d as { type: unknown }).type = { ...types['skirmishers'], category: 'missile' };
    expect(chargeImpact(sk.b, sk.a, sk.d).defender.hp).toBeLessThan(chargeImpact(ar.b, ar.a, ar.d).defender.hp);
  });

  it('every unit lists its quirks', () => {
    for (const t of Object.values(types)) expect(unitQuirks(t).length, t.id).toBeGreaterThan(0);
    expect(unitQuirks(types['war-elephants']).join(' ')).toMatch(/arrows/i);
  });
});
