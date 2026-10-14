// Campaign simulation, no DOM: armies march along roads between settlements, all at once; hostile
// armies that come into contact stop and fight; an army reaching an undefended enemy settlement
// takes it. Turns are WEGO like the battles: the player and the AI plan, then everything moves.
import { Rng } from '../sim/rng';
import type { UnitType } from '../sim/types';
import { aiMuster, planAI } from './ai';
import { MapGeo, type XZ } from './geo';
import type { Army, ArmyUnitDef, CampaignData, CampaignLogEntry, CampaignState, Recruit } from './types';

/** Hostile armies closer than this (map units) meet in battle. */
export const CONTACT = 22;
/** Units weaker than this after a battle are gone. */
const MIN_STRENGTH = 0.06;
const REPLENISH = 0.1;
/** Full turns an army must hold a siege before the town falls (a capital holds out longer). */
export const SIEGE_TURNS = 1;
export const CAPITAL_SIEGE_TURNS = 2;
/** Most units one army can hold (the battle deploys up to two ranks of eight plus wings). */
export const ARMY_CAP = 16;
/** Armies closer than this count as standing together (merging). */
const TOGETHER = 6;
/** Units a town can raise in one turn. */
export const RECRUIT_SLOTS = 10;
export const SEASONS = ['Spring', 'Summer', 'Monsoon', 'Winter'];

export interface Encounter {
  /** Player army and enemy army ids (for a battle between AI factions, simply the two armies). */
  player: number;
  enemy: number;
  /** Neither side is the player's: settled by auto-resolve without asking. */
  ai?: boolean;
  attacker: string;
  x: number;
  z: number;
  /** Nearest settlement, for the battle's name. */
  place: string;
}

export interface BattleOutcome {
  winner: string | null;
  /** New strength per unit, by army id, in the army's unit order. */
  strengths: Map<number, number[]>;
}

export class Campaign {
  readonly geo: MapGeo;
  readonly pos: Record<string, XZ> = {};
  readonly names: Record<string, string> = {};
  private readonly adj = new Map<string, { to: string; len: number }[]>();
  /** Battles found during this turn's movement, fought one by one afterwards. */
  encounters: Encounter[] = [];
  private engaged = new Set<number>();

  constructor(readonly data: CampaignData, readonly types: Record<string, UnitType>, public state: CampaignState) {
    this.geo = new MapGeo(data);
    for (const s of data.settlements) {
      this.pos[s.id] = this.geo.project(s.pos);
      this.names[s.id] = s.name;
      this.adj.set(s.id, []);
    }
    for (const [a, b] of data.roads) {
      const len = Math.hypot(this.pos[a].x - this.pos[b].x, this.pos[a].z - this.pos[b].z);
      this.adj.get(a)!.push({ to: b, len });
      this.adj.get(b)!.push({ to: a, len });
    }
  }

  static fresh(data: CampaignData): CampaignState {
    const state: CampaignState = {
      version: 1, dataId: data.id, turn: 0, owners: {}, armies: [], nextArmyId: 1, log: [], winner: null, recruits: [],
    };
    for (const s of data.settlements) state.owners[s.id] = s.owner;
    if (data.economy) {
      state.gold = {};
      for (const f of Object.keys(data.factions)) if (!data.economy.exempt.includes(f)) state.gold[f] = data.economy.startGold;
    }
    for (const a of data.armies) spawnArmy(state, a.name, a.faction, a.at, a.units);
    return state;
  }

  // ---------------------------------------------------------------- queries

  get player(): string {
    return this.data.player;
  }

  get armies(): Army[] {
    return this.state.armies;
  }

  army(id: number): Army | undefined {
    return this.state.armies.find((a) => a.id === id);
  }

  armiesOf(faction: string): Army[] {
    return this.state.armies.filter((a) => a.faction === faction);
  }

  /** Settlements one road away. */
  roadsFrom(n: string): string[] {
    return (this.adj.get(n) ?? []).map((e) => e.to);
  }

  roadLen(a: string, b: string): number {
    return this.adj.get(a)!.find((e) => e.to === b)!.len;
  }

  armyPos(a: Army): XZ {
    const p = this.pos[a.from];
    if (!a.to) return { ...p };
    const q = this.pos[a.to];
    const t = a.progress / this.roadLen(a.from, a.to);
    return { x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t };
  }

  /** Movement per turn: cavalry-only armies ride faster. */
  moveOf(a: Army): number {
    const f = this.data.factions[a.faction];
    const fast = a.units.every((u) => this.types[u.type]?.category === 'cavalry');
    return fast ? f.fastMove : f.move;
  }

  /** Fighting value, the same formula the battle uses for casualty scoring. */
  power(a: Army): number {
    let p = 0;
    for (const u of a.units) {
      const t = this.types[u.type];
      if (!t) continue;
      p += t.hp * u.strength * (t.melee.attack + t.melee.defense + t.melee.chargeBonus * 0.3 + (t.ranged ? t.ranged.attack * 3 : 0));
    }
    return p;
  }

  nearestSettlement(x: number, z: number): string {
    let best = '', bd = Infinity;
    for (const [id, p] of Object.entries(this.pos)) {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bd) (bd = d), (best = id);
    }
    return best;
  }

  hostileNear(faction: string, x: number, z: number, r: number): Army[] {
    return this.armies.filter((o) => !this.allied(o.faction, faction) && dist(this.armyPos(o), { x, z }) < r);
  }

  /** Same faction or allies (data `alliances`): they never fight or take each other's towns. */
  allied(a: string, b: string): boolean {
    if (a === b) return true;
    return (this.data.alliances ?? []).some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  }

  /** The player or one of the player's allies. */
  friendly(faction: string): boolean {
    return this.allied(faction, this.player);
  }

  /** Chronicle colour for something that happened to `faction` (good = it went its way). */
  private kindFor(faction: string, good: boolean): CampaignLogEntry['kind'] {
    if (faction === this.player) return good ? 'good' : 'bad';
    if (this.friendly(faction)) return good ? 'good' : 'warn';
    return 'info';
  }

  seasonLabel(turn = this.state.turn): string {
    return `${SEASONS[turn % 4]} ${this.data.startYear + Math.floor(turn / 4)} CE`;
  }

  log(text: string, kind: CampaignLogEntry['kind'] = 'info') {
    this.state.log.push({ turn: this.state.turn, text, kind });
  }

  // ---------------------------------------------------------------- routes

  /**
   * Shortest road distances from where the army stands (possibly mid-road) to every settlement.
   * Settlements for which `avoid` is true can be reached but not marched through.
   */
  search(a: Army, avoid?: (n: string) => boolean): { dist: Map<string, number>; prev: Map<string, string | null> } {
    const dist = new Map<string, number>(), prev = new Map<string, string | null>();
    dist.set(a.from, a.progress);
    prev.set(a.from, null);
    if (a.to) {
      dist.set(a.to, this.roadLen(a.from, a.to) - a.progress);
      prev.set(a.to, null);
    }
    const done = new Set<string>();
    for (;;) {
      let u: string | null = null;
      for (const [n, d] of dist) if (!done.has(n) && (u === null || d < dist.get(u)!)) u = n;
      if (u === null) break;
      done.add(u);
      if (avoid?.(u) && dist.get(u)! > 0) continue;
      for (const e of this.adj.get(u)!) {
        const nd = dist.get(u)! + e.len;
        if (nd < (dist.get(e.to) ?? Infinity)) {
          dist.set(e.to, nd);
          prev.set(e.to, u);
        }
      }
    }
    return { dist, prev };
  }

  /** Settlements to walk through to reach `dest`, starting with the first one the army heads for. */
  route(a: Army, dest: string, avoid?: (n: string) => boolean): string[] | null {
    const { dist, prev } = this.search(a, avoid);
    if (!dist.has(dest)) return null;
    const path: string[] = [];
    for (let n: string | null = dest; n !== null; n = prev.get(n) ?? null) path.unshift(n);
    return path;
  }

  setDestination(a: Army, dest: string, avoid?: (n: string) => boolean): boolean {
    const path = this.route(a, dest, avoid);
    if (!path) return false;
    if (a.to) {
      if (path[0] !== a.to) {
        // Turn back along the road we are on.
        a.progress = this.roadLen(a.from, a.to) - a.progress;
        [a.from, a.to] = [a.to, a.from];
      }
      a.route = path.slice(1);
    } else {
      if (path.length < 2) {
        a.marching = false;
        a.route = [];
        return true;
      }
      a.to = path[1];
      a.progress = 0;
      a.route = path.slice(2);
    }
    a.marching = true;
    return true;
  }

  stop(a: Army) {
    a.marching = false;
    a.route = [];
  }

  /** Planned path as points, and how much of it is reachable this turn. */
  routePoints(a: Army): { points: XZ[]; reach: number } {
    if (!a.marching || !a.to) return { points: [], reach: 0 };
    const points = [this.armyPos(a), this.pos[a.to], ...a.route.map((n) => this.pos[n])];
    return { points, reach: a.moveLeft };
  }

  // ---------------------------------------------------------------- money

  /** Does this realm pay for its troops? (The player's realm is exempt in the Gupta campaign.) */
  pays(faction: string): boolean {
    const e = this.data.economy;
    return !!e && !e.exempt.includes(faction);
  }

  costOf(type: string): number {
    return this.data.economy?.costs[type] ?? 100;
  }

  gold(faction: string): number {
    return this.state.gold?.[faction] ?? 0;
  }

  /** Tax income per turn: every town held, with a bonus for holding one's own capital. */
  income(faction: string): number {
    const e = this.data.economy;
    if (!e) return 0;
    const cap = this.data.factions[faction]?.capital;
    let g = 0;
    for (const [id, o] of Object.entries(this.state.owners)) if (o === faction) g += id === cap ? e.income.capital : e.income.town;
    return g;
  }

  /** Gold per turn to keep a realm's armies in the field. */
  upkeep(faction: string): number {
    const e = this.data.economy;
    if (!e) return 0;
    let g = 0;
    for (const a of this.armiesOf(faction)) for (const u of a.units) g += this.costOf(u.type) * e.upkeep;
    return Math.round(g);
  }

  /**
   * Collect taxes and pay the troops. A realm that can't pay loses its weakest units to desertion
   * until what it keeps is affordable.
   */
  private settleTreasuries() {
    const st = this.state;
    if (!this.data.economy || !st.gold) return;
    for (const f of Object.keys(st.gold)) {
      st.gold[f] += this.income(f) - this.upkeep(f);
      if (st.gold[f] >= 0) continue;
      let lost = 0;
      while (this.upkeep(f) > this.income(f) && this.armiesOf(f).length) {
        // The weakest unit of the realm (lowest strength, then cheapest) goes home.
        let worst: { a: Army; i: number } | null = null;
        for (const a of this.armiesOf(f)) a.units.forEach((u, i) => {
          if (!worst || u.strength < worst.a.units[worst.i].strength) worst = { a, i };
        });
        const w = worst as { a: Army; i: number } | null;
        if (!w) break;
        w.a.units.splice(w.i, 1);
        if (!w.a.units.length) this.removeArmy(w.a);
        lost++;
      }
      st.gold[f] = 0;
      if (lost) this.log(`Unpaid, ${lost} unit${lost > 1 ? 's' : ''} of the ${this.data.factions[f].name} desert.`, this.kindFor(f, false));
    }
  }

  // ---------------------------------------------------------------- recruiting

  /** Why a town cannot raise troops right now, or null if it can. */
  recruitBlock(faction: string, town: string): string | null {
    if (this.state.owners[town] !== faction) return 'not your town';
    const p = this.pos[town];
    if (this.hostileNear(faction, p.x, p.z, CONTACT * 2).length) return 'enemy at the gates';
    return null;
  }

  /** Units queued in a town this turn, in order. */
  recruitsAt(town: string): Recruit[] {
    return this.state.recruits.filter((r) => r.town === town);
  }

  /** Queue a unit in a town if a slot is free (and, for realms that pay, the treasury can afford it). */
  queueRecruit(faction: string, town: string, type: string): boolean {
    if (this.recruitBlock(faction, town) || !this.data.factions[faction].recruits.includes(type) || !this.types[type]) return false;
    if (this.recruitsAt(town).length >= RECRUIT_SLOTS) return false;
    if (this.pays(faction)) {
      const cost = this.costOf(type);
      if (this.gold(faction) < cost) return false;
      this.state.gold![faction] -= cost;
    }
    this.state.recruits.push({ town, faction, type });
    return true;
  }

  /** Free one slot (by its position in the town's queue), or the whole queue when no slot is given. */
  cancelRecruit(town: string, slot?: number) {
    const mine = this.recruitsAt(town);
    const drop = new Set(slot === undefined ? mine : mine.slice(slot, slot + 1));
    // Cancelled recruits are refunded.
    for (const r of drop) if (this.pays(r.faction)) this.state.gold![r.faction] += this.costOf(r.type);
    this.state.recruits = this.state.recruits.filter((r) => !drop.has(r));
  }

  /** Raised units join an army of theirs resting in the town, or form a new one there. */
  private completeRecruits() {
    const st = this.state;
    const lost = new Set<string>();
    for (const r of st.recruits) {
      const name = this.names[r.town];
      if (st.owners[r.town] !== r.faction) {
        if (r.faction === this.player && !lost.has(r.town)) this.log(`Recruits at ${name} are lost: the town has fallen.`, 'bad');
        lost.add(r.town);
        continue;
      }
      const t = this.types[r.type];
      const unit = { type: r.type, name: `${name} ${t.name}`, strength: 1 };
      // Fill an army resting here; when all are full, start a new levy (later recruits fill that).
      const host = this.armies.find((a) => a.faction === r.faction && !a.to && a.from === r.town && a.units.length < ARMY_CAP)
        ?? spawnArmy(st, `Levy of ${name}`, r.faction, r.town, []);
      host.units.push(unit);
      if (r.faction === this.player) this.log(`${unit.name} raised, joining ${host.name}.`, 'good');
    }
    st.recruits = [];
  }

  // ---------------------------------------------------------------- split and merge

  together(a: Army, b: Army): boolean {
    return a !== b && a.faction === b.faction && dist(this.armyPos(a), this.armyPos(b)) < TOGETHER;
  }

  canMerge(into: Army, from: Army): string | null {
    if (!this.together(into, from)) return 'not in the same place';
    if (into.units.length + from.units.length > ARMY_CAP) return `more than ${ARMY_CAP} units`;
    return null;
  }

  /** Fold `from` into `into`. The merged army keeps `into`'s orders and the lower movement left. */
  merge(into: Army, from: Army): boolean {
    if (this.canMerge(into, from)) return false;
    into.units.push(...from.units);
    into.moveLeft = Math.min(into.moveLeft, from.moveLeft);
    this.removeArmy(from);
    return true;
  }

  /** Detach the units at `indices` into a new army standing in the same place, without orders. */
  split(a: Army, indices: number[]): Army | null {
    const pick = new Set(indices.filter((i) => i >= 0 && i < a.units.length));
    if (pick.size === 0 || pick.size >= a.units.length) return null;
    const base = a.name.replace(/ · Detachment \S+$/, '');
    const taken = new Set(this.armies.map((x) => x.name));
    let n = 1;
    while (taken.has(`${base} · Detachment ${toRoman(n)}`)) n++;
    const b = spawnArmy(this.state, `${base} · Detachment ${toRoman(n)}`, a.faction, a.from, []);
    b.units = a.units.filter((_, i) => pick.has(i));
    a.units = a.units.filter((_, i) => !pick.has(i));
    b.to = a.to;
    b.progress = a.progress;
    b.moveLeft = a.moveLeft;
    return b;
  }

  destination(a: Army): string | null {
    if (!a.marching || !a.to) return null;
    return a.route.length ? a.route[a.route.length - 1] : a.to;
  }

  // ---------------------------------------------------------------- turn flow

  /** End of planning: the AI plans with what it can see now, then movement can run. */
  beginMovement() {
    this.encounters = [];
    this.engaged.clear();
    for (const [id, f] of Object.entries(this.data.factions)) {
      if (!f.ai) continue;
      planAI(this, id);
      aiMuster(this, id);
    }
  }

  /** Advance every marching army by up to `step` map units. Returns false once nobody can move. */
  stepMovement(step: number): boolean {
    let anyone = false;
    for (const a of this.armies) {
      if (!a.marching || a.moveLeft <= 0 || this.engaged.has(a.id)) continue;
      const d = Math.min(step, a.moveLeft);
      a.moveLeft -= d;
      this.advance(a, d);
      if (a.marching && a.moveLeft > 0) anyone = true;
    }
    this.checkContacts();
    return anyone;
  }

  private advance(a: Army, d: number) {
    while (d > 0 && a.to) {
      const rem = this.roadLen(a.from, a.to) - a.progress;
      if (d < rem) {
        a.progress += d;
        return;
      }
      d -= rem;
      a.from = a.to;
      a.progress = 0;
      a.to = a.route.shift() ?? null;
      if (this.arrive(a) || !a.to) {
        a.to = null;
        this.stop(a);
        return;
      }
    }
  }

  /**
   * Reaching an enemy town: the army stops and lays siege. The town falls if the army still holds it
   * after a full turn (two for a capital), which gives the owner time to come and relieve it.
   */
  private arrive(a: Army): boolean {
    const s = a.from;
    const owner = this.state.owners[s];
    if (this.allied(owner, a.faction)) return false;
    if (this.hostileNear(a.faction, this.pos[s].x, this.pos[s].z, CONTACT).length) return true;
    const sieges = (this.state.sieges ??= {});
    if (sieges[s]?.army !== a.id) {
      sieges[s] = { army: a.id, since: this.state.turn };
      const turns = this.siegeTurns(s);
      if (this.friendly(owner) || this.friendly(a.faction)) {
        this.log(`${a.name} lays siege to ${this.names[s]}: it falls in ${turns} turn${turns > 1 ? 's' : ''} unless relieved.`,
          this.friendly(owner) && !this.friendly(a.faction) ? 'bad' : this.kindFor(a.faction, true));
      }
    }
    return true;
  }

  siegeTurns(town: string): number {
    const owner = this.state.owners[town];
    return this.data.factions[owner]?.capital === town ? CAPITAL_SIEGE_TURNS : SIEGE_TURNS;
  }

  /** Who is besieging a town, and how many more turns it holds out (0 = falls at this turn's end). */
  siegeOf(town: string): { army: Army; left: number } | null {
    const sg = this.state.sieges?.[town];
    const a = sg ? this.army(sg.army) : undefined;
    if (!sg || !a) return null;
    return { army: a, left: Math.max(0, sg.since + this.siegeTurns(town) - this.state.turn) };
  }

  /** End of turn: towns whose besiegers held on long enough fall; broken sieges are lifted. */
  private resolveSieges() {
    const st = this.state;
    for (const [town, sg] of Object.entries(st.sieges ?? {})) {
      const a = this.army(sg.army);
      const owner = st.owners[town];
      const holding = a && !a.to && a.from === town && !this.allied(owner, a.faction);
      const p = this.pos[town];
      if (!a || !holding || this.hostileNear(a.faction, p.x, p.z, CONTACT).length) {
        delete st.sieges![town];
        continue;
      }
      if (st.turn - sg.since < this.siegeTurns(town)) continue;
      st.owners[town] = a.faction;
      delete st.sieges![town];
      const mine = a.faction === this.player;
      const lost = this.friendly(owner) && !this.friendly(a.faction);
      this.log(`${a.name} ${mine ? 'takes' : 'seizes'} ${this.names[town]}${mine ? '' : ` from the ${this.data.factions[owner]?.name ?? 'locals'}`}.`,
        lost ? 'bad' : this.kindFor(a.faction, true));
      // Recruits being raised there are lost with the town (and refunded to nobody).
    }
  }

  private checkContacts() {
    const free = this.armies.filter((a) => !this.engaged.has(a.id));
    for (let i = 0; i < free.length; i++) {
      for (let j = i + 1; j < free.length; j++) {
        const a = free[i], b = free[j];
        if (this.allied(a.faction, b.faction) || this.engaged.has(a.id) || this.engaged.has(b.id)) continue;
        const pa = this.armyPos(a), pb = this.armyPos(b);
        if (dist(pa, pb) >= CONTACT) continue;
        const [p, e] = b.faction === this.player ? [b, a] : [a, b];
        const ai = p.faction !== this.player;
        // Whoever was marching toward the other attacks; if both were, the player does.
        const attacker = p.marching ? p.faction : e.faction;
        for (const x of [a, b]) {
          this.engaged.add(x.id);
          this.stop(x);
          x.moveLeft = 0;
        }
        const x = (pa.x + pb.x) / 2, z = (pa.z + pb.z) / 2;
        this.encounters.push({ player: p.id, enemy: e.id, attacker, x, z, place: this.nearestSettlement(x, z), ai });
      }
    }
  }

  /** Quick result from army strength, with a dice roll; losses scale with how lopsided it was. */
  autoResolve(enc: Encounter): BattleOutcome {
    const p = this.army(enc.player)!, e = this.army(enc.enemy)!;
    const rng = new Rng(hash(this.state.turn, enc.player, enc.enemy));
    const pp = this.power(p), pe = this.power(e);
    const chance = pp * pp / (pp * pp + pe * pe);
    const playerWins = rng.next() < chance;
    const [w, l] = playerWins ? [p, e] : [e, p];
    const ratio = Math.min(3, this.power(w) / Math.max(1, this.power(l)));
    const lossW = Math.max(0.06, 0.32 - 0.09 * ratio), lossL = Math.min(0.75, 0.3 + 0.12 * ratio);
    const strengths = new Map<number, number[]>();
    strengths.set(w.id, w.units.map((u) => u.strength * (1 - lossW * rng.range(0.5, 1.5))));
    strengths.set(l.id, l.units.map((u) => u.strength * (1 - lossL * rng.range(0.6, 1.4))));
    return { winner: w.faction, strengths };
  }

  /** Casualties stick; the loser (or on a tie, the attacker) falls back to the nearest friendly town. */
  applyOutcome(enc: Encounter, out: BattleOutcome) {
    const p = this.army(enc.player)!, e = this.army(enc.enemy)!;
    for (const a of [p, e]) {
      const s = out.strengths.get(a.id);
      if (s) a.units = a.units.map((u, i) => ({ ...u, strength: Math.min(1, s[i] ?? u.strength) })).filter((u) => u.strength >= MIN_STRENGTH);
    }
    const place = this.names[enc.place];
    const fp = this.data.factions[p.faction].name, fe = this.data.factions[e.faction].name;
    if (out.winner === null) this.log(`The battle near ${place} between the ${fp} and the ${fe} ends in a draw.`, enc.ai ? 'info' : 'warn');
    else {
      const w = out.winner, l = w === p.faction ? e.faction : p.faction;
      this.log(`Battle near ${place}: the ${this.data.factions[w].name} defeat the ${this.data.factions[l].name}.`,
        this.friendly(l) && !this.friendly(w) ? 'bad' : this.kindFor(w, true));
    }
    const loser = out.winner === null ? (enc.attacker === p.faction ? p : e) : out.winner === p.faction ? e : p;
    for (const a of [p, e]) {
      if (a.units.length) continue;
      this.log(`${a.name} is destroyed.`, this.kindFor(a.faction, false));
      this.removeArmy(a);
    }
    if (this.army(loser.id)) this.retreat(loser);
  }

  private retreat(a: Army) {
    const { dist } = this.search(a);
    let best: string | null = null;
    for (const [n, d] of dist) {
      if (this.state.owners[n] !== a.faction || this.hostileNear(a.faction, this.pos[n].x, this.pos[n].z, CONTACT * 2).length) continue;
      if (best === null || d < dist.get(best)!) best = n;
    }
    if (best === null) {
      this.log(`${a.name} has nowhere to fall back to and scatters.`, this.kindFor(a.faction, false));
      this.removeArmy(a);
      return;
    }
    a.from = best;
    a.to = null;
    a.progress = 0;
    this.stop(a);
    if (this.friendly(a.faction)) this.log(`${a.name} falls back to ${this.names[best]}.`, 'info');
  }

  private removeArmy(a: Army) {
    this.state.armies = this.state.armies.filter((x) => x !== a);
  }

  /** After movement and battles: recover, reinforce, check victory, next turn. */
  finishTurn() {
    const st = this.state;
    this.resolveSieges();
    this.completeRecruits();
    // Armies resting in a town they hold recover, including one they took this turn.
    for (const a of this.armies) {
      if (a.to || st.owners[a.from] !== a.faction) continue;
      for (const u of a.units) u.strength = Math.min(1, u.strength + REPLENISH);
    }
    this.settleTreasuries();
    st.turn++;
    for (const r of this.data.reinforcements) {
      if (st.turn % r.every !== 0 || st.owners[r.at] !== r.faction) continue;
      if (this.armiesOf(r.faction).length >= r.maxArmies) continue;
      const p = this.pos[r.at];
      if (this.hostileNear(r.faction, p.x, p.z, CONTACT * 2).length) continue;
      // A muster is paid for like any other levy by realms that pay.
      if (this.pays(r.faction)) {
        const cost = r.units.reduce((s, u) => s + this.costOf(u.type), 0);
        if (this.gold(r.faction) < cost) continue;
        st.gold![r.faction] -= cost;
      }
      spawnArmy(st, r.name, r.faction, r.at, r.units);
      this.log(`${r.name} musters at ${this.names[r.at]}.`, r.faction === this.player ? 'good' : 'info');
    }
    for (const a of this.armies) a.moveLeft = this.moveOf(a);
    this.checkVictory();
  }

  /** Factions the player must defeat: everyone not allied with them. */
  rivals(): string[] {
    return Object.keys(this.data.factions).filter((f) => !this.friendly(f));
  }

  /**
   * Lose when the player's capital falls (or the last army is gone). Win when every rival capital is
   * held by the player or an ally. Rival factions that lose everything are announced as fallen.
   */
  private checkVictory() {
    const st = this.state;
    st.fallen ??= [];
    for (const f of Object.keys(this.data.factions)) {
      if (st.fallen.includes(f) || f === this.player) continue;
      if (this.armiesOf(f).length || Object.values(st.owners).includes(f)) continue;
      st.fallen.push(f);
      this.log(`The ${this.data.factions[f].name} is no more.`, this.friendly(f) ? 'bad' : 'good');
    }
    if (st.winner) return;
    const cap = this.data.factions[this.player].capital;
    const holder = st.owners[cap];
    if (!this.friendly(holder)) {
      st.winner = holder;
      this.log(`${this.names[cap]} has fallen to the ${this.data.factions[holder].name}.`, 'bad');
      return;
    }
    if (this.armiesOf(this.player).length === 0) {
      st.winner = this.rivals()[0] ?? '';
      this.log('Your last army is gone. The war is lost.', 'bad');
      return;
    }
    if (this.rivals().every((f) => this.friendly(st.owners[this.data.factions[f].capital]))) {
      st.winner = this.player;
      this.log('Every rival capital is yours.', 'good');
    }
  }

  /** Set movement for the first turn (fresh state) or after loading. */
  prepareTurn() {
    this.state.recruits ??= [];
    if (this.data.economy && !this.state.gold) {
      this.state.gold = {};
      for (const f of Object.keys(this.data.factions)) if (this.pays(f)) this.state.gold[f] = this.data.economy.startGold;
    }
    for (const a of this.armies) if (!(a.moveLeft >= 0)) a.moveLeft = this.moveOf(a);
  }
}

export function spawnArmy(st: CampaignState, name: string, faction: string, at: string, units: ArmyUnitDef[]): Army {
  const a: Army = {
    id: st.nextArmyId++, name, faction, from: at, to: null, progress: 0, route: [], marching: false, moveLeft: NaN,
    units: units.map((u) => ({ type: u.type, name: u.name ?? u.type, strength: u.strength ?? 1, general: u.general })),
  };
  st.armies.push(a);
  return a;
}

function toRoman(n: number): string {
  return ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][n - 1] ?? String(n);
}

export function dist(a: XZ, b: XZ): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function hash(...n: number[]): number {
  let h = 2166136261;
  for (const v of n) h = Math.imul(h ^ (v | 0), 16777619);
  return h >>> 0;
}
