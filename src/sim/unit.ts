import { toLocal, type Frame } from './geometry';
import type { AutofireRange, FormationDef, Order, UnitStatus, UnitType } from './types';

export class Unit implements Frame {
  x: number;
  z: number;
  facing: number;
  prevX: number;
  prevZ: number;
  prevFacing: number;

  hp: number;
  readonly maxHp: number;
  /** HP when the current turn began (for the casualty report). */
  hpAtTurnStart = 0;
  org: number;
  readonly baseMaxOrg: number;
  stamina: number;
  status: UnitStatus = 'standing';

  formation: string;
  /** Formation change in progress: footprint and flank rules switch at once, stats on completion (wiki). */
  pending: { to: string; ticksLeft: number } | null = null;
  changedFormationThisTurn = false;

  order: Order | null = null;
  autofire: AutofireRange = 'max';
  ammo: number;

  // Status effects, in ticks remaining.
  bim = 0; // Has Been In Melee
  takenFire = 0; // Has Taken Fire
  takenFireStrength = 0;
  /** Missile volleys landing on this unit lately (one per shooting unit per attack, fading each tick). */
  volleys = 0;
  hasRan = 0;
  startedRouting = 0;
  rotated180 = 0;
  runResetBlock = 0;
  /** Ticks spent routing (dispersed pass-through lasts DISPERSED_TICKS). */
  routTicks = 0;
  /** Ticks since last attacked (melee or ranged). */
  sinceAttacked = 999;

  /** Charge run-up 0..1; charge-ready at 1. */
  runRamp = 0;
  running = false;
  moving = false;
  /** Direction of travel on the last sub-step (for the "pointed at the target" charge rule). */
  velX = 0;
  velZ = 0;
  elevationLevel = 0;

  /** Enemy ids in contact (rebuilt each sub-step) and as of the previous tick. */
  contacts: number[] = [];
  prevTickContacts = new Set<number>();
  /** Max overlap with allies this tick (fraction of the smaller footprint), and the hard part of it. */
  overlap = 0;
  hardOverlap = 0;
  /** Last tick's organization breakdown, per turn, for the unit card. */
  orgReport = { recovery: 0, nearby: 0, suppression: 0, max: 0 };
  fleeAngle = 0;
  /** Small random deviation chosen when the unit breaks. */
  fleeDev = 0;
  /** Ticks during which this unit is revealed to the enemy because it fired. */
  revealed = 0;
  /** Distance to the locked target on the previous tick (Fallback backs away only while it closes). */
  lastTargetDist = Infinity;
  ai: { role?: string; post?: { x: number; z: number } } = {};

  constructor(
    readonly id: number,
    readonly side: string,
    readonly type: UnitType,
    readonly name: string,
    x: number,
    z: number,
    facing: number,
    readonly strength: number,
    readonly general = false,
    readonly reserve = false,
  ) {
    this.x = this.prevX = x;
    this.z = this.prevZ = z;
    this.facing = this.prevFacing = facing;
    this.maxHp = this.hp = this.hpAtTurnStart = type.hp * strength;
    this.baseMaxOrg = this.org = type.org;
    this.stamina = type.stamina;
    this.formation = type.defaultFormation;
    this.ammo = type.ranged?.ammo ?? 0;
  }

  get alive(): boolean {
    return this.status === 'standing' || this.status === 'recovering' || this.status === 'routing';
  }

  /** Only standing units take orders, see for the team and capture. */
  get standing(): boolean {
    return this.status === 'standing';
  }

  get routing(): boolean {
    return this.status === 'routing';
  }

  /** The footprint uses the incoming formation as soon as a change is ordered (wiki: half-changed units). */
  get shapeFormation(): string {
    return this.routing ? 'dispersed' : this.pending?.to ?? this.formation;
  }

  /** Footprint cache: it only changes with the shape formation (strength is fixed). Read-only to callers. */
  private readonly fp: [number, number] = [0, 0];
  private fpShape: string | null = null;

  get footprint(): readonly [number, number] {
    const shape = this.shapeFormation;
    if (shape !== this.fpShape) {
      this.fpShape = shape;
      const s = Math.sqrt(this.strength);
      if (this.routing) {
        const base = this.type.formations[this.type.defaultFormation];
        this.fp[0] = base[0] * 1.2 * s;
        this.fp[1] = Math.max(base[1] * 1.6, 16) * s;
      } else {
        const f = this.type.formations[shape] ?? this.type.formations[this.type.defaultFormation];
        this.fp[0] = f[0] * s;
        this.fp[1] = f[1] * s;
      }
    }
    return this.fp;
  }

  get frontage(): number {
    return this.footprint[0];
  }

  get depth(): number {
    return this.footprint[1];
  }

  get radius(): number {
    const f = this.footprint;
    return Math.hypot(f[0], f[1]) / 2;
  }

  get hpFrac(): number {
    return Math.max(0, this.hp / this.maxHp);
  }

  get staminaFrac(): number {
    return Math.max(0, this.stamina / this.type.stamina);
  }

  /** Org as a fraction of base max (negative while routing). */
  get orgFrac(): number {
    return this.org / this.baseMaxOrg;
  }

  /** Current maximum organization: heavy HP loss and low stamina lower it (wiki). */
  get maxOrg(): number {
    const s = this.staminaFrac;
    const stam = s <= 0.4 ? 0.85 : s >= 0.85 ? 1 : 0.85 + 0.15 * ((s - 0.4) / 0.45);
    return this.baseMaxOrg * (1 - 0.5 * (1 - this.hpFrac)) * stam;
  }

  figuresShown(): number {
    return Math.max(0, Math.ceil(this.type.figures * this.strength * this.hpFrac));
  }

  contains(px: number, pz: number, margin = 0): boolean {
    const { f, l } = toLocal(this, px, pz);
    return Math.abs(f) <= this.depth / 2 + margin && Math.abs(l) <= this.frontage / 2 + margin;
  }

  /** Formations this unit can take, in hotkey order (R, T, F, G). */
  formationSlots(): string[] {
    return Object.keys(this.type.formations);
  }
}

export type FormationTable = Record<string, FormationDef>;
