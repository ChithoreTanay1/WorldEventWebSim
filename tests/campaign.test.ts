import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ARMY_CAP, Campaign, CONTACT, RECRUIT_SLOTS, type Encounter } from '../src/campaign/campaign';
import { battleOutcome, buildScenario } from '../src/campaign/toScenario';
import type { CampaignData } from '../src/campaign/types';
import { Battle } from '../src/sim/battle';
import { loadForms, loadScenario, loadTypes } from './helpers';
import { goodPlayer } from './players';

const data: CampaignData = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'campaign', 'north-india.json'), 'utf8'));
const types = loadTypes();
const forms = loadForms();

function fresh(): Campaign {
  const c = new Campaign(data, types, Campaign.fresh(data));
  c.prepareTurn();
  return c;
}

/** Run one full campaign turn, auto-resolving every battle. */
function turn(c: Campaign) {
  c.beginMovement();
  for (let i = 0; i < 2000 && c.stepMovement(3); i++);
  for (const enc of c.encounters) if (c.army(enc.player) && c.army(enc.enemy)) c.applyOutcome(enc, c.autoResolve(enc));
  c.finishTurn();
}

describe('campaign data', () => {
  it('references real units, settlements and factions', () => {
    const ids = new Set(data.settlements.map((s) => s.id));
    for (const [a, b] of data.roads) expect(ids.has(a) && ids.has(b)).toBe(true);
    for (const a of [...data.armies, ...data.reinforcements]) {
      expect(data.factions[a.faction]).toBeDefined();
      for (const u of a.units) expect(types[u.type], u.type).toBeDefined();
    }
    for (const f of Object.values(data.factions)) expect(ids.has(f.capital)).toBe(true);
  });

  it('every settlement is reachable by road', () => {
    const c = fresh();
    const { dist } = c.search(c.armiesOf('gupta')[0]);
    expect(dist.size).toBe(data.settlements.length);
  });
});

describe('campaign movement', () => {
  it('marches along the road and stops at the destination', () => {
    const c = fresh();
    const a = c.armiesOf('gupta').find((x) => x.from === 'ujjayini')!;
    expect(c.setDestination(a, 'vidisha')).toBe(true);
    expect(a.to).toBe('vidisha');
    for (let i = 0; i < 500 && c.stepMovement(3); i++);
    // 164 road units at 150 a turn: still on the road after one turn.
    expect(a.to).toBe('vidisha');
    expect(a.moveLeft).toBe(0);
    c.finishTurn();
    for (let i = 0; i < 500 && c.stepMovement(3); i++);
    expect(a.from).toBe('vidisha');
    expect(a.to).toBeNull();
    expect(a.marching).toBe(false);
  });

  it('turning back mid-road reverses along the same road', () => {
    const c = fresh();
    const a = c.armiesOf('gupta').find((x) => x.from === 'ujjayini')!;
    c.setDestination(a, 'vidisha');
    c.stepMovement(60);
    const before = c.armyPos(a);
    c.setDestination(a, 'ujjayini');
    expect(a.to).toBe('ujjayini');
    const after = c.armyPos(a);
    expect(Math.hypot(before.x - after.x, before.z - after.z)).toBeLessThan(1e-6);
  });

  it('takes an undefended enemy town', () => {
    const c = fresh();
    const a = c.armiesOf('gupta')[0];
    c.state.armies = c.state.armies.filter((x) => x.faction === 'gupta');
    c.state.owners.mathura = 'huna';
    a.from = 'sthanvishvara';
    c.setDestination(a, 'mathura');
    for (let t = 0; t < 3 && c.state.owners.mathura === 'huna'; t++) {
      for (let i = 0; i < 500 && c.stepMovement(3); i++);
      c.finishTurn();
    }
    expect(c.state.owners.mathura).toBe('gupta');
  });

  it('hostile armies that meet stop and produce an encounter', () => {
    const c = fresh();
    const g = c.armiesOf('gupta')[0];
    const h = c.armiesOf('huna')[0];
    g.from = 'mathura';
    h.from = 'ahichchhatra';
    c.setDestination(g, 'ahichchhatra');
    c.setDestination(h, 'mathura');
    for (let i = 0; i < 500 && c.stepMovement(3); i++);
    expect(c.encounters.length).toBe(1);
    const p = c.armyPos(g), q = c.armyPos(h);
    expect(Math.hypot(p.x - q.x, p.z - q.z)).toBeLessThan(CONTACT);
    expect(g.marching || h.marching).toBe(false);
  });
});

describe('campaign turns', () => {
  it('thirty auto-resolved turns stay consistent', () => {
    const c = fresh();
    for (let t = 0; t < 30 && !c.state.winner; t++) {
      turn(c);
      for (const a of c.armies) {
        expect(a.units.length).toBeGreaterThan(0);
        for (const u of a.units) expect(u.strength).toBeGreaterThan(0);
        const p = c.armyPos(a);
        expect(Number.isFinite(p.x) && Number.isFinite(p.z)).toBe(true);
      }
    }
    expect(c.state.turn).toBeGreaterThan(0);
  });

  it('the AI marches on Gupta lands when left alone', () => {
    const c = fresh();
    for (let t = 0; t < 12; t++) turn(c);
    const huna = Object.values(c.state.owners).filter((o) => o === 'huna').length;
    expect(huna).toBeGreaterThan(4);
  });
});

describe('campaign battles', () => {
  function encounterAt(c: Campaign, place: string): Encounter {
    const p = c.armiesOf('gupta')[0], e = c.armiesOf('huna')[0];
    const pos = c.pos[place];
    return { player: p.id, enemy: e.id, attacker: 'gupta', x: pos.x, z: pos.z, place };
  }

  it('generated scenarios build valid battles, on a river and inland', () => {
    const c = fresh();
    const rules = loadScenario().rules;
    for (const place of ['prayaga', 'vidisha', 'sakala', 'purushapura']) {
      const cb = buildScenario(c, encounterAt(c, place), rules);
      const b = new Battle(cb.scenario, types, forms);
      expect(b.units.length).toBe(c.armiesOf('gupta')[0].units.length + c.armiesOf('huna')[0].units.length);
      for (const [id, s] of Object.entries(cb.scenario.sides)) {
        const [x0, z0, x1, z1] = s.deployZone;
        for (const u of s.units) {
          expect(u.pos[0] >= x0 && u.pos[0] <= x1 && u.pos[1] >= z0 && u.pos[1] <= z1, `${id} ${u.name} ${u.pos}`).toBe(true);
          expect(b.terrain.inWater(u.pos[0], u.pos[1])).toBe(false);
        }
      }
    }
    expect(buildScenario(c, encounterAt(c, 'prayaga'), rules).scenario.terrain.river).toBeDefined();
    expect(buildScenario(c, encounterAt(c, 'vidisha'), rules).scenario.terrain.river).toBeUndefined();
  });

  it('a fought battle carries casualties back and the loser falls back', () => {
    const c = fresh();
    const enc = encounterAt(c, 'mathura');
    const cb = buildScenario(c, enc, loadScenario().rules);
    const b = new Battle(cb.scenario, types, forms);
    b.endTurn();
    while (!b.result && b.battleTurn() <= 40) {
      goodPlayer(b);
      b.resolveTurn();
    }
    expect(b.result).not.toBeNull();
    const out = battleOutcome(cb, b);
    expect(out.strengths.get(enc.player)!.length).toBe(c.army(enc.player)!.units.length);
    const before = c.power(c.army(enc.player)!) + c.power(c.army(enc.enemy)!);
    c.applyOutcome(enc, out);
    const after = c.armies.filter((a) => a.id === enc.player || a.id === enc.enemy).reduce((s, a) => s + c.power(a), 0);
    expect(after).toBeLessThan(before);
  }, 60000);
});

describe('recruiting', () => {
  it('any unit is ready after one turn and joins the army resting in the town', () => {
    const c = fresh();
    const a = c.armiesOf('gupta').find((x) => x.from === 'ujjayini')!;
    const n = a.units.length;
    for (const type of data.factions.gupta.recruits) {
      expect(c.queueRecruit('gupta', 'ujjayini', type)).toBe(true);
      c.finishTurn();
      expect(a.units[a.units.length - 1].type).toBe(type);
      expect(a.units[a.units.length - 1].strength).toBe(1);
    }
    expect(a.units.length).toBe(n + data.factions.gupta.recruits.length);
  });

  it('ten slots per town per turn, any mix of units, all ready next turn', () => {
    const c = fresh();
    const roster = data.factions.gupta.recruits;
    for (let i = 0; i < RECRUIT_SLOTS; i++) expect(c.queueRecruit('gupta', 'varanasi', roster[i % roster.length])).toBe(true);
    expect(c.queueRecruit('gupta', 'varanasi', 'archers')).toBe(false);
    expect(c.queueRecruit('gupta', 'prayaga', 'archers')).toBe(true);
    c.cancelRecruit('varanasi', 0);
    expect(c.recruitsAt('varanasi').length).toBe(RECRUIT_SLOTS - 1);
    expect(c.recruitsAt('varanasi')[0].type).toBe(roster[1]);
    c.finishTurn();
    const raised = c.armiesOf('gupta').filter((a) => a.from === 'varanasi').reduce((s, a) => s + a.units.length, 0);
    expect(raised).toBe(RECRUIT_SLOTS - 1);
  });

  it('recruits fill the resting army to its cap, then start a new levy', () => {
    const c = fresh();
    const a = c.armiesOf('gupta').find((x) => x.from === 'sthanvishvara')!;
    const room = ARMY_CAP - a.units.length;
    for (let i = 0; i < RECRUIT_SLOTS; i++) c.queueRecruit('gupta', 'sthanvishvara', 'archers');
    c.finishTurn();
    expect(a.units.length).toBe(ARMY_CAP);
    const levy = c.armiesOf('gupta').find((x) => x !== a && x.from === 'sthanvishvara')!;
    expect(levy.units.length).toBe(RECRUIT_SLOTS - room);
  });

  it('a town with no army raises a new levy; enemy towns and other rosters are refused', () => {
    const c = fresh();
    const before = c.armiesOf('gupta').length;
    expect(c.queueRecruit('gupta', 'varanasi', 'archers')).toBe(true);
    expect(c.queueRecruit('gupta', 'sakala', 'archers')).toBe(false);
    expect(c.queueRecruit('gupta', 'mathura', 'horse-archers')).toBe(false);
    c.finishTurn();
    const levy = c.armiesOf('gupta').find((a) => a.from === 'varanasi')!;
    expect(c.armiesOf('gupta').length).toBe(before + 1);
    expect(levy.units.map((u) => u.type)).toEqual(['archers']);
    expect(levy.moveLeft).toBeGreaterThan(0);
  });

  it('recruits are lost if the town falls first', () => {
    const c = fresh();
    c.queueRecruit('gupta', 'mathura', 'archers');
    c.state.owners.mathura = 'huna';
    const before = c.armies.reduce((s, a) => s + a.units.length, 0);
    c.finishTurn();
    expect(c.armies.reduce((s, a) => s + a.units.length, 0)).toBe(before);
  });

  it('the AI recruits too', () => {
    const c = fresh();
    const host = c.armiesOf('huna').reduce((s, a) => s + a.units.length, 0);
    for (let t = 0; t < 4; t++) turn(c);
    expect(c.armiesOf('huna').reduce((s, a) => s + a.units.length, 0)).toBeGreaterThan(host);
  });
});

describe('replenishing', () => {
  it('an army recovers in a town it has just captured', () => {
    const c = fresh();
    c.state.armies = c.state.armies.filter((x) => x.faction === 'gupta');
    const a = c.armiesOf('gupta')[0];
    a.from = 'sthanvishvara';
    c.state.owners.mathura = 'huna';
    for (const u of a.units) u.strength = 0.5;
    c.setDestination(a, 'mathura');
    for (let t = 0; t < 3 && c.state.owners.mathura === 'huna'; t++) {
      for (let i = 0; i < 500 && c.stepMovement(3); i++);
      c.finishTurn();
    }
    expect(a.from).toBe('mathura');
    expect(a.units.every((u) => u.strength > 0.5)).toBe(true);
  });
});

describe('split and merge', () => {
  it('splits picked units into a detachment and merges them back', () => {
    const c = fresh();
    const a = c.armiesOf('gupta')[0];
    const names = a.units.map((u) => u.name);
    const b = c.split(a, [0, 2, 4])!;
    expect(b.units.map((u) => u.name)).toEqual([names[0], names[2], names[4]]);
    expect(a.units.length).toBe(names.length - 3);
    expect(c.together(a, b)).toBe(true);
    expect(c.split(a, a.units.map((_, i) => i))).toBeNull();
    expect(c.split(a, [])).toBeNull();
    expect(c.merge(a, b)).toBe(true);
    expect(c.army(b.id)).toBeUndefined();
    expect(a.units.map((u) => u.name).sort()).toEqual([...names].sort());
  });

  it('a detachment can march off on its own', () => {
    const c = fresh();
    const a = c.armiesOf('gupta').find((x) => x.from === 'ujjayini')!;
    const b = c.split(a, [0])!;
    c.setDestination(b, 'vidisha');
    for (let i = 0; i < 500 && c.stepMovement(3); i++);
    expect(a.from).toBe('ujjayini');
    expect(a.to).toBeNull();
    expect(c.together(a, b)).toBe(false);
    expect(c.canMerge(a, b)).not.toBeNull();
  });

  it('merging respects the army cap and keeps the lower movement left', () => {
    const c = fresh();
    const a = c.armiesOf('gupta')[0];
    const b = c.split(a, [0])!;
    b.moveLeft = 20;
    expect(c.merge(a, b)).toBe(true);
    expect(a.moveLeft).toBe(20);
    const big = c.split(a, [0])!;
    while (a.units.length + big.units.length <= ARMY_CAP) a.units.push({ ...a.units[0] });
    expect(c.canMerge(a, big)).toMatch(/units/);
    expect(c.merge(a, big)).toBe(false);
  });
});
