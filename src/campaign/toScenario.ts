// The bridge from the campaign map to the battle engine: two armies and the ground where they met
// become a Scenario; the finished Battle becomes new unit strengths for both armies.
import type { Battle } from '../sim/battle';
import { Rng } from '../sim/rng';
import type { Hill, River, Rules, Scenario, ScenarioSide, ScenarioUnit, UnitType } from '../sim/types';
import { hash, type BattleOutcome, type Campaign, type Encounter } from './campaign';
import type { Army, ArmyUnit } from './types';

const W = 1000, D = 600;
/** A campaign river this close to the meeting point runs along the battlefield. */
const RIVER_NEAR = 45;

export interface CampaignBattle {
  scenario: Scenario;
  enc: Encounter;
  /** Army ids in the order their units were added to the battle. */
  order: { army: number; count: number }[];
}

export function buildScenario(c: Campaign, enc: Encounter, rules: Rules): CampaignBattle {
  const p = c.army(enc.player)!, e = c.army(enc.enemy)!;
  const rng = new Rng(hash(c.state.turn, enc.player, enc.enemy, 77));
  const relief = c.geo.relief(enc.x, enc.z);
  const river = c.geo.riverDistance(enc.x, enc.z);
  const hasRiver = river.d < RIVER_NEAR;

  // Hills: a few gentle ones on open plains, more and higher in hill country. Keep the deployment
  // centres mostly flat so nobody starts on a cliff.
  const count = relief < 2 ? 1 + Math.floor(rng.next() * 2) : relief < 8 ? 2 + Math.floor(rng.next() * 2) : 3 + Math.floor(rng.next() * 2);
  const hills: Hill[] = [];
  for (let i = 0; i < count; i++) {
    const height = Math.min(12, 4 + rng.range(0, 3) + relief * 0.35);
    hills.push({ pos: [Math.round(rng.range(120, 880)), Math.round(rng.range(90, hasRiver ? 470 : 510))], radius: Math.round(rng.range(70, 120)), height: Math.round(height * 10) / 10 });
  }

  let riverDef: River | undefined;
  if (hasRiver) {
    // Along the south edge, wiggling, with one ford somewhere in the middle third.
    const base = 545;
    const points: [number, number][] = [];
    for (let i = 0; i <= 7; i++) points.push([-20 + i * 148.6, Math.round(base + rng.range(-14, 14))]);
    const k = 3 + Math.floor(rng.next() * 2);
    riverDef = { points, width: 24, depth: 2.6, fords: [{ pos: points[k], radius: 32 }] };
  }

  const pf = c.data.factions[p.faction], ef = c.data.factions[e.faction];
  // Keep everyone clear of the river bank.
  const maxZ = hasRiver ? 490 : 555;
  const player = side(p, pf.color, false, c.types, rng, maxZ);
  const enemy = side(e, ef.color, true, c.types, rng, maxZ);
  const place = c.names[enc.place];
  const attacking = enc.attacker === p.faction;
  const scenario: Scenario = {
    id: `campaign-${c.state.turn}-${p.id}-${e.id}`,
    name: `Battle near ${place}`,
    era: `${c.seasonLabel()} · ${hasRiver ? `on the ${river.name}` : relief > 8 ? 'hill country' : 'open plain'}`,
    disclaimer: 'A battle from the campaign map. Invented: armies, ground and outcome are not historical.',
    briefing: `${attacking ? `${p.name} has caught ${e.name}` : `${e.name} falls upon ${p.name}`} near ${place}. `
      + `Your ${p.units.length} units face ${e.units.length}. Casualties carry back to the campaign map: units you lose here stay lost, and the beaten army falls back to its nearest town.`,
    seed: hash(c.state.turn, p.id, e.id),
    player: p.faction,
    rules,
    terrain: { size: [W, D], hills, river: riverDef },
    sides: { [p.faction]: player, [e.faction]: enemy },
  };
  return { scenario, enc, order: [{ army: p.id, count: p.units.length }, { army: e.id, count: e.units.length }] };
}

type Role = 'front' | 'line' | 'wing' | 'general';

function role(t: UnitType, u: ArmyUnit): Role {
  if (u.general) return 'general';
  if (t.category === 'cavalry') return t.ranged ? 'front' : 'wing';
  if (t.category === 'missile' || t.category === 'skirmisher' || t.category === 'elephant') return 'front';
  return 'line';
}

/** Deploy an army in the usual order: missiles and elephants forward, foot behind, horse on the wings. */
function side(a: Army, color: string, isEnemy: boolean, types: Record<string, UnitType>, rng: Rng, maxZ: number): ScenarioSide {
  const clampZ = (z: number) => Math.max(45, Math.min(maxZ, z));
  const dir = isEnemy ? -1 : 1;
  const front = isEnemy ? 690 : 310;
  const at = (dx: number) => front - dir * dx;
  const facing = isEnemy ? 180 : 0;
  const units: ScenarioUnit[] = a.units.map((u) => ({ type: u.type, name: u.name, pos: [0, 0], facing, strength: round(u.strength), general: u.general || undefined }));
  const roles = a.units.map((u) => role(types[u.type], u));
  const place = (idx: number[], dx: number, spacing: number, sort?: (i: number) => number) => {
    if (sort) idx.sort((i, j) => sort(i) - sort(j));
    // Fill from the centre outward so the line stays balanced.
    const even = idx.length % 2 === 0;
    const slots = idx.map((_, k) => (k % 2 === 0 ? 1 : -1) * (even ? Math.floor(k / 2) + 0.5 : Math.ceil(k / 2)));
    idx.forEach((i, k) => (units[i].pos = [at(dx), clampZ(300 + slots[k] * spacing)]));
    return (idx.length * spacing) / 2;
  };
  const of = (r: Role) => roles.flatMap((x, i) => (x === r ? [i] : []));
  const frontIdx = of('front'), lineIdx = of('line'), wingIdx = of('wing'), genIdx = of('general');
  // Elephants in the centre of the front line, missiles outside them.
  const half = Math.max(
    place(frontIdx.slice(0, 8), 0, 62, (i) => (types[a.units[i].type].category === 'elephant' ? 0 : 1)),
    place(lineIdx.slice(0, 8), 42, 64),
  );
  // Overflow beyond eight a row stands in a second rank.
  place(frontIdx.slice(8), 80, 62);
  place(lineIdx.slice(8), 110, 64);
  wingIdx.forEach((i, k) => {
    const s = k % 2 === 0 ? -1 : 1;
    // Further horse on the same wing stands behind the first.
    units[i].pos = [at((isEnemy ? 70 : 45) + Math.floor(k / 2) * 45), clampZ(300 + s * Math.min(250, half + 50))];
    if (isEnemy && wingIdx.length > 1) units[i].reserve = true;
  });
  genIdx.forEach((i, k) => {
    units[i].pos = [at(isEnemy ? 140 : 110), clampZ(300 + k * 50)];
    if (!isEnemy) units[i].reserve = true;
  });
  // A little jitter so every battle doesn't open on the same parade-ground line.
  for (const u of units) u.pos = [Math.round(u.pos[0] + rng.range(-6, 6)), Math.round(clampZ(u.pos[1] + rng.range(-5, 5)))];
  return {
    name: a.name,
    color,
    ai: isEnemy || undefined,
    rearX: isEnemy ? W : 0,
    deployZone: isEnemy ? [670, 30, 980, 570] : [20, 30, 330, 570],
    objectives: isEnemy
      ? [{ size: 'big', pos: [945, 300] }, { size: 'small', pos: [690, Math.round(rng.range(150, 450))] }]
      : [{ size: 'big', pos: [110, 300] }, { size: 'small', pos: [390, Math.round(rng.range(150, 450))] }],
    units,
  };
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * Read the finished battle back: surviving units keep the HP they have; units that shattered or
 * deserted come back as a fraction of stragglers; destroyed units are gone.
 */
export function battleOutcome(cb: CampaignBattle, b: Battle): BattleOutcome {
  const strengths = new Map<number, number[]>();
  let id = 0;
  for (const { army, count } of cb.order) {
    const s: number[] = [];
    for (let k = 0; k < count; k++, id++) {
      const u = b.units[id];
      const frac = u.hp / u.type.hp;
      s.push(u.alive ? frac : u.status === 'destroyed' ? 0 : frac * 0.4);
    }
    strengths.set(army, s);
  }
  return { winner: b.result?.winner ?? null, strengths };
}
