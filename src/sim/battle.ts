// WEGO battle engine after the Lines of Battle wiki (v1.7) "Turn Resolution": both sides plan, then a
// turn of 16 ticks is simulated. Orders last one turn. Deterministic: seeded RNG, fixed steps, no DOM.
import { ArmyAI } from './ai';
import {
  IMPACT, canCharge, chargeImpact, lowOrgScale, maxRange, meleeSwing, overlapScale, rangedShot, shapeForm,
  staminaScale, statForm, type CombatCtx, type Hit,
} from './combat';
import {
  ATTACK_EVERY, CLIMB_RUN, CLIMB_WALK, CONTACT_MARGIN, DISPERSED_TICKS, ELEVATION_LEVEL, MELEE_STAMINA_PER_TICK,
  ORG_FIELD_CLAMP, ORG_FIELD_SCALE, ORG_RECOVERY_SHARE, OVERLAP_RUN_RESET, PANIC_TICKS, RANGED_STAMINA_PER_TURN,
  ROUT_LOCK_TICKS, ROUTING_FIELD_MULT, RUN_RAMP_TICKS, RUN_STAMINA_PER_TURN, SAFETY_DISTANCE, STEPS_PER_TURN, SUBSTEPS,
  TICKS_PER_TURN,
} from './constants';
import {
  angleDiff, bearingFrom, nearestPoint, obbOverlap, overlapFraction, segmentHitsBox, toWorld, turnToward, wrapAngle,
} from './geometry';
import { ABOUT_FACE, ARRIVE, previewMove, steerStep, turnRadius, type MovePreview } from './pathing';
import { Rng } from './rng';
import { Terrain } from './terrain';
import type {
  AutofireRange, FormationDef, LogEntry, Order, Phase, Rules, Scenario, UnitType, Volley, XZ,
} from './types';
import { Unit } from './unit';

export interface Objective {
  id: number;
  size: 'big' | 'small' | 'hill';
  x: number;
  z: number;
  vp: number;
  owner: string | null;
  progress: number;
  /** Team currently building progress, for display. */
  capturer: string | null;
}

export interface SideInfo {
  id: string;
  name: string;
  color: string;
  ai: boolean;
  rearX: number;
  zone: [number, number, number, number];
  initialPower: number;
  vp: number;
  vpParts: { base: number; casualties: number; objectives: number; pressure: number };
  pressureTurns: number;
  pressurePenalty: number;
}

export interface BattleResult {
  winner: string | null;
  text: string;
}

/** What the renderer needs per unit per sub-step; recorded for replays. */
export interface UnitSnap {
  x: number;
  z: number;
  facing: number;
  status: Unit['status'];
  formation: string;
  frontage: number;
  depth: number;
  figures: number;
  fighting: boolean;
  routTicks: number;
  /** Visibility level to the player's team: 0 hidden .. 4 fully visible. */
  seen: number;
}

export interface Frame {
  units: UnitSnap[];
  volleys: Volley[];
}

const SPOT_BANDS: [number, number][] = [[0.45, 4], [0.7, 3], [0.85, 2], [1, 1]];

export class Battle implements CombatCtx {
  readonly terrain: Terrain;
  readonly units: Unit[] = [];
  readonly sides = new Map<string, SideInfo>();
  readonly objectives: Objective[] = [];
  readonly forms: Record<string, FormationDef>;
  readonly rules: Rules;
  readonly rng: Rng;
  readonly player: string;
  phase: Phase = 'deployment';
  /** Turn 1 is deployment. */
  turn = 1;
  tick = 0;
  sub = 0;
  log: LogEntry[] = [];
  /** Recorded sub-step frames of the turn in progress, and of the last finished turn (replays). */
  frames: Frame[] = [];
  lastTurnFrames: Frame[] = [];
  result: BattleResult | null = null;
  /** vision[side][unitId] = level 0..4 */
  vision = new Map<string, number[]>();
  /** Per-unit organization field this tick (per turn, clamped). */
  private fields: number[] = [];
  /** Formation the player has queued for each unit this turn (applied when the turn starts). */
  readonly plannedFormation = new Map<number, string>();
  private readonly ais: ArmyAI[] = [];
  private frameVolleys: Volley[] = [];
  /** Units that fired this tick (they don't recover stamina). */
  private firedThisTick = new Set<number>();

  constructor(readonly scenario: Scenario, types: Record<string, UnitType>, forms: Record<string, FormationDef>) {
    this.forms = forms;
    this.rules = scenario.rules;
    this.terrain = new Terrain(scenario.terrain.size, scenario.terrain.hills, scenario.terrain.river);
    this.rng = new Rng(scenario.seed);
    this.player = scenario.player;
    for (const [sideId, side] of Object.entries(scenario.sides)) {
      for (const su of side.units) {
        const type = types[su.type];
        if (!type) throw new Error(`Unknown unit type "${su.type}"`);
        for (const f of Object.keys(type.formations)) if (!forms[f]) throw new Error(`Unknown formation "${f}" on ${type.id}`);
        const u = new Unit(this.units.length, sideId, type, su.name ?? type.name, su.pos[0], su.pos[1], (su.facing * Math.PI) / 180, su.strength ?? 1, su.general, su.reserve);
        u.elevationLevel = Math.floor(this.terrain.height(u.x, u.z) / ELEVATION_LEVEL);
        this.units.push(u);
      }
      const vp = { base: this.rules.vpBase, casualties: 0, objectives: 0, pressure: 0 };
      this.sides.set(sideId, {
        id: sideId, name: side.name, color: side.color, ai: !!side.ai, rearX: side.rearX, zone: side.deployZone,
        initialPower: 0, vp: 0, vpParts: vp, pressureTurns: 0, pressurePenalty: 0,
      });
      for (const o of side.objectives) {
        this.objectives.push({ id: this.objectives.length, size: o.size, x: o.pos[0], z: o.pos[1], vp: this.rules.objectiveVp[o.size], owner: sideId, progress: 0, capturer: null });
      }
      if (side.ai) this.ais.push(new ArmyAI(sideId));
    }
    for (const s of this.sides.values()) s.initialPower = this.power(s.id);
    this.fields = this.units.map(() => 0);
    this.updateVision();
    this.scoreVictoryPoints(false);
    this.frames = [this.snapshot()];
    this.lastTurnFrames = [];
  }

  // ================================================================ queries

  unit(id: number): Unit {
    return this.units[id];
  }

  form(u: Unit): FormationDef {
    return statForm(this, u);
  }

  /** CombatCtx: organization field for a unit (per turn). */
  field(u: Unit): number {
    return this.fields[u.id] ?? 0;
  }

  alliesNear(u: Unit, range: number): number {
    let n = 0;
    for (const o of this.units) {
      if (o !== u && o.side === u.side && (o.standing || o.status === 'recovering') && Math.hypot(o.x - u.x, o.z - u.z) <= range) n++;
    }
    return n;
  }

  /** Visibility level of `u` to `side` (0 hidden .. 4 fully visible; own units always 4). */
  seen(side: string, u: Unit): number {
    if (u.side === side) return 4;
    return this.vision.get(side)?.[u.id] ?? 0;
  }

  enemiesOf(u: Unit): Unit[] {
    return this.units.filter((o) => o.side !== u.side && o.alive);
  }

  battleTurn(): number {
    return this.turn - 1;
  }

  private say(side: string, text: string, kind: LogEntry['kind'] = 'info') {
    this.log.push({ turn: this.battleTurn(), side, text, kind });
  }

  private mine(side: string): Unit[] {
    return this.units.filter((u) => u.side === side);
  }

  /** Army power for casualty scoring: HP times combat value; routing units count half (wiki). */
  power(side: string): number {
    let p = 0;
    for (const u of this.mine(side)) {
      if (!u.alive) continue;
      const t = u.type;
      const value = t.melee.attack + t.melee.defense + t.melee.chargeBonus * 0.3 + (t.ranged ? t.ranged.attack * 3 : 0);
      p += u.hp * value * (u.routing ? 0.5 : 1);
    }
    return p;
  }

  powerLost(side: string): number {
    const s = this.sides.get(side)!;
    return s.initialPower > 0 ? 1 - this.power(side) / s.initialPower : 0;
  }

  // ================================================================ planning API

  /** May the player (or AI) give this unit orders right now? */
  canCommand(id: number): boolean {
    const u = this.units[id];
    return u.standing && (this.phase === 'planning' || this.phase === 'deployment');
  }

  /** One order per unit; a new order replaces the old one (wiki "Orders"). */
  setOrder(id: number, order: Order | null) {
    if (!this.canCommand(id)) return;
    const u = this.units[id];
    if (order && !this.orderAllowed(u, order.type)) {
      // Melee-only units given Fire and Advance walk the path instead (wiki).
      if (order.type === 'fireAdvance' && !u.type.ranged) order = { ...order, type: 'walk' };
      else return;
    }
    u.order = order;
  }

  orderAllowed(u: Unit, type: Order['type']): boolean {
    if (type === 'shoot' || type === 'fireAdvance') return !!u.type.ranged || type === 'fireAdvance';
    return true;
  }

  /** Queue a formation change; applied when the turn starts. One change per unit per turn (wiki). */
  setFormation(id: number, formation: string) {
    const u = this.units[id];
    if (!this.canCommand(id) || !u.type.formations[formation] || this.forms[formation]?.selectable === false) return;
    if (this.phase === 'deployment') {
      u.formation = formation;
      u.pending = null;
      return;
    }
    if (u.bim > 0) return; // blocked after recent melee
    if (formation === (u.pending?.to ?? u.formation)) this.plannedFormation.delete(id);
    else this.plannedFormation.set(id, formation);
  }

  setAutofire(id: number, range: AutofireRange) {
    const u = this.units[id];
    if (u.side !== this.player && !this.sides.get(u.side)!.ai) return;
    u.autofire = range;
  }

  /** Deployment turn: place a unit inside its zone (wiki: dragging moves and turns units within the zone). */
  deploy(id: number, x: number, z: number, facing: number) {
    if (this.phase !== 'deployment') return;
    const u = this.units[id];
    const [x0, z0, x1, z1] = this.sides.get(u.side)!.zone;
    u.x = u.prevX = Math.max(x0, Math.min(x1, x));
    u.z = u.prevZ = Math.max(z0, Math.min(z1, z));
    u.facing = u.prevFacing = facing;
    for (let i = 0; i < 30 && this.terrain.inWater(u.x, u.z); i++) u.z += u.z > this.terrain.depth / 2 ? -5 : 5;
    u.elevationLevel = Math.floor(this.terrain.height(u.x, u.z) / ELEVATION_LEVEL);
    this.frames = [this.snapshot()];
  }

  /** Submit the turn. Deployment ends; otherwise the AI plans and resolution begins. */
  endTurn() {
    if (this.result) return;
    if (this.phase === 'deployment') {
      for (const u of this.units) u.order = null;
      this.spawnNeutralHills();
      this.turn = 2;
      this.phase = 'planning';
      this.say(this.player, 'Deployment ends. Neutral hills are revealed between the armies.', 'info');
      this.frames = [this.snapshot()];
      return;
    }
    if (this.phase !== 'planning') return;
    for (const ai of this.ais) ai.plan(this);
    // Formation changes apply at the start of processing (wiki), before the first tick.
    for (const [id, to] of this.plannedFormation) {
      const u = this.units[id];
      if (!u.standing || u.bim > 0) continue;
      const leave = this.forms[u.formation].breakTicks;
      const enter = this.forms[to].formTicks;
      u.pending = leave + enter > 0 ? { to, ticksLeft: leave + enter } : null;
      if (!u.pending) u.formation = to;
      u.changedFormationThisTurn = true;
    }
    this.plannedFormation.clear();
    for (const u of this.units) {
      u.lastTargetDist = Infinity;
      u.hpAtTurnStart = u.hp;
    }
    this.phase = 'resolving';
    this.tick = 0;
    this.sub = 0;
    this.frames = [this.snapshot()];
  }

  /** Resolve the whole turn synchronously (tests, headless play). */
  resolveTurn() {
    if (this.phase !== 'resolving') this.endTurn();
    while (this.phase === 'resolving') this.stepSub();
  }

  // ================================================================ resolution

  /** One movement sub-step; tick-level steps run on the last sub-step of each tick. Returns true when the turn ends. */
  stepSub(): boolean {
    if (this.phase !== 'resolving') return true;
    if (this.sub === 0) this.beginTick();
    for (const u of this.units) {
      u.prevX = u.x;
      u.prevZ = u.z;
      u.prevFacing = u.facing;
      if (u.alive) this.move(u);
    }
    this.collide();
    this.sub++;
    if (this.sub === SUBSTEPS) {
      this.endTick();
      this.sub = 0;
      this.tick++;
    }
    this.frames.push(this.snapshot());
    if (this.tick === TICKS_PER_TURN) {
      this.finishTurn();
      return true;
    }
    return false;
  }

  /** Steps 2-3 of a tick: autofire targets are chosen in endTick; routers pick their flee direction here. */
  private beginTick() {
    this.firedThisTick.clear();
    for (const u of this.units) if (u.routing) this.chooseFlee(u);
  }

  /** Distance a unit can cover in one turn under an order type (used for the order preview). */
  reach(u: Unit, type: Order['type']): number {
    if (type === 'rotate' || type === 'shoot') return 0;
    const sp = this.speeds(u);
    let d = type === 'run' ? sp.run : sp.walk;
    if (type === 'fallback') d *= u.type.category === 'cavalry' ? 0.7 : 0.65;
    return d;
  }

  private canAboutFace(u: Unit): boolean {
    const cat = u.type.category;
    return this.form(u).aboutFace && (cat === 'infantry' || cat === 'cavalry' || cat === 'missile');
  }

  /** Speed and turn rate a path order moves at (per turn), for planning and the preview. */
  private orderMotion(u: Unit, type: Order['type']): { speed: number; turn: number } {
    const sp = this.speeds(u);
    const cat = u.type.category;
    // Running infantry and cavalry turn slower (the battle applies this once the run starts).
    const turn = type === 'run' && (cat === 'infantry' || cat === 'cavalry') && !u.running ? sp.turn * 0.7 : sp.turn;
    return { speed: this.reach(u, type), turn };
  }

  /**
   * Turning radius for planning a curved path (wiki: worked out from the fastest the unit could go
   * on that order, not the speed it is managing), with a little slack.
   */
  turnRadius(u: Unit, type: Order['type']): number {
    const { speed, turn } = this.orderMotion(u, type);
    const sp = this.speeds(u);
    return turnRadius(Math.max(speed, type === 'run' ? sp.run : sp.walk), turn) * 1.1;
  }

  /** This turn's movement for a path order, run through the battle's own steering law. */
  previewOrder(u: Unit, o: Order): MovePreview {
    const { speed, turn } = this.orderMotion(u, o.type);
    return previewMove(u, o.path ?? [], speed, turn, STEPS_PER_TURN, SUBSTEPS, {
      backwards: o.type === 'fallback', aboutFace: this.canAboutFace(u), finalFacing: o.facing,
    });
  }

  speeds(u: Unit): { walk: number; run: number; turn: number } {
    const f = this.form(u);
    const t = u.type;
    const W = t.walk;
    let walk = W * (1 + f.walkMod);
    let sprint = Math.max(0, t.run - t.walk) * (1 + f.runMod) * (1 - 0.8 * staminaScale(u));
    let pen = (1 - 0.2 * lowOrgScale(u)) * (1 - 0.4 * overlapScale(u)) * (u.takenFire > 0 ? 0.9 : 1);
    pen *= this.terrain.speedFactor(u.x, u.z, t.category);
    walk *= pen;
    sprint *= pen;
    walk = Math.max(walk, f.speedFloor * W);
    let run = walk + sprint;
    if (u.pending) {
      const incoming = this.forms[u.pending.to];
      if (incoming.rootedWhileForming) walk = run = 0;
      else {
        const cap = Math.max(incoming.speedFloor * W, W * (1 + incoming.walkMod));
        walk = Math.min(walk, cap);
        run = Math.min(run, cap + sprint);
      }
    }
    let turn = (f.turnRate * Math.PI) / 180;
    turn *= 1 - 0.2 * lowOrgScale(u);
    if (u.running && (t.category === 'infantry' || t.category === 'cavalry')) turn *= 0.7;
    return { walk, run, turn };
  }

  private nearestEnemy(u: Unit, filter: (o: Unit) => boolean): Unit | null {
    let best: Unit | null = null;
    let bd = Infinity;
    for (const o of this.units) {
      if (o.side === u.side || !o.alive || !filter(o)) continue;
      const d = Math.hypot(o.x - u.x, o.z - u.z);
      if (d < bd) (bd = d), (best = o);
    }
    return best;
  }

  private move(u: Unit) {
    u.moving = false;
    u.running = false;
    if (u.routing) return this.flee(u);
    if (u.rotated180 > 0) return; // about-face in progress: the unit stands
    const sp = this.speeds(u);
    const dt = 1 / STEPS_PER_TURN;
    const turnStep = sp.turn * dt;

    if (u.status === 'recovering') {
      // Recovering units take no orders but turn to face the nearest non-routing enemy (wiki).
      const e = this.nearestEnemy(u, (o) => !o.routing && this.seen(u.side, o) > 0);
      if (e) u.facing = turnToward(u.facing, Math.atan2(e.z - u.z, e.x - u.x), turnStep);
      return;
    }
    const o = u.order;
    if (!o) return;
    const target = o.target !== undefined ? this.units[o.target] : null;
    if (target && (!target.alive || this.seen(u.side, target) === 0)) {
      // A lost or vanished target ends the lock; the unit stands.
      u.order = null;
      return;
    }

    if (o.type === 'rotate') {
      u.facing = turnToward(u.facing, o.facing ?? u.facing, turnStep);
      if (Math.abs(angleDiff(u.facing, o.facing ?? u.facing)) < 0.01) u.order = null;
      return;
    }
    if (o.type === 'shoot') {
      if (target && !this.inArc(u, target)) u.facing = turnToward(u.facing, Math.atan2(target.z - u.z, target.x - u.x), turnStep);
      return;
    }

    // Movement orders: work out where we're heading this sub-step.
    let goal: XZ | null = null;
    let finalFacing: number | null = null;
    let backwards = o.type === 'fallback';
    if (o.follow !== undefined) {
      const f = this.units[o.follow];
      if (!f.alive) {
        u.order = null;
        return;
      }
      const gap = f.depth / 2 + u.depth / 2 + 2;
      goal = { x: f.x - Math.cos(f.facing) * gap, z: f.z - Math.sin(f.facing) * gap };
      finalFacing = f.facing;
    } else if (target) {
      const d = Math.hypot(target.x - u.x, target.z - u.z);
      if (o.type === 'fireAdvance' && u.type.ranged) {
        if (d <= u.type.ranged.weapon.effective) {
          if (!this.inArc(u, target)) u.facing = turnToward(u.facing, Math.atan2(target.z - u.z, target.x - u.x), turnStep);
          u.lastTargetDist = d;
          return;
        }
        goal = { x: target.x, z: target.z };
      } else if (o.type === 'fallback') {
        const closing = d < u.lastTargetDist - 0.01;
        u.lastTargetDist = d;
        const face = Math.atan2(target.z - u.z, target.x - u.x);
        u.facing = turnToward(u.facing, face, turnStep);
        if (!closing) return;
        goal = { x: u.x - Math.cos(face) * 50, z: u.z - Math.sin(face) * 50 };
        backwards = true;
      } else {
        goal = nearestPoint(target, u.x, u.z);
      }
      u.lastTargetDist = d;
    } else if (o.path && o.path.length) {
      while (o.path.length && Math.hypot(o.path[0].x - u.x, o.path[0].z - u.z) < ARRIVE) o.path.shift();
      goal = o.path[0] ?? null;
      if (o.path.length <= 1) finalFacing = o.facing ?? null;
      if (o.type === 'fireAdvance' && u.type.ranged) {
        // Advancing stops while any enemy is inside stand-off distance; the order is kept (wiki).
        const sd = u.type.ranged.weapon.effective;
        if (this.units.some((e) => e.side !== u.side && e.alive && !e.routing && this.seen(u.side, e) > 0 && Math.hypot(e.x - u.x, e.z - u.z) < sd)) goal = null;
      }
    }
    if (!goal) {
      if (finalFacing !== null || (o.path && o.path.length === 0 && o.facing !== undefined)) {
        const ff = finalFacing ?? o.facing!;
        u.facing = turnToward(u.facing, ff, turnStep);
        if (Math.abs(angleDiff(u.facing, ff)) < 0.01 && o.path && o.path.length === 0) u.order = null;
      } else if (o.path && o.path.length === 0) {
        u.order = null;
      }
      return;
    }

    const dx = goal.x - u.x, dz = goal.z - u.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.5) return;
    const heading = Math.atan2(dz, dx);
    const want = backwards ? wrapAngle(heading + Math.PI) : heading;
    const diff = Math.abs(angleDiff(u.facing, want));
    // Turning delay: a sharp reversal makes infantry and cavalry stop and about-face (wiki).
    if (diff > ABOUT_FACE && !backwards && this.canAboutFace(u)) {
      u.rotated180 = 2;
      u.runRamp = 0;
      return;
    }
    const cat = u.type.category;
    const run = o.type === 'run' && u.staminaFrac > 0;
    let speed = run ? sp.run : sp.walk;
    if (o.type === 'fallback') speed *= cat === 'cavalry' ? 0.7 : 0.65;
    if (o.type === 'fireAdvance' && this.firedThisTick.has(u.id)) speed *= u.type.category === 'skirmisher' ? 0.6 : 0.9;
    const st = steerStep(u, goal, backwards, turnStep, speed * dt);
    u.facing = st.facing;
    const step = st.step;
    if (step <= 0) return;
    u.x += Math.cos(heading) * step;
    u.z += Math.sin(heading) * step;
    u.x = Math.max(1, Math.min(this.terrain.width - 1, u.x));
    u.z = Math.max(1, Math.min(this.terrain.depth - 1, u.z));
    u.velX = Math.cos(heading);
    u.velZ = Math.sin(heading);
    u.moving = true;
    if (run) {
      u.running = true;
      u.hasRan = Math.max(u.hasRan, 2);
      const water = this.terrain.waterFactor(u.x, u.z);
      u.stamina = Math.max(0, u.stamina - (RUN_STAMINA_PER_TURN / STEPS_PER_TURN) * (1 + 1.5 * water));
    }
    this.climb(u, run);
  }

  /** Elevation level changes cost stamina; stepping straight back isn't charged twice (wiki). */
  private climb(u: Unit, running: boolean) {
    const lvl = Math.floor(this.terrain.height(u.x, u.z) / ELEVATION_LEVEL);
    if (lvl === u.elevationLevel) return;
    u.stamina = Math.max(0, u.stamina - (running ? CLIMB_RUN : CLIMB_WALK));
    u.elevationLevel = lvl;
  }

  private chooseFlee(u: Unit) {
    // Flee from the nearest standing enemies toward our own side, with a small random deviation (wiki).
    const rear = this.sides.get(u.side)!.rearX;
    let fx = Math.sign(rear - u.x) || -1, fz = 0;
    if (u.type.stampede) fx *= 0.2; // panicked elephants just bolt away from the threat
    for (const e of this.units) {
      if (e.side === u.side || !e.standing) continue;
      const d = Math.hypot(e.x - u.x, e.z - u.z);
      if (d > 250 || d < 1) continue;
      const w = (u.type.stampede ? 3 : 1.5) * (60 / d) ** 2;
      fx += ((u.x - e.x) / d) * w;
      fz += ((u.z - e.z) / d) * w;
    }
    u.fleeAngle = Math.atan2(fz, fx) + u.fleeDev;
  }

  private isSafe(u: Unit): boolean {
    if (u.sinceAttacked < 4) return false;
    return !this.units.some((e) => e.side !== u.side && e.standing && Math.hypot(e.x - u.x, e.z - u.z) < SAFETY_DISTANCE);
  }

  private flee(u: Unit) {
    const sp = this.speeds(u);
    const safe = this.isSafe(u);
    // A Safe router drops to a walk and stops paying the routing run cost (wiki).
    const speed = safe ? sp.walk : Math.max(sp.run, sp.walk * 1.3);
    const dt = 1 / STEPS_PER_TURN;
    u.facing = u.fleeAngle;
    const step = speed * dt;
    u.x += Math.cos(u.fleeAngle) * step;
    u.z += Math.sin(u.fleeAngle) * step;
    u.velX = Math.cos(u.fleeAngle);
    u.velZ = Math.sin(u.fleeAngle);
    u.moving = true;
    u.running = !safe;
    if (!safe) {
      const cost = u.startedRouting > 0 ? 220 : 110; // high right after breaking, cheaper later (estimates)
      u.stamina = Math.max(0, u.stamina - cost / STEPS_PER_TURN);
    }
    const out = u.x < 2 || u.z < 2 || u.x > this.terrain.width - 2 || u.z > this.terrain.depth - 2;
    if (out) {
      // A router low in both org and HP that reaches the map edge deserts permanently (wiki).
      if (u.orgFrac < u.type.orgMarks.recover && u.hpFrac < 0.6) {
        u.status = 'deserted';
        this.say(u.side, `${u.name} desert the field.`, u.side === this.player ? 'bad' : 'good');
      }
      u.x = Math.max(2, Math.min(this.terrain.width - 2, u.x));
      u.z = Math.max(2, Math.min(this.terrain.depth - 2, u.z));
    }
  }

  // ---------------------------------------------------------------- collisions (step 4)

  private enemyLevel(u: Unit): number {
    if (u.routing) return u.routTicks < DISPERSED_TICKS ? -1 : 0;
    return shapeForm(this, u).collision.enemy;
  }

  private allyLevel(u: Unit): number {
    if (u.routing) return -1;
    return shapeForm(this, u).collision.ally;
  }

  private collide() {
    const live = this.units.filter((u) => u.alive);
    for (const u of live) {
      u.contacts = [];
      if (this.sub === 0) u.overlap = u.hardOverlap = 0;
    }
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i], b = live[j];
        if (Math.hypot(a.x - b.x, a.z - b.z) > a.radius + b.radius + CONTACT_MARGIN) continue;
        if (a.side !== b.side) {
          const ov = obbOverlap(a, b, CONTACT_MARGIN);
          if (!ov) continue;
          // Enemy overlap always starts melee, even when levels allow pass-through (wiki).
          a.contacts.push(b.id);
          b.contacts.push(a.id);
          if (ov.depth <= 0) continue;
          const la = this.enemyLevel(a), lb = this.enemyLevel(b);
          if (la < 0 || lb < 0) continue;
          if (la === lb) {
            this.push(a, ov.nx, ov.nz, ov.depth / 2);
            this.push(b, -ov.nx, -ov.nz, ov.depth / 2);
          } else if (la < lb) this.push(a, ov.nx, ov.nz, ov.depth);
          else this.push(b, -ov.nx, -ov.nz, ov.depth);
        } else {
          if (a.routing || b.routing) continue; // routers are exempt both ways (wiki)
          const ov = obbOverlap(a, b);
          if (!ov) continue;
          const frac = overlapFraction(a, b);
          const la = this.allyLevel(a), lb = this.allyLevel(b);
          if (la >= 0 && lb >= 0) {
            a.overlap = Math.max(a.overlap, frac);
            b.overlap = Math.max(b.overlap, frac);
            a.hardOverlap = Math.max(a.hardOverlap, frac);
            b.hardOverlap = Math.max(b.hardOverlap, frac);
            // Overlapping allies are nudged apart at a fraction of walking speed.
            const nudge = Math.min(ov.depth / 2, (0.3 * Math.min(a.type.walk, b.type.walk)) / STEPS_PER_TURN);
            this.push(a, ov.nx, ov.nz, nudge);
            this.push(b, -ov.nx, -ov.nz, nudge);
          } else if (la < 0 && lb >= 0) a.overlap = Math.max(a.overlap, frac);
          else if (lb < 0 && la >= 0) b.overlap = Math.max(b.overlap, frac);
        }
      }
    }
  }

  private push(u: Unit, nx: number, nz: number, d: number) {
    u.x = Math.max(1, Math.min(this.terrain.width - 1, u.x + nx * d));
    u.z = Math.max(1, Math.min(this.terrain.depth - 1, u.z + nz * d));
  }

  // ---------------------------------------------------------------- tick steps 5-9

  private endTick() {
    const attackTick = this.tick % ATTACK_EVERY === ATTACK_EVERY - 1;
    this.computeFields();
    const hits = new Map<number, Hit>();
    const add = (id: number, h: Hit) => {
      const cur = hits.get(id) ?? { hp: 0, org: 0 };
      hits.set(id, { hp: cur.hp + h.hp, org: cur.org + h.org });
    };
    const meleeHit = new Set<number>();

    // Charges land on the first contact tick, bypassing the attack cooldown.
    for (const a of this.units) {
      if (!a.alive) continue;
      for (const id of a.contacts) {
        if (a.prevTickContacts.has(id)) continue;
        const d = this.units[id];
        if (canCharge(this, a, d)) {
          const r = chargeImpact(this, a, d);
          add(d.id, r.defender);
          add(a.id, r.attacker);
          a.stamina = Math.max(0, a.stamina - r.staminaA);
          d.stamina = Math.max(0, d.stamina - r.staminaD);
          const where = r.flank > 0.66 ? ' in the rear' : r.flank > 0.2 ? ' in the flank' : '';
          this.say(a.side, `${a.name} charge ${d.name}${where}!`, a.side === this.player ? 'good' : 'warn');
          meleeHit.add(a.id).add(d.id);
          a.bim = Math.max(a.bim, d.type.melee.weapon.bimTicks);
          d.bim = Math.max(d.bim, a.type.melee.weapon.bimTicks);
        } else if (this.canDash(a, d)) {
          // A dash: running into the enemy without a proper charge still lands a (smaller) blow, by weight.
          const r = chargeImpact(this, a, d, IMPACT.dashBase + IMPACT.dashRamp * a.runRamp);
          add(d.id, r.defender);
          add(a.id, r.attacker);
          a.stamina = Math.max(0, a.stamina - r.staminaA * 0.5);
          meleeHit.add(a.id).add(d.id);
          a.bim = Math.max(a.bim, d.type.melee.weapon.bimTicks);
          d.bim = Math.max(d.bim, a.type.melee.weapon.bimTicks);
          if (r.defender.org > r.attacker.org * 2) this.say(a.side, `${a.name} crash into ${d.name}!`, a.side === this.player ? 'good' : 'warn');
          else if (r.attacker.org > r.defender.org) this.say(a.side, `${a.name} run onto ${d.name} and recoil.`, a.side === this.player ? 'warn' : 'good');
          a.runRamp = 0;
        } else if (!d.routing && this.enemyLevel(d) >= 1) {
          a.runRamp = 0; // hitting a solid enemy resets the run-up
        }
      }
    }

    if (attackTick) {
      for (const a of this.units) {
        if (!a.alive || a.contacts.length === 0) continue;
        if (a.routing && a.routTicks < DISPERSED_TICKS) continue;
        const n = a.contacts.length;
        for (const id of a.contacts) {
          const d = this.units[id];
          const h = meleeSwing(this, a, d);
          add(d.id, { hp: h.hp / n, org: h.org / n });
          if (h.hp > 0) {
            meleeHit.add(d.id);
            d.bim = a.type.melee.weapon.bimTicks; // a new application replaces the remaining duration
            a.bim = Math.max(a.bim, 1);
          }
        }
      }
      this.missiles(add);
    }
    this.trample(add);

    // Damage is applied after all pairs are calculated (wiki).
    for (const [id, h] of hits) {
      const u = this.units[id];
      if (!u.alive) continue;
      u.hp -= h.hp;
      u.org -= h.org;
      if (h.hp > 0 || h.org > 0) u.sinceAttacked = 0;
    }
    for (const id of meleeHit) {
      const u = this.units[id];
      if (u.pending) u.pending = null; // a melee hit cancels a formation change
      u.runRamp = 0;
    }
    for (const u of this.units) if (u.alive) this.updateUnit(u);
    this.capture();
    this.updateVision();
    for (const u of this.units) u.prevTickContacts = new Set(u.contacts);
  }

  private computeFields() {
    for (const u of this.units) {
      if (!u.alive) {
        this.fields[u.id] = 0;
        continue;
      }
      let sum = 0;
      for (const w of this.units) {
        if (w === u || !w.alive) continue;
        const panic = w.routing && w.startedRouting > ROUT_LOCK_TICKS - PANIC_TICKS;
        if (w.routing && !panic) continue;
        let radius = w.type.orgRadius * (1 - 0.6 * overlapScale(w));
        if (panic) radius *= 1.5;
        if (Math.hypot(w.x - u.x, w.z - u.z) > radius) continue;
        let c = w.type.orgRadiusBonus * ORG_FIELD_SCALE * w.hpFrac * (w.general ? 1.4 : 1);
        if (panic) c = -c; // a fresh rout drains friends and feeds enemies
        if (w.side === u.side) sum += c;
        else if (w.standing || panic) sum -= c;
      }
      if (u.routing) sum *= ROUTING_FIELD_MULT;
      this.fields[u.id] = Math.max(-ORG_FIELD_CLAMP, Math.min(ORG_FIELD_CLAMP, sum));
    }
  }

  private inArc(s: Unit, t: Unit): boolean {
    const f = shapeForm(this, s);
    if (f.fire === 'all' || f.fire === 'four') return true;
    const p = nearestPoint(t, s.x, s.z);
    return bearingFrom(s, p.x, p.z) <= f.arc / 2 + 5;
  }

  /** Firing emitters: points on each firing edge with their outward direction and arc. */
  private emitters(s: Unit): { x: number; z: number; dir: number; arc: number }[] {
    const f = shapeForm(this, s);
    if (f.fire === 'all') return [{ x: s.x, z: s.z, dir: s.facing, arc: 360 }];
    if (f.fire === 'four') {
      return [0, 1, 2, 3].map((k) => {
        const dir = s.facing + (k * Math.PI) / 2;
        const p = toWorld(s, Math.cos(dir - s.facing) * (s.depth / 2), Math.sin(dir - s.facing) * (s.frontage / 2));
        return { x: p.x, z: p.z, dir, arc: f.arc };
      });
    }
    const out = [];
    for (let i = 0; i < f.emitters; i++) {
      const l = ((i + 0.5) / f.emitters - 0.5) * s.frontage;
      const p = toWorld(s, s.depth / 2, l);
      out.push({ x: p.x, z: p.z, dir: s.facing, arc: f.arc });
    }
    return out;
  }

  private blocked(s: Unit, ex: number, ez: number, tx: number, tz: number): boolean {
    for (const a of this.units) {
      if (a === s || a.side !== s.side || !a.alive || a.routing) continue;
      if (this.allyLevel(a) < 0) continue; // soft allies (loose order) don't block
      if (segmentHitsBox(a, ex, ez, tx, tz)) return true;
    }
    return false;
  }

  /** Ranged attacks (every 2 ticks). Autofire range setting, panic fire, blocking and arcs per the wiki. */
  /** Running into an enemy (Run order, moving at speed) that isn't a qualifying charge: a dash. */
  private canDash(a: Unit, d: Unit): boolean {
    return a.standing && !d.routing && a.order?.type === 'run' && a.running && a.runRamp >= 0.25 && a.bim === 0 && a.staminaFrac > 0.15;
  }

  private missiles(add: (id: number, h: Hit) => void) {
    for (const s of this.units) {
      const r = s.type.ranged;
      if (!r || !s.alive || s.routing || s.ammo <= 0 || s.contacts.length > 0) continue;
      const o = s.order?.type;
      if (s.standing && (o === 'walk' || o === 'run' || o === 'rotate')) continue;
      const em = this.emitters(s);
      const maxR = maxRange(r.weapon);
      const limit = s.autofire === 'close' ? r.weapon.close : s.autofire === 'effective' ? r.weapon.effective : maxR;
      const canHit = (t: Unit, range: number) => {
        const hits: { e: number; d: number }[] = [];
        em.forEach((e, k) => {
          const p = nearestPoint(t, e.x, e.z);
          const d = Math.hypot(p.x - e.x, p.z - e.z);
          if (d > range) return;
          if (e.arc < 360 && Math.abs(angleDiff(e.dir, Math.atan2(p.z - e.z, p.x - e.x))) > (e.arc * Math.PI) / 360) return;
          if (this.blocked(s, e.x, e.z, p.x, p.z)) return;
          hits.push({ e: k, d });
        });
        return hits;
      };
      let target: Unit | null = null;
      let lanes: { e: number; d: number }[] = [];
      const lock = s.order?.target !== undefined ? this.units[s.order.target] : null;
      if (lock && lock.alive && this.seen(s.side, lock) > 0 && (o === 'shoot' || o === 'fireAdvance')) {
        lanes = canHit(lock, maxR);
        if (lanes.length) target = lock;
      }
      if (!target) {
        const cands = this.units
          .filter((t) => t.side !== s.side && t.alive && this.seen(s.side, t) > 0 && !t.routing) // limited ammo: no autofire on routers
          .map((t) => ({ t, d: Math.hypot(t.x - s.x, t.z - s.z) }))
          .sort((a, b) => {
            const pa = a.d <= s.type.panicDistance ? 0 : 1, pb = b.d <= s.type.panicDistance ? 0 : 1;
            return pa - pb || a.d - b.d;
          });
        for (const { t, d } of cands) {
          const range = d <= s.type.panicDistance + t.radius ? maxR : limit;
          const h = canHit(t, range);
          if (h.length) {
            target = t;
            lanes = h;
            break;
          }
        }
      }
      if (!target) continue;
      const share = 1 / em.length;
      let fired = 0;
      for (const { d } of lanes) {
        const h = rangedShot(this, s, target, d, share);
        add(target.id, h);
        fired += share;
      }
      if (fired <= 0) continue;
      s.ammo--;
      s.stamina = Math.max(0, s.stamina - RANGED_STAMINA_PER_TURN / (TICKS_PER_TURN / ATTACK_EVERY));
      s.revealed = 4;
      this.firedThisTick.add(s.id);
      target.takenFire = 3;
      target.takenFireStrength = Math.min(1, 0.4 + fired);
      target.volleys += fired;
      const v = { side: s.side, fromX: s.x, fromZ: s.z, toX: target.x, toZ: target.z, count: Math.max(3, Math.round((s.type.figures * s.hpFrac * fired) / 6)) };
      this.frameVolleys.push(v);
    }
  }

  /** Extension: stampeding elephants trample whatever they run through. Estimate: 8 HP and 20 org per tick. */
  private trample(add: (id: number, h: Hit) => void) {
    for (const e of this.units) {
      if (!e.alive || !e.routing || !e.type.stampede) continue;
      for (const w of this.units) {
        if (w === e || !w.alive || w.type.stampede) continue;
        if (!obbOverlap(e, w)) continue;
        add(w.id, { hp: 8, org: 20 });
        w.sinceAttacked = 0;
        if (w.side === e.side && this.rng.next() < 0.15) this.say(e.side, `Panicked elephants trample their own ${w.name}!`, w.side === this.player ? 'bad' : 'warn');
      }
    }
  }

  /** Step 7: organization recovery, the nearby field, state transitions; plus stamina and statuses. */
  private updateUnit(u: Unit) {
    const t = u.type;
    const marks = t.orgMarks;
    if (u.hp <= 0) {
      u.hp = 0;
      u.status = 'destroyed';
      this.say(u.side, `${u.name} have been destroyed.`, u.side === this.player ? 'bad' : 'good');
      return;
    }

    // Recovery per turn, spread over the ticks.
    let rec = ORG_RECOVERY_SHARE * u.baseMaxOrg * (0.5 + 0.5 * u.hpFrac);
    const o = u.order?.type;
    if (u.standing && u.moving) rec *= o === 'run' ? 0.5 : o === 'walk' ? 0.75 : 0.85;
    else if (o === 'fireAdvance' || o === 'fallback') rec *= 0.85;
    const safe = this.isSafe(u);
    rec *= safe ? 2 : u.sinceAttacked >= 4 ? 1 : 0;
    rec *= this.vpRecoveryMult(u.side);
    if (u.routing) rec *= u.startedRouting > 0 || !safe ? 0 : 0.6;
    const suppression = Math.min(1, Math.max(u.bim > 0 ? 1 : 0, u.takenFire > 0 ? u.takenFireStrength : 0));
    const positive = rec * (1 - suppression);
    const field = this.fields[u.id];
    u.orgReport = { recovery: positive, nearby: field, suppression: rec - positive, max: u.maxOrg };
    u.org += (positive + field) / TICKS_PER_TURN;
    u.org = Math.min(u.org, u.maxOrg);

    // States (wiki "Organization"): route, recover, rally and shatter marks.
    const route = marks.route * u.baseMaxOrg;
    if (u.status === 'standing' || u.status === 'recovering') {
      if (u.org <= route) this.rout(u);
    } else if (u.routing) {
      if (u.org <= marks.shatter * u.baseMaxOrg) {
        u.status = 'shattered';
        this.say(u.side, `${u.name} shatter and scatter.`, u.side === this.player ? 'bad' : 'good');
        return;
      }
      if (u.startedRouting === 0 && u.org >= marks.recover * u.baseMaxOrg) {
        u.status = 'recovering';
        u.formation = t.defaultFormation;
        this.say(u.side, `${u.name} are recovering.`, 'info');
      }
    }
    if (u.status === 'recovering' && u.org >= marks.rally * u.baseMaxOrg) {
      u.status = 'standing';
      u.formation = t.defaultFormation;
      this.say(u.side, `${u.name} rally and stand again.`, u.side === this.player ? 'good' : 'warn');
    }
    if (!u.routing) u.org = Math.max(route, u.org); // non-routing units are held at the route mark

    // Stamina (wiki): melee drains; recovery only when not fighting, firing or running.
    const meleeLocked = u.contacts.some((id) => !this.units[id].routing);
    if (meleeLocked) u.stamina = Math.max(0, u.stamina - MELEE_STAMINA_PER_TICK);
    if (!meleeLocked && !this.firedThisTick.has(u.id) && !u.running && t.stamina > 0) {
      const f = u.staminaFrac;
      const band = f >= 0.8 ? 30 : f >= 0.6 ? 60 : f >= 0.4 ? 70 : f >= 0.2 ? 60 : 40;
      u.stamina = Math.min(t.stamina, u.stamina + (band / TICKS_PER_TURN) * (u.moving ? 0.5 : 1));
    }

    // Run-up toward a charge.
    if (u.running && u.order?.type === 'run' && u.runResetBlock === 0 && u.bim === 0) u.runRamp = Math.min(1, u.runRamp + 1 / RUN_RAMP_TICKS);
    else if (u.bim > 0 && u.running) u.runRamp = Math.max(0, u.runRamp - 1 / RUN_RAMP_TICKS);
    else if (!u.running) u.runRamp = 0;
    if (u.hardOverlap >= OVERLAP_RUN_RESET) {
      u.runRamp = 0;
      u.runResetBlock = 5;
    }

    // Statuses.
    if (u.rotated180 > 0 && --u.rotated180 === 0) u.facing = wrapAngle(u.facing + Math.PI);
    if (u.bim > 0) u.bim--;
    if (u.takenFire > 0) u.takenFire--;
    u.volleys *= 0.7; // recent volleys fade over a few ticks
    if (u.hasRan > 0 && !u.running) u.hasRan--;
    if (u.startedRouting > 0) u.startedRouting--;
    if (u.runResetBlock > 0) u.runResetBlock--;
    if (u.revealed > 0) u.revealed--;
    u.sinceAttacked++;
    if (u.routing) u.routTicks++;
    if (u.pending && --u.pending.ticksLeft <= 0) {
      u.formation = u.pending.to;
      u.pending = null;
    }
  }

  private rout(u: Unit) {
    u.status = 'routing';
    u.startedRouting = ROUT_LOCK_TICKS;
    u.routTicks = 0;
    u.order = null;
    u.pending = null;
    u.runRamp = 0;
    u.fleeDev = this.rng.range(-0.3, 0.3);
    this.plannedFormation.delete(u.id);
    this.chooseFlee(u);
    const text = u.type.stampede ? `${u.name} panic and stampede!` : `${u.name} break and run!`;
    this.say(u.side, text, u.side === this.player ? 'bad' : 'good');
  }

  // ---------------------------------------------------------------- objectives (step 9)

  private spawnNeutralHills() {
    const n = this.rules.neutralHills;
    if (n <= 0 || this.objectives.some((o) => o.size === 'hill')) return;
    const zones = [...this.sides.values()].map((s) => s.zone);
    const mid = (Math.min(zones[0][2], zones[1][2]) + Math.max(zones[0][0], zones[1][0])) / 2;
    for (let i = 0; i < n; i++) {
      let z = (this.terrain.depth * (i + 1)) / (n + 1);
      for (let k = 0; k < 20 && this.terrain.inWater(mid, z); k++) z -= 10;
      this.objectives.push({ id: this.objectives.length, size: 'hill', x: mid, z, vp: this.rules.objectiveVp.hill, owner: null, progress: 0, capturer: null });
    }
  }

  private capture() {
    const R = this.rules.captureRadius;
    for (const ob of this.objectives) {
      const present = new Map<string, number>();
      for (const u of this.units) {
        if (!u.standing || !u.type.canCapture) continue;
        if (Math.hypot(u.x - ob.x, u.z - ob.z) > R) continue; // only the unit's centre counts
        present.set(u.side, (present.get(u.side) ?? 0) + u.type.captureRate);
      }
      ob.capturer = null;
      const teams = [...present.keys()];
      // Progress builds only when exactly one non-owning team is present; anything else resets it (wiki).
      if (teams.length !== 1 || teams[0] === ob.owner) {
        ob.progress = 0;
        continue;
      }
      ob.capturer = teams[0];
      ob.progress += present.get(teams[0])!;
      if (ob.progress >= this.rules.capturePoints) {
        const was = ob.owner;
        ob.owner = teams[0];
        ob.progress = 0;
        const label = ob.size === 'hill' ? 'a neutral hill' : `${was ? this.sides.get(was)!.name + "'s" : 'a'} ${ob.size} objective`;
        this.say(teams[0], `${this.sides.get(teams[0])!.name} take ${label}.`, teams[0] === this.player ? 'good' : 'bad');
      }
    }
  }

  // ---------------------------------------------------------------- fog of war

  private updateVision() {
    const R = this.rules.visionRange;
    for (const side of this.sides.keys()) {
      const levels: number[] = this.units.map((u) => (u.side === side ? 4 : 0));
      const viewers = this.units.filter((u) => u.side === side && u.standing);
      for (const e of this.units) {
        if (e.side === side || !e.alive) continue;
        const reach = R * e.type.visibility;
        let best = 0;
        for (const v of viewers) {
          const d = Math.hypot(e.x - v.x, e.z - v.z);
          // Firing reveals a unit without a sight-line test; normal distance levels then apply.
          const range = e.revealed > 0 ? Math.max(reach, d) : reach;
          if (d > range) continue;
          if (e.revealed === 0 && !this.terrain.lineOfSight(v.x, v.z, e.x, e.z)) continue;
          let lvl = 1;
          for (const [frac, l] of SPOT_BANDS) {
            if (d <= reach * frac) {
              lvl = l;
              break;
            }
          }
          best = Math.max(best, lvl);
          if (best === 4) break;
        }
        levels[e.id] = best;
      }
      this.vision.set(side, levels);
    }
  }

  // ---------------------------------------------------------------- victory points

  private vpRecoveryMult(side: string): number {
    const vps = [...this.sides.values()].map((s) => s.vp);
    const avg = vps.reduce((a, b) => a + b, 0) / vps.length;
    const deficit = avg - this.sides.get(side)!.vp - 5; // grace zone (estimate)
    return deficit > 0 ? 1 - Math.min(0.6, deficit / 80) : 1;
  }

  /** Recalculated from scratch each turn: base +/- casualty difference + objectives held - pressure (wiki). */
  private scoreVictoryPoints(advancePressure: boolean) {
    const sides = [...this.sides.values()];
    const total = this.objectives.reduce((s, o) => s + o.vp, 0);
    const neutral = this.objectives.filter((o) => !o.owner).reduce((s, o) => s + o.vp, 0);
    for (const s of sides) {
      const other = sides.find((o) => o !== s)!;
      const casualties = Math.round((this.powerLost(other.id) - this.powerLost(s.id)) * 80);
      const owned = this.objectives.filter((o) => o.owner === s.id).reduce((a, o) => a + o.vp, 0);
      if (advancePressure) {
        const share = total > 0 ? (owned + neutral) / total : 1;
        if (share <= this.rules.pressureThreshold) {
          s.pressureTurns++;
          s.pressurePenalty += 3 * s.pressureTurns; // grows while it keeps climbing (rate is an estimate)
        } else s.pressureTurns = 0;
      }
      s.vpParts = { base: this.rules.vpBase, casualties, objectives: owned, pressure: -s.pressurePenalty };
      s.vp = Math.max(0, this.rules.vpBase + casualties + owned - s.pressurePenalty);
    }
  }

  /** Men represented by a unit's HP (figures scale with HP). */
  men(u: Unit, hp = u.hp): number {
    return Math.round(u.type.figures * u.strength * Math.max(0, hp) / u.maxHp);
  }

  private reportCasualties() {
    const lines: { side: string; text: string; lost: number }[] = [];
    for (const u of this.units) {
      const lost = this.men(u, u.hpAtTurnStart) - this.men(u);
      if (lost <= 0) continue;
      const mine = u.side === this.player;
      // Enemy losses are only reported for units we can make out.
      if (!mine && this.seen(this.player, u) < 3) continue;
      lines.push({ side: u.side, lost, text: `${u.name} lose ${lost} ${u.type.category === 'elephant' ? (lost === 1 ? 'elephant' : 'elephants') : 'men'} (${this.men(u)} left).` });
    }
    for (const l of lines.sort((a, b) => b.lost - a.lost)) this.say(l.side, l.text, l.side === this.player ? 'bad' : 'good');
  }

  private finishTurn() {
    this.reportCasualties();
    this.scoreVictoryPoints(true);
    const sides = [...this.sides.values()];
    // Extension: an army with nothing left standing or recovering is knocked out.
    const broken = sides.filter((s) => !this.units.some((u) => u.side === s.id && (u.standing || u.status === 'recovering')));
    const zero = sides.filter((s) => s.vp <= 0);
    const out = [...new Set([...zero, ...broken])];
    if (out.length === 1) {
      const loser = out[0];
      const winner = sides.find((s) => s !== loser)!;
      this.result = {
        winner: winner.id,
        text: broken.includes(loser) ? `${loser.name} has no formed units left. ${winner.name} wins.` : `${loser.name} is knocked out at 0 victory points. ${winner.name} wins.`,
      };
    } else if (out.length > 1) {
      this.result = { winner: null, text: 'Both armies collapse on the same turn. The battle is a tie.' };
    } else if (this.battleTurn() >= this.rules.turnLimit) {
      const [a, b] = sides;
      const gap = Math.abs(a.vp - b.vp);
      if (gap >= this.rules.tieMargin) {
        const winner = a.vp > b.vp ? a : b;
        this.result = { winner: winner.id, text: `Turn limit reached. ${winner.name} leads on points (${a.vp} : ${b.vp}) and wins.` };
      } else {
        this.result = { winner: null, text: `Turn limit reached with the scores within ${this.rules.tieMargin} points (${a.vp} : ${b.vp}). A tie.` };
      }
    }
    if (this.result) this.say(this.result.winner ?? this.player, this.result.text, this.result.winner === this.player ? 'good' : this.result.winner ? 'bad' : 'warn');

    // Orders are discarded at turn end; the remaining part of a path is re-sent next turn (wiki).
    for (const u of this.units) {
      u.changedFormationThisTurn = false;
      const o = u.order;
      if (!u.standing || !o) {
        u.order = null;
        continue;
      }
      if (o.path && o.path.length && (o.type === 'walk' || o.type === 'run' || o.type === 'fireAdvance' || o.type === 'fallback')) {
        u.order = { type: o.type, path: o.path.map((p) => ({ ...p })), facing: o.facing, continued: true };
      } else u.order = null;
    }
    this.lastTurnFrames = this.frames;
    this.frames = [this.snapshot()];
    this.phase = this.result ? 'ended' : 'planning';
    this.turn++;
    this.tick = 0;
    this.sub = 0;
  }

  // ---------------------------------------------------------------- snapshots

  snapshot(): Frame {
    const seenBy = this.vision.get(this.player);
    const units = this.units.map((u) => ({
      x: u.x, z: u.z, facing: u.facing, status: u.status, formation: u.shapeFormation,
      frontage: u.frontage, depth: u.depth, figures: u.alive ? u.figuresShown() : 0,
      fighting: u.contacts.length > 0, routTicks: u.routTicks,
      seen: u.side === this.player ? 4 : seenBy?.[u.id] ?? 0,
    }));
    const f = { units, volleys: this.frameVolleys };
    this.frameVolleys = [];
    return f;
  }
}
