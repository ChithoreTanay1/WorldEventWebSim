// Campaign AI. Each realm keeps a war focus: a neighbouring realm (one whose towns border its own by
// road), chosen with a lean toward the weaker, held for several turns. Then one decision per army per
// turn: guard the capital when it is threatened, go home to recover when worn down, slip away from much
// stronger armies, otherwise attack - armies and towns it can match, the war focus first.
import { ARMY_CAP, dist, hash, type Campaign } from './campaign';
import { Rng } from '../sim/rng';
import type { Army } from './types';

const THREAT_RANGE = 380;
const DANGER_RANGE = 150;
/** Fights an army will pick: its strength against the enemy army, or a town's defenders. */
const ATTACK_ARMY = 0.95;
const ATTACK_TOWN = 1.05;
/** Bonuses (map units of road) for targets of the realm's war focus, capitals and empty towns. */
const WAR_BONUS = 260;
const CAPITAL_BONUS = 150;
const EMPTY_BONUS = 60;
const WAR_TURNS = 8;

/** Total fighting power of a realm's armies. */
function realmPower(c: Campaign, faction: string): number {
  return c.armiesOf(faction).reduce((s, a) => s + c.power(a), 0);
}

/** Realms whose towns are one road away from this realm's towns. */
function neighbours(c: Campaign, faction: string): string[] {
  const out = new Set<string>();
  for (const [town, owner] of Object.entries(c.state.owners)) {
    if (owner !== faction) continue;
    for (const n of c.roadsFrom(town)) {
      const o = c.state.owners[n];
      if (o && !c.allied(o, faction)) out.add(o);
    }
  }
  return [...out];
}

/** Keep (or pick) the realm's war focus: a neighbour, preferring ones weaker than us. */
export function warFocus(c: Campaign, faction: string): string | null {
  const st = c.state;
  st.wars ??= {};
  const cur = st.wars[faction];
  const alive = (f: string) => !(st.fallen ?? []).includes(f) && (c.armiesOf(f).length > 0 || Object.values(st.owners).includes(f));
  if (cur && cur.until > st.turn && alive(cur.target) && !c.allied(cur.target, faction)) return cur.target;
  const near = neighbours(c, faction).filter(alive);
  if (!near.length) {
    delete st.wars[faction];
    return null;
  }
  const rng = new Rng(hash(st.turn, faction.length, near.length, 911));
  const mine = realmPower(c, faction) + 1;
  let best = near[0], bestScore = -Infinity;
  for (const f of near) {
    const s = (mine / (realmPower(c, f) + 1)) * (0.75 + 0.5 * rng.next());
    if (s > bestScore) (bestScore = s), (best = f);
  }
  if (best !== cur?.target) {
    const msg = `The ${c.data.factions[faction].name} turn their armies against the ${c.data.factions[best].name}.`;
    c.log(msg, best === c.player ? 'bad' : c.friendly(best) ? 'warn' : 'info');
  }
  st.wars[faction] = { target: best, until: st.turn + WAR_TURNS };
  return best;
}

export function planAI(c: Campaign, faction: string) {
  const mine = c.armiesOf(faction).sort((a, b) => c.power(b) - c.power(a));
  const foes = c.armies.filter((a) => !c.allied(a.faction, faction));
  if (!mine.length) return;
  const war = warFocus(c, faction);
  const capital = c.data.factions[faction].capital;
  const cap = c.pos[capital];
  let guard: Army | null = null;
  if (mine.length > 1 && c.state.owners[capital] === faction && foes.some((f) => dist(c.armyPos(f), cap) < THREAT_RANGE)) {
    guard = mine.reduce((best, a) => (dist(c.armyPos(a), cap) < dist(c.armyPos(best), cap) ? a : best));
  }
  // Hostile strength standing at each town (a town's defenders).
  const defence = new Map<string, number>();
  for (const s of c.data.settlements) {
    const p = c.pos[s.id];
    let d = 0;
    for (const f of foes) if (dist(c.armyPos(f), p) < 60) d += c.power(f);
    defence.set(s.id, d);
  }
  for (const a of mine) {
    if (a === guard) {
      c.setDestination(a, capital);
      continue;
    }
    const P = c.power(a);
    const here = c.armyPos(a);
    // Never march through a town held by a stronger army: route around it, or pick another target.
    const blocked = (n: string) => (defence.get(n) ?? 0) > P * 0.85;
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
    if (avg < 0.45) {
      const home = nearestOwn();
      if (home) {
        c.setDestination(a, home, blocked);
        continue;
      }
    }
    const danger = foes.find((f) => c.power(f) > P * 1.6 && dist(c.armyPos(f), here) < DANGER_RANGE);
    if (danger) {
      const refuge = nearestOwn(c.armyPos(danger));
      if (refuge) {
        c.setDestination(a, refuge, blocked);
        continue;
      }
    }
    let target: string | null = null, score = Infinity;
    for (const f of foes) {
      if (P < c.power(f) * ATTACK_ARMY) continue;
      const node = f.to && f.progress > c.roadLen(f.from, f.to) / 2 ? f.to : f.from;
      const s = (road.get(node) ?? Infinity) * 0.8 - (f.faction === war ? WAR_BONUS : 0);
      if (s < score) (score = s), (target = node);
    }
    for (const s of c.data.settlements) {
      const owner = c.state.owners[s.id];
      if (c.allied(owner, faction)) continue;
      const def = defence.get(s.id) ?? 0;
      if (def > 0 && P < def * ATTACK_TOWN) continue;
      const sc = (road.get(s.id) ?? Infinity)
        - (s.id === c.data.factions[owner]?.capital ? CAPITAL_BONUS : 0)
        - (owner === war ? WAR_BONUS : 0)
        - (def === 0 ? EMPTY_BONUS : 0);
      if (sc < score) (score = sc), (target = s.id);
    }
    // Small armies wait at home to fill up rather than wander off alone.
    if (target && a.units.length < 5 && !a.to && c.state.owners[a.from] === faction && score > 0) target = null;
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
  // Rotate through the roster (unique troops included); if one is too dear, try a cheaper one.
  const raise = (town: string, k: number): boolean => {
    for (let t = 0; t < roster.length; t++) if (c.queueRecruit(faction, town, roster[(c.state.turn + k + t) % roster.length])) return true;
    return false;
  };
  // Keep a little in the treasury for upkeep: spend only what is above two turns of it.
  const spendable = () => !c.pays(faction) || c.gold(faction) > c.upkeep(faction) * 2;
  for (const a of c.armiesOf(faction)) {
    if (a.marching || a.to || c.recruitBlock(faction, a.from)) continue;
    // Fill the army up to strength, as many slots as the town (and the treasury) allows.
    const room = ARMY_CAP - a.units.length - c.recruitsAt(a.from).length;
    for (let k = 0; k < room && spendable(); k++) if (!raise(a.from, a.id + k)) break;
  }
  // New levies: a realm with no army raises one at its capital (or any town it holds); a realm with
  // gold to spare raises more, up to an army per two towns, so treasuries don't just pile up.
  const towns = Object.keys(c.state.owners).filter((t) => c.state.owners[t] === faction);
  const cap = c.data.factions[faction].capital;
  const sites = [...(towns.includes(cap) ? [cap] : []), ...towns.filter((t) => t !== cap)].filter((t) => !c.recruitBlock(faction, t));
  const maxArmies = Math.max(2, Math.ceil(towns.length / 2) + 1);
  const rich = () => !c.pays(faction) || c.gold(faction) > c.upkeep(faction) * 3 + 300;
  let levies = c.armiesOf(faction).length === 0 ? 1 : rich() && c.armiesOf(faction).length < maxArmies ? 1 : 0;
  for (const town of sites) {
    if (levies <= 0) break;
    if (c.recruitsAt(town).length) continue;
    let raised = 0;
    for (let k = 0; k < 6 && (raised === 0 || rich()); k++) if (raise(town, k)) raised++;
    else break;
    if (raised) levies--;
  }
  for (const a of c.armiesOf(faction)) {
    if (!c.army(a.id)) continue;
    for (const b of c.armiesOf(faction)) if (b !== a && c.army(b.id) && !c.canMerge(a, b) && !a.marching && !b.marching) c.merge(a, b);
  }
}
