// Deterministic battle simulation. Fixed 20 Hz tick, no DOM, no rendering.
// Player input and the AI both act only through the order methods (orderMove, orderAttack, ...).
import { ArmyAI } from './ai';
import { angleDiff, deg, sideOf, toWorld, turnToward } from './geometry';
import { Rng } from './rng';
import { Terrain } from './terrain';
import type { LogEntry, Scenario, Slot, Stance, UnitType, Volley } from './types';
import { Unit } from './unit';

export const DT = 0.05;

/** Combat tuning constants, all estimates. Kept together so balancing touches one place. */
export const TUNING = {
  meleeRate: 0.0045,
  armorFactor: 0.16,
  flank: 1.5,
  rear: 2.0,
  chargeRate: 0.02,
  missileArmor: 3,
  braceReduction: 0.35,
  waverAt: 45,
  steadyAt: 55,
  retreatAt: 22,
  routAt: 9,
  regroupAt: 42,
  rallyTo: 38,
  rallyClear: 90,
  breakFraction: 0.25,
  /** A side that leaves the field having lost at least this share of its fighting power counts as defeated. */
  concedeDefeat: 0.45,
};

export interface SideInfo {
  id: string;
  name: string;
  color: string;
  ai: boolean;
  rearX: number;
  initialMen: number;
  generalLost: boolean;
}

export interface BattleResult {
  /** null for an indecisive result. */
  winner: string | null;
  loser: string | null;
  text: string;
}

const SIDE_MOD = { front: 1, flank: TUNING.flank, rear: TUNING.rear } as const;

export class Battle {
  readonly terrain: Terrain;
  readonly units: Unit[] = [];
  readonly sides = new Map<string, SideInfo>();
  readonly rng: Rng;
  readonly player: string;
  time = 0;
  ticks = 0;
  log: LogEntry[] = [];
  /** Missile volleys fired since the renderer last drained them. */
  volleys: Volley[] = [];
  result: BattleResult | null = null;
  private readonly ais: ArmyAI[] = [];
  private trampleLogged = new Set<string>();

  constructor(readonly scenario: Scenario, types: Record<string, UnitType>) {
    this.terrain = new Terrain(scenario.terrain.size, scenario.terrain.hills, scenario.terrain.river);
    this.rng = new Rng(scenario.seed);
    this.player = scenario.player;
    for (const [sideId, side] of Object.entries(scenario.sides)) {
      let initialMen = 0;
      for (const su of side.units) {
        const type = types[su.type];
        if (!type) throw new Error(`Unknown unit type "${su.type}"`);
        const u = new Unit(
          this.units.length, sideId, type, su.name ?? type.name,
          su.pos[0], su.pos[1], deg(su.facing), su.men ?? type.men, su.general, su.reserve,
        );
        initialMen += u.men;
        this.units.push(u);
      }
      this.sides.set(sideId, { id: sideId, name: side.name, color: side.color, ai: !!side.ai, rearX: side.rearX, initialMen, generalLost: false });
      if (side.ai) this.ais.push(new ArmyAI(sideId));
    }
  }

  // ---------------------------------------------------------------- queries

  unit(id: number): Unit {
    return this.units[id];
  }

  enemiesOf(u: Unit): Unit[] {
    return this.units.filter((o) => o.side !== u.side && o.alive);
  }

  friendsOf(u: Unit): Unit[] {
    return this.units.filter((o) => o.side === u.side && o.alive && o !== u);
  }

  nearestEnemy(u: Unit, filter: (o: Unit) => boolean = (o) => o.state !== 'routing'): Unit | null {
    let best: Unit | null = null;
    let bd = Infinity;
    for (const o of this.units) {
      if (o.side === u.side || !o.alive || !filter(o)) continue;
      const d = Math.hypot(o.x - u.x, o.z - u.z);
      if (d < bd) (bd = d), (best = o);
    }
    return best;
  }

  general(side: string): Unit | undefined {
    return this.units.find((u) => u.side === side && u.general);
  }

  sideStrength(side: string): { men: number; initial: number; activeMen: number } {
    const info = this.sides.get(side)!;
    let men = 0, activeMen = 0;
    for (const u of this.units) {
      if (u.side !== side || !u.alive) continue;
      men += u.men;
      if (u.state === 'steady' || u.state === 'wavering' || u.state === 'rallying') activeMen += u.men;
    }
    return { men, initial: info.initialMen, activeMen };
  }

  private say(side: string, text: string, kind: LogEntry['kind'] = 'info') {
    this.log.push({ t: this.time, side, text, kind });
  }

  // ---------------------------------------------------------------- orders

  orderMove(id: number, slot: Slot, speedScale = 1, run = false) {
    const u = this.units[id];
    if (!u.controllable) return;
    const [lo, hi] = u.filesRange();
    u.order = { kind: 'move', x: slot.x, z: slot.z, facing: slot.facing, files: Math.max(lo, Math.min(hi, Math.round(slot.files))), speedScale, run };
  }

  orderAttack(id: number, target: number, run = false) {
    const u = this.units[id];
    if (!u.controllable || !this.units[target]?.alive) return;
    u.order = { kind: 'attack', target, run };
  }

  setStance(id: number, stance: Stance) {
    const u = this.units[id];
    if (!u.controllable) return;
    u.stance = stance;
    // Hold keeps a pending move (stand where ordered); withdraw abandons it.
    if (stance === 'withdraw') u.order = null;
    if (stance === 'charge' && u.order?.kind === 'attack') u.order.run = true;
  }

  setFireAtWill(id: number, on: boolean) {
    this.units[id].fireAtWill = on;
  }

  halt(id: number) {
    const u = this.units[id];
    if (!u.controllable) return;
    u.order = null;
    u.stance = 'hold';
  }

  // ---------------------------------------------------------------- tick

  step() {
    if (this.result) return;
    for (const u of this.units) {
      u.prevX = u.x;
      u.prevZ = u.z;
      u.prevFacing = u.facing;
      u.lostThisTick = 0;
      u.pressure.flank = u.pressure.rear = u.pressure.fear = false;
    }
    if (this.ticks % 20 === 0) for (const ai of this.ais) ai.think(this);
    for (const u of this.units) if (u.alive) this.behave(u);
    this.findContacts();
    for (const u of this.units) if (u.alive) this.impacts(u);
    this.melee();
    this.missiles();
    this.trample();
    for (const u of this.units) if (u.alive) this.updateMorale(u);
    this.checkGenerals();
    this.checkVictory();
    this.time += DT;
    this.ticks++;
  }

  // ---------------------------------------------------------------- movement

  private behave(u: Unit) {
    u.sinceMelee += DT;
    u.sinceShot += DT;
    u.sinceCharge += DT;
    u.stateTime += DT;
    // Reform toward the ordered frontage.
    const [lo, hi] = u.filesRange();
    u.targetFiles = Math.max(lo, Math.min(hi, u.targetFiles));
    u.files += Math.max(-4 * DT, Math.min(4 * DT, u.targetFiles - u.files));
    u.files = Math.max(1, Math.min(u.files, u.men));

    const t = u.type;
    const nearest = this.nearestEnemy(u);
    const rear = this.sides.get(u.side)!.rearX;

    if (u.state === 'routing') {
      let tx: number, tz: number;
      if (t.class === 'elephant') {
        // Panicked elephants stampede directly away from the enemy, often through their own line.
        const from = this.nearestEnemy(u, () => true);
        const a = from ? Math.atan2(u.z - from.z, u.x - from.x) : Math.atan2(0, rear - u.x);
        tx = u.x + Math.cos(a) * 50;
        tz = u.z + Math.sin(a) * 50;
      } else {
        tx = rear;
        tz = u.z;
      }
      this.moveTo(u, tx, tz, null, t.runSpeed * 0.95, true, null);
      if (!this.terrain.inside(u.x, u.z, 1)) {
        u.setState('gone');
        this.say(u.side, `${u.name} flee the field.`, u.side === this.player ? 'bad' : 'good');
      }
      return;
    }
    if (u.state === 'rallying') {
      this.stand(u, nearest ? Math.atan2(nearest.z - u.z, nearest.x - u.x) : null);
      return;
    }
    if (u.state === 'retreating') {
      const away = Math.sign(rear - u.x) || -1;
      const face = nearest ? Math.atan2(nearest.z - u.z, nearest.x - u.x) : u.facing;
      this.moveTo(u, u.x + away * 40, u.z, null, t.speed * 0.8, false, face);
      return;
    }

    // Controllable units. Melee pins a unit in place unless it is withdrawing.
    if (u.contacts.length > 0 && u.stance !== 'withdraw') {
      const engaged = u.contacts.map((id) => this.units[id]);
      if (!engaged.some((e) => sideOf(u, e.x, e.z) === 'front')) {
        const e = engaged[0];
        u.facing = turnToward(u.facing, Math.atan2(e.z - u.z, e.x - u.x), deg(t.turnRate) * 0.25 * DT);
      }
      this.stand(u, null);
      return;
    }

    const o = u.order;
    if (o?.kind === 'move') {
      u.targetFiles = o.files;
      const done = this.moveTo(u, o.x, o.z, o.facing, (o.run ? t.runSpeed : t.speed) * o.speedScale, o.run, null);
      if (done) u.order = null;
      return;
    }
    if (o?.kind === 'attack') {
      const target = this.units[o.target];
      if (!target.alive) {
        u.order = null;
      } else {
        const d = Math.hypot(target.x - u.x, target.z - u.z);
        if (t.range && u.ammo > 0) {
          // Missile troops close to effective range, then stand and shoot.
          if (d > t.range * 0.85) this.moveTo(u, target.x, target.z, null, t.speed, false, null);
          else this.stand(u, Math.atan2(target.z - u.z, target.x - u.x));
        } else {
          const run = o.run || u.stance === 'charge' || ((t.class === 'cavalry' || t.class === 'elephant') && d < 70);
          this.moveTo(u, target.x, target.z, null, run ? t.runSpeed : t.speed, run, null);
        }
        return;
      }
    }

    if ((u.stance === 'advance' || u.stance === 'charge') && nearest) {
      const d = Math.hypot(nearest.x - u.x, nearest.z - u.z);
      const run = u.stance === 'charge' && d < 80;
      this.moveTo(u, nearest.x, nearest.z, null, run ? t.runSpeed : t.speed, run, null);
      return;
    }
    if (u.stance === 'withdraw') {
      const d = nearest ? Math.hypot(nearest.x - u.x, nearest.z - u.z) : Infinity;
      if (d < 110 && nearest) {
        const away = Math.sign(rear - u.x) || -1;
        this.moveTo(u, u.x + away * 30, u.z, null, t.speed * 0.8, false, Math.atan2(nearest.z - u.z, nearest.x - u.x));
        return;
      }
    }
    this.stand(u, null);
  }

  private stand(u: Unit, faceTo: number | null) {
    u.speedNow = 0;
    u.running = false;
    u.runTime = 0;
    if (faceTo !== null) u.facing = turnToward(u.facing, faceTo, deg(u.type.turnRate) * DT);
    this.tire(u, false);
  }

  /**
   * Formation movement. Units pivot to face where they are going and then march; they do not
   * slide sideways, except for small final adjustments. With `faceDir` the unit keeps facing
   * that way and steps in any direction (an orderly withdrawal). Returns true on arrival.
   */
  private moveTo(u: Unit, tx: number, tz: number, finalFacing: number | null, speed: number, run: boolean, faceDir: number | null): boolean {
    const t = u.type;
    const turn = deg(t.turnRate) * DT;
    const dx = tx - u.x;
    const dz = tz - u.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.4) {
      u.x = tx;
      u.z = tz;
      if (finalFacing !== null) u.facing = turnToward(u.facing, finalFacing, turn);
      this.stand(u, null);
      return finalFacing === null || Math.abs(angleDiff(u.facing, finalFacing)) < 0.02;
    }
    const heading = Math.atan2(dz, dx);
    let advance = 0;
    if (faceDir !== null) {
      u.facing = turnToward(u.facing, faceDir, turn);
      const backwards = Math.cos(angleDiff(u.facing, heading)) < 0;
      advance = backwards ? 0.6 : 1;
      u.backing = backwards;
    } else {
      const diff = angleDiff(u.facing, heading);
      if (dist < 6 && Math.abs(diff) > 1.0 && finalFacing !== null) {
        // Final shuffle into the slot without spinning the whole formation round.
        advance = 0.35;
        u.facing = turnToward(u.facing, finalFacing, turn);
      } else {
        u.facing = turnToward(u.facing, heading, turn);
        const rem = Math.abs(angleDiff(u.facing, heading));
        advance = rem < 0.5 ? 1 - rem : 0;
      }
      u.backing = false;
    }
    const slope = (this.terrain.height(u.x + Math.cos(heading), u.z + Math.sin(heading)) - this.terrain.height(u.x, u.z));
    const slopeF = 1 - Math.max(0, Math.min(0.4, slope * 3));
    const fatigueF = 1 - 0.3 * u.fatigue;
    const v = speed * advance * slopeF * fatigueF * this.terrain.speedFactor(u.x, u.z, t.class);
    const stepLen = Math.min(dist, v * DT);
    u.x += Math.cos(heading) * stepLen;
    u.z += Math.sin(heading) * stepLen;
    u.x = Math.max(0, Math.min(this.terrain.width, u.x));
    u.z = Math.max(0, Math.min(this.terrain.depth, u.z));
    u.speedNow = stepLen / DT;
    u.running = run && u.speedNow > t.speed * 1.05;
    u.runTime = u.running ? u.runTime + DT : 0;
    this.tire(u, u.running);
    return false;
  }

  private tire(u: Unit, running: boolean) {
    const runRate = u.type.class === 'cavalry' ? 0.006 : u.type.class === 'elephant' ? 0.025 : 0.01;
    const rate = running ? runRate : u.contacts.length ? 0.005 : u.speedNow > 0 ? 0 : -0.008;
    u.fatigue = Math.max(0, Math.min(1, u.fatigue + rate * DT));
  }

  // ---------------------------------------------------------------- contact and combat

  private touching(a: Unit, b: Unit): boolean {
    const pts = (u: Unit) => {
      const f = u.depth / 2, l = u.frontage / 2;
      return [[0, 0], [f, 0], [-f, 0], [0, l], [0, -l], [f, l], [f, -l], [-f, l], [-f, -l]].map(([df, dl]) => toWorld(u, df, dl));
    };
    return pts(a).some((p) => b.contains(p.x, p.z, 1.2)) || pts(b).some((p) => a.contains(p.x, p.z, 1.2));
  }

  private findContacts() {
    for (const u of this.units) {
      u.prevContacts = new Set(u.contacts);
      u.contacts = [];
    }
    const live = this.units.filter((u) => u.alive);
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i], b = live[j];
        if (a.side === b.side) continue;
        if (Math.hypot(a.x - b.x, a.z - b.z) > a.radius + b.radius + 2) continue;
        if (this.touching(a, b)) {
          a.contacts.push(b.id);
          b.contacts.push(a.id);
        }
      }
    }
  }

  /** Charge impacts on fresh contact. */
  private impacts(a: Unit) {
    for (const id of a.contacts) {
      if (a.prevContacts.has(id)) continue;
      const b = this.units[id];
      const t = a.type;
      if (!(a.running && a.runTime > 1.2 && a.speedNow > 0.55 * t.runSpeed && t.charge >= 8)) continue;
      if (a.state === 'routing') continue;
      const side = sideOf(b, a.x, a.z);
      let impact = a.fileCount * t.charge * TUNING.chargeRate * SIDE_MOD[side] / (1 + b.type.armor * 0.15) / b.type.hp;
      let shock = (t.charge * 0.7 * SIDE_MOD[side]) / b.resilience;
      if (b.type.antiCavalry && side === 'front' && t.class === 'cavalry' && b.controllable) {
        impact *= TUNING.braceReduction;
        shock *= TUNING.braceReduction;
        a.wound((b.fileCount * b.type.antiCavalry * 0.3) / t.hp);
        this.say(a.side, `${a.name} impale themselves on the braced spears of ${b.name}.`, a.side === this.player ? 'bad' : 'good');
      } else {
        this.say(a.side, `${a.name} charge ${b.name}${side === 'front' ? '' : side === 'rear' ? ' in the rear!' : ' in the flank!'}`, a.side === this.player ? 'good' : 'warn');
      }
      b.wound(impact);
      b.morale -= shock;
      a.sinceCharge = 0;
      if (t.causesFear) {
        for (const e of this.enemiesOf(a)) {
          if (Math.hypot(e.x - a.x, e.z - a.z) < 40 && e.type.class !== 'elephant') e.morale -= (e.type.class === 'cavalry' ? 9 : 6) / e.resilience;
        }
      }
    }
  }

  private fighters(u: Unit, target: Unit): number {
    if (u.state === 'routing' || u.state === 'rallying') return 0;
    const facingIt = sideOf(u, target.x, target.z) === 'front';
    const n = facingIt ? u.fileCount * 2 : u.ranks * 2;
    return Math.min(u.men, n) / Math.max(1, u.contacts.length);
  }

  private melee() {
    for (const u of this.units) {
      if (!u.alive || u.contacts.length === 0) continue;
      u.sinceMelee = 0;
      for (const id of u.contacts) {
        const v = this.units[id];
        const hitSide = sideOf(v, u.x, u.z);
        if (hitSide === 'flank') v.pressure.flank = true;
        if (hitSide === 'rear') v.pressure.rear = true;
        if (u.type.causesFear && v.type.class !== 'elephant') v.pressure.fear = true;
        const chargeBonus = u.sinceCharge < 4 ? u.type.charge * 0.3 * (1 - u.sinceCharge / 4) : 0;
        let mod = SIDE_MOD[hitSide];
        if (v.state === 'routing') mod *= 3;
        else if (v.state === 'retreating') mod *= 1.5;
        if (u.state === 'wavering') mod *= 0.75;
        if (u.state === 'retreating') mod *= 0.4;
        mod *= 1 - 0.35 * u.fatigue;
        const dh = this.terrain.height(u.x, u.z) - this.terrain.height(v.x, v.z);
        if (dh > 1.5) mod *= 1.15;
        else if (dh < -1.5) mod *= 0.88;
        if (this.terrain.inWater(u.x, u.z)) mod *= 0.7;
        if (v.type.class === 'cavalry' && u.type.antiCavalry) mod *= u.type.antiCavalry;
        if (u.type.class === 'cavalry' && v.type.class === 'elephant') mod *= 0.6;
        if (u.type.class === 'elephant' && v.type.class !== 'cavalry' && v.type.class !== 'elephant') mod *= 1.2;
        const armor = v.type.armor * (v.type.shield && hitSide === 'front' ? 1.3 : 1);
        const kills = (this.fighters(u, v) * TUNING.meleeRate * (u.type.attack + chargeBonus) * mod) / (1 + armor * TUNING.armorFactor) / v.type.hp;
        v.wound(kills * DT);
      }
    }
  }

  private missiles() {
    for (const u of this.units) {
      const t = u.type;
      if (!u.alive || !t.range || u.ammo <= 0) continue;
      u.reloadT -= DT;
      if (u.reloadT > 0 || !u.controllable || u.contacts.length > 0) continue;
      if (u.speedNow > 0.3 && !t.fireOnMove) continue;
      const arc = deg(t.fireArc ?? 120) / 2;
      const inArc = (o: Unit) => Math.abs(angleDiff(u.facing, Math.atan2(o.z - u.z, o.x - u.x))) <= arc;
      const inRange = (o: Unit) => Math.hypot(o.x - u.x, o.z - u.z) <= t.range!;
      let target: Unit | null = null;
      const o = u.order;
      if (o?.kind === 'attack' && inRange(this.units[o.target]) && inArc(this.units[o.target])) target = this.units[o.target];
      if (!target && u.fireAtWill) {
        let bd = Infinity;
        for (const e of this.enemiesOf(u)) {
          if (!inRange(e) || !inArc(e)) continue;
          // Prefer targets not locked in melee with our own men.
          const d = Math.hypot(e.x - u.x, e.z - u.z) + (e.contacts.length ? 1000 : 0);
          if (d < bd) (bd = d), (target = e);
        }
      }
      if (!target) continue;
      const dist = Math.hypot(target.x - u.x, target.z - u.z);
      const hitSide = sideOf(target, u.x, u.z);
      const shooters = u.men * (t.loose ? 1 : 0.8) * (u.speedNow > 0.3 ? 0.7 : 1);
      const hits =
        shooters * (t.accuracy ?? 0.05) * (1 - (0.55 * dist) / t.range) *
        (target.type.shield && hitSide === 'front' ? 0.5 : 1) *
        (target.type.loose ? 0.65 : 1) * (target.type.class === 'elephant' ? 1.5 : 1);
      const kills = ((hits * TUNING.missileArmor) / (TUNING.missileArmor + target.type.armor) / target.type.hp) * this.rng.range(0.75, 1.25);
      target.wound(kills);
      target.sinceShot = 0;
      target.morale -= (target.type.class === 'elephant' ? 1.6 : 0.35) / target.resilience;
      u.ammo--;
      u.reloadT = (t.reload ?? 4) * this.rng.range(0.9, 1.1);
      this.volleys.push({ side: u.side, fromX: u.x, fromZ: u.z, toX: target.x, toZ: target.z, count: Math.max(4, Math.min(30, Math.round(shooters / 6))) });
    }
  }

  /** Stampeding elephants trample whoever they run through, friend or foe. */
  private trample() {
    for (const e of this.units) {
      if (!e.alive || e.type.class !== 'elephant' || e.state !== 'routing') continue;
      const front = toWorld(e, e.depth / 2, 0);
      for (const w of this.units) {
        if (w === e || !w.alive || w.type.class === 'elephant') continue;
        if (!w.contains(front.x, front.z, 1) && !w.contains(e.x, e.z, 1)) continue;
        w.wound((e.men * 0.6 * DT) / w.type.hp);
        w.morale -= (6 * DT) / w.resilience;
        const key = `${e.id}:${w.id}`;
        if (!this.trampleLogged.has(key)) {
          this.trampleLogged.add(key);
          this.say(e.side, `Panicked elephants trample ${w.side === e.side ? 'their own' : 'enemy'} ${w.name}!`, w.side === this.player ? 'bad' : 'warn');
        }
      }
    }
  }

  // ---------------------------------------------------------------- morale

  private updateMorale(u: Unit) {
    if (u.men <= 0) {
      u.setState('gone');
      this.say(u.side, `${u.name} have been destroyed.`, u.side === this.player ? 'bad' : 'good');
      return;
    }
    const resil = u.resilience * (u.type.class === 'elephant' ? 0.7 : 1);
    const gen = this.general(u.side);
    const genNear = !!gen && gen !== u && gen.alive && gen.state !== 'routing' && Math.hypot(gen.x - u.x, gen.z - u.z) < 90;
    let shock = ((u.lostThisTick / u.maxMen) * 100 * 1.7 * (genNear ? 0.75 : 1)) / resil;
    let perSec = 0;
    if (u.pressure.flank) perSec += 3;
    if (u.pressure.rear) perSec += 6;
    if (u.pressure.fear) perSec += u.type.class === 'cavalry' ? 6 : 4;
    if (u.fatigue > 0.75) perSec += 0.6;
    let routingNear = 0;
    for (const f of this.units) {
      if (f !== u && f.side === u.side && f.state === 'routing' && Math.hypot(f.x - u.x, f.z - u.z) < 70) routingNear++;
    }
    perSec += Math.min(5, routingNear * 1.8);
    shock += (perSec / resil) * DT;
    u.moraleCap = 100 - 45 * u.lostFraction;
    const calm = u.contacts.length === 0 && u.sinceShot > 4 && u.state !== 'routing';
    const recover = calm ? (2 + (genNear ? 1 : 0)) * DT : 0;
    u.morale = Math.max(0, Math.min(u.moraleCap, u.morale + recover) - shock);

    const m = u.morale;
    const mine = u.side === this.player;
    const nearest = this.nearestEnemy(u, () => true);
    const enemyDist = nearest ? Math.hypot(nearest.x - u.x, nearest.z - u.z) : Infinity;
    switch (u.state) {
      case 'steady':
        if (m < TUNING.routAt) this.rout(u);
        else if (m < TUNING.waverAt) {
          u.setState('wavering');
          if (mine) this.say(u.side, `${u.name} are wavering.`, 'warn');
        }
        break;
      case 'wavering':
        if (m < TUNING.routAt) this.rout(u);
        else if (m < TUNING.retreatAt) {
          u.setState('retreating');
          this.say(u.side, `${u.name} fall back.`, mine ? 'warn' : 'good');
        } else if (m >= TUNING.steadyAt) u.setState('steady');
        break;
      case 'retreating':
        if (m < TUNING.routAt || (u.stateTime > 5 && u.contacts.length > 0)) this.rout(u);
        else if (m > TUNING.regroupAt && u.contacts.length === 0) {
          u.setState('steady');
          u.stance = 'hold';
          this.say(u.side, `${u.name} regroup.`, mine ? 'good' : 'warn');
        }
        break;
      case 'routing':
        if (enemyDist > TUNING.rallyClear && u.stateTime > 6 && u.rallies < 2) {
          u.rallies++;
          u.setState('rallying');
          this.say(u.side, `${u.name} try to rally.`, 'info');
        }
        break;
      case 'rallying':
        u.morale = Math.min(u.moraleCap, u.morale + 3 * DT);
        if (enemyDist < 50) u.setState('routing');
        else if (u.morale > TUNING.rallyTo) {
          u.setState('steady');
          u.stance = 'hold';
          this.say(u.side, `${u.name} have rallied.`, mine ? 'good' : 'warn');
        }
        break;
    }
  }

  private rout(u: Unit) {
    u.setState('routing');
    const elephant = u.type.class === 'elephant';
    this.say(u.side, elephant ? `${u.name} panic and stampede!` : `${u.name} are routing!`, u.side === this.player ? 'bad' : 'good');
  }

  private checkGenerals() {
    for (const info of this.sides.values()) {
      if (info.generalLost) continue;
      const g = this.general(info.id);
      if (!g || (g.alive && g.state !== 'routing')) continue;
      info.generalLost = true;
      const fell = !g.alive;
      this.say(info.id, fell ? `${g.name}: the general has fallen!` : `${g.name}: the general flees!`, info.id === this.player ? 'bad' : 'good');
      for (const u of this.units) if (u.side === info.id && u.alive) u.morale -= (fell ? 20 : 12) / u.resilience;
    }
  }

  /** Fighting value of a unit: weights armoured shock troops above light horse. */
  static power(u: Unit, men = u.men): number {
    const t = u.type;
    return men * t.hp * (t.attack + t.armor + t.charge * 0.5);
  }

  /** Share of a side's starting fighting power that is dead, fled or routing. */
  powerLost(side: string): number {
    let start = 0, now = 0;
    for (const u of this.units) {
      if (u.side !== side) continue;
      start += Battle.power(u, u.maxMen);
      if (u.alive && u.state !== 'routing') now += Battle.power(u);
    }
    return start > 0 ? 1 - now / start : 0;
  }

  /** A side leaves the field: beaten if it has lost enough of its fighting power, otherwise indecisive. */
  concede(side: string, text: string) {
    if (this.result) return;
    const other = [...this.sides.keys()].find((k) => k !== side)!;
    if (this.powerLost(side) >= TUNING.concedeDefeat) {
      this.result = { winner: other, loser: side, text: `${text} They leave the field beaten.` };
      this.say(other, this.result.text, other === this.player ? 'good' : 'bad');
    } else {
      // Riding off largely intact is not a defeat: raiders often withdrew from a fight they could not win cheaply.
      this.result = { winner: null, loser: null, text: `${text} They leave largely intact. The battle is indecisive.` };
      this.say(side, this.result.text, 'warn');
    }
  }

  private checkVictory() {
    for (const info of this.sides.values()) {
      const s = this.sideStrength(info.id);
      if (s.activeMen < s.initial * TUNING.breakFraction || s.activeMen === 0) {
        const winner = [...this.sides.keys()].find((k) => k !== info.id)!;
        const w = this.sides.get(winner)!;
        this.result = { winner, loser: info.id, text: `${info.name} breaks. ${w.name} holds the field.` };
        this.say(winner, this.result.text, winner === this.player ? 'good' : 'bad');
        return;
      }
    }
  }
}
