import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Campaign } from '../src/campaign/campaign';
import { buildScenario } from '../src/campaign/toScenario';
import type { CampaignData } from '../src/campaign/types';
import { Battle } from '../src/sim/battle';
import { loadForms, loadScenario, loadTypes } from './helpers';

const dir = join(__dirname, '..', 'data', 'campaign');
const all: CampaignData[] = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
const data = all.find((d) => d.id === 'rise-of-the-guptas-319')!;
const types = loadTypes();

function fresh(d = data): Campaign {
  const c = new Campaign(d, types, Campaign.fresh(d));
  c.prepareTurn();
  return c;
}

function turn(c: Campaign) {
  c.beginMovement();
  for (let i = 0; i < 3000 && c.stepMovement(3); i++);
  for (const enc of c.encounters) if (c.army(enc.player) && c.army(enc.enemy)) c.applyOutcome(enc, c.autoResolve(enc));
  c.finishTurn();
}

describe('every campaign file', () => {
  for (const d of all) {
    it(`${d.id}: references real units, towns and factions, and every town is reachable`, () => {
      const ids = new Set(d.settlements.map((s) => s.id));
      for (const [a, b] of d.roads) expect(ids.has(a) && ids.has(b), `${a}-${b}`).toBe(true);
      for (const s of d.settlements) expect(d.factions[s.owner], s.id).toBeDefined();
      for (const f of Object.values(d.factions)) {
        expect(ids.has(f.capital), f.capital).toBe(true);
        for (const t of f.recruits) expect(types[t], t).toBeDefined();
      }
      for (const a of [...d.armies, ...d.reinforcements]) {
        expect(d.factions[a.faction], a.faction).toBeDefined();
        for (const u of a.units) expect(types[u.type], u.type).toBeDefined();
      }
      for (const [a, b] of d.alliances ?? []) expect(d.factions[a] && d.factions[b]).toBeTruthy();
      const c = fresh(d);
      expect(c.search(c.armiesOf(d.player)[0]).dist.size).toBe(d.settlements.length);
    });
  }
});

describe('the rise of the Guptas', () => {
  it('starts in Magadha with Pataliputra as the capital and the Licchavis as allies', () => {
    const c = fresh();
    expect(data.factions.gupta.capital).toBe('pataliputra');
    expect(c.state.owners.pataliputra).toBe('gupta');
    expect(c.allied('gupta', 'licchavi')).toBe(true);
    expect(c.allied('gupta', 'naga')).toBe(false);
    expect(c.rivals()).not.toContain('licchavi');
    expect(c.rivals().length).toBe(Object.keys(data.factions).length - 2);
  });

  it('allies neither fight nor take each other\'s towns', () => {
    const c = fresh();
    c.state.armies = c.state.armies.filter((a) => a.faction === 'gupta' || a.faction === 'licchavi');
    const l = c.armiesOf('licchavi')[0];
    const g = c.armiesOf('gupta')[0];
    c.setDestination(l, 'varanasi');
    c.setDestination(g, 'mithila');
    for (let t = 0; t < 4; t++) {
      for (let i = 0; i < 1000 && c.stepMovement(3); i++);
      expect(c.encounters.length).toBe(0);
      c.finishTurn();
    }
    expect(c.state.owners.varanasi).toBe('gupta');
    expect(c.state.owners.mithila).toBe('licchavi');
  });

  it('rival realms fight each other, settled without asking the player', () => {
    const c = fresh();
    const n = c.armiesOf('naga')[0], a = c.armiesOf('ahichchhatra')[0];
    c.state.armies = [n, a];
    n.from = 'mathura';
    a.from = 'ahichchhatra';
    c.setDestination(n, 'ahichchhatra');
    c.setDestination(a, 'mathura');
    for (let i = 0; i < 1000 && c.stepMovement(3); i++);
    expect(c.encounters.length).toBe(1);
    expect(c.encounters[0].ai).toBe(true);
  });

  it('wins when every rival capital is held by you or an ally', () => {
    const c = fresh();
    for (const f of c.rivals()) c.state.owners[data.factions[f].capital] = f === 'kushan' ? 'licchavi' : 'gupta';
    c.finishTurn();
    expect(c.state.winner).toBe('gupta');
  });

  it('loses when Pataliputra falls', () => {
    const c = fresh();
    c.state.owners.pataliputra = 'vanga';
    c.finishTurn();
    expect(c.state.winner).toBe('vanga');
  });

  it('a realm with no towns and no armies is announced as fallen once', () => {
    const c = fresh();
    c.state.armies = c.state.armies.filter((a) => a.faction !== 'madraka');
    c.state.owners.sakala = 'yaudheya';
    c.finishTurn();
    c.finishTurn();
    expect(c.state.fallen).toContain('madraka');
    expect(c.state.log.filter((l) => l.text.includes('Madraka Republic is no more')).length).toBe(1);
  });

  it('forty turns of every realm at war stay consistent', () => {
    const c = fresh();
    for (let t = 0; t < 40 && !c.state.winner; t++) {
      turn(c);
      for (const a of c.armies) {
        expect(a.units.length).toBeGreaterThan(0);
        expect(a.units.length).toBeLessThanOrEqual(16);
        const p = c.armyPos(a);
        expect(Number.isFinite(p.x) && Number.isFinite(p.z)).toBe(true);
      }
      for (const o of Object.values(c.state.owners)) expect(data.factions[o]).toBeDefined();
    }
    // Rival realms do take towns from one another.
    const moved = data.settlements.filter((s) => c.state.owners[s.id] !== s.owner).length;
    expect(moved).toBeGreaterThan(0);
  });

  it('a battle against any rival builds a valid battlefield with that realm\'s colours', () => {
    const c = fresh();
    const g = c.armiesOf('gupta')[0];
    for (const f of c.rivals()) {
      const e = c.armiesOf(f)[0];
      if (!e) continue;
      const pos = c.armyPos(e);
      const cb = buildScenario(c, { player: g.id, enemy: e.id, attacker: 'gupta', x: pos.x, z: pos.z, place: e.from }, loadScenario().rules);
      expect(cb.scenario.sides[f].color).toBe(data.factions[f].color);
      expect(() => new Battle(cb.scenario, types, loadForms())).not.toThrow();
    }
  });
});
