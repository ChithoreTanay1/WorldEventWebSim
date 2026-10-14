// Campaign AI, one decision per army per turn: guard the capital when it is threatened, go home to
// recover when worn down, slip away from much stronger armies, otherwise hunt weaker armies and
// undefended towns, nearest first.
import { ARMY_CAP, dist, type Campaign } from './campaign';
import type { Army } from './types';

const THREAT_RANGE = 380;
const DANGER_RANGE = 170;

export function planAI(c: Campaign, faction: string) {
  const mine = c.armiesOf(faction).sort((a, b) => c.power(b) - c.power(a));
  const foes = c.armies.filter((a) => !c.allied(a.faction, faction));
  if (!mine.length) return;
  const capital = c.data.factions[faction].capital;
  const cap = c.pos[capital];
  let guard: Army | null = null;
  if (c.state.owners[capital] === faction && foes.some((f) => dist(c.armyPos(f), cap) < THREAT_RANGE)) {
    guard = mine.reduce((best, a) => (dist(c.armyPos(a), cap) < dist(c.armyPos(best), cap) ? a : best));
  }
  for (const a of mine) {
    if (a === guard) {
      c.setDestination(a, capital);
      continue;
    }
    const P = c.power(a);
    const here = c.armyPos(a);
    // Never march through a town held by a stronger army: route around it, or pick another target.
    const blocked = (n: string) => foes.some((f) => c.power(f) > P * 0.85 && dist(c.armyPos(f), c.pos[n]) < 60);
    const { dist: road } = c.search(a, blocked);
    const ownTowns = [...road.keys()].filter((n) => c.state.owners[n] === faction);
    const nearestOwn = (away?: { x: number; z: number }) => {
      let best: string | null = null, bd = Infinity;
      for (const n of ownTowns) {
        if (away && dist(c.pos[n], away) < dist(here, away)) continue;
        const d = road.get(n)!;
        if (d < bd) (bd = d), (best = n);
      }
      return best;
    };
    const avg = a.units.reduce((s, u) => s + u.strength, 0) / Math.max(1, a.units.length);
    if (avg < 0.5) {
      const home = nearestOwn();
      if (home) {
        c.setDestination(a, home, blocked);
        continue;
      }
    }
    const danger = foes.find((f) => c.power(f) > P * 1.3 && dist(c.armyPos(f), here) < DANGER_RANGE);
    if (danger) {
      const refuge = nearestOwn(c.armyPos(danger));
      if (refuge) {
        c.setDestination(a, refuge, blocked);
        continue;
      }
    }
    let target: string | null = null, score = Infinity;
    for (const f of foes) {
      if (c.power(f) > P * 0.85) continue;
      const node = f.to && f.progress > c.roadLen(f.from, f.to) / 2 ? f.to : f.from;
      const s = (road.get(node) ?? Infinity) * 0.8;
      if (s < score) (score = s), (target = node);
    }
    for (const s of c.data.settlements) {
      if (c.allied(c.state.owners[s.id], faction)) continue;
      const p = c.pos[s.id];
      if (foes.some((f) => c.power(f) > P * 0.7 && dist(c.armyPos(f), p) < 60)) continue;
      const sc = (road.get(s.id) ?? Infinity) - (s.id === c.data.factions[c.state.owners[s.id]]?.capital ? 150 : 0);
      if (sc < score) (score = sc), (target = s.id);
    }
    if (target) c.setDestination(a, target, blocked);
    else c.stop(a);
  }
}

/**
 * After orders: armies that stay in one of their towns this turn fill up with recruits, and armies
 * that ended up standing together join forces.
 */
export function aiMuster(c: Campaign, faction: string) {
  const roster = c.data.factions[faction].recruits;
  for (const a of c.armiesOf(faction)) {
    if (a.marching || a.to || c.recruitBlock(faction, a.from)) continue;
    // Fill the army up to strength, as many slots as the town allows.
    const room = ARMY_CAP - a.units.length - c.recruitsAt(a.from).length;
    for (let k = 0; k < room; k++) if (!c.queueRecruit(faction, a.from, roster[(c.state.turn + a.id + k) % roster.length])) break;
  }
  for (const a of c.armiesOf(faction)) {
    if (!c.army(a.id)) continue;
    for (const b of c.armiesOf(faction)) if (b !== a && c.army(b.id) && !c.canMerge(a, b) && !a.marching && !b.marching) c.merge(a, b);
  }
}
