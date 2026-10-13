import { toLocal, type Frame } from './geometry';
import type { MoraleState, Order, Stance, UnitType } from './types';

export class Unit implements Frame {
  // Position of the formation centre, and facing in radians.
  x: number;
  z: number;
  facing: number;
  prevX: number;
  prevZ: number;
  prevFacing: number;

  men: number;
  readonly maxMen: number;
  /** Fractional casualties waiting to become whole men. */
  private woundAcc = 0;
  /** Men lost during the current tick (feeds morale). */
  lostThisTick = 0;

  /** Current frontage in files (float while reforming) and the frontage being reformed to. */
  files: number;
  targetFiles: number;

  morale = 100;
  moraleCap = 100;
  state: MoraleState = 'steady';
  stateTime = 0;
  rallies = 0;

  stance: Stance = 'hold';
  fireAtWill = true;
  order: Order | null = null;

  speedNow = 0;
  running = false;
  runTime = 0;
  /** Seconds the unit was moving backwards this tick (used for "retreating in order"). */
  backing = false;
  fatigue = 0;

  ammo: number;
  reloadT = 0;
  /** Seconds since last melee contact / missile hit. */
  sinceMelee = 999;
  sinceShot = 999;
  /** Seconds since this unit's charge impacted; the charge bonus fades over a few seconds. */
  sinceCharge = 999;
  /** Ids of enemy units currently in contact (rebuilt each tick). */
  contacts: number[] = [];
  /** Ids in contact last tick, to detect fresh impacts. */
  prevContacts = new Set<number>();
  /** Melee pressure felt this tick (feeds morale). */
  pressure = { flank: false, rear: false, fear: false };
  /** Free-form AI memory. */
  ai: { role?: string; resting?: boolean; post?: { x: number; z: number }; until?: number } = {};

  constructor(
    readonly id: number,
    readonly side: string,
    readonly type: UnitType,
    readonly name: string,
    x: number,
    z: number,
    facing: number,
    men: number,
    readonly general = false,
    readonly reserve = false,
  ) {
    this.x = this.prevX = x;
    this.z = this.prevZ = z;
    this.facing = this.prevFacing = facing;
    this.men = this.maxMen = men;
    this.files = this.targetFiles = Math.min(type.files, Math.ceil(men / type.minRanks));
    this.ammo = type.ammo ?? 0;
  }

  get alive(): boolean {
    return this.state !== 'gone' && this.men > 0;
  }

  /** Can take orders: not routing, retreating, rallying or gone. */
  get controllable(): boolean {
    return this.state === 'steady' || this.state === 'wavering';
  }

  get fileCount(): number {
    return Math.max(1, Math.min(Math.round(this.files), this.men));
  }

  get ranks(): number {
    return Math.max(1, Math.ceil(this.men / this.fileCount));
  }

  get frontage(): number {
    return this.fileCount * this.type.spacing[0];
  }

  get depth(): number {
    return this.ranks * this.type.spacing[1];
  }

  get radius(): number {
    return Math.hypot(this.frontage, this.depth) / 2;
  }

  get resilience(): number {
    return this.type.morale / 5;
  }

  /** Frontage limits when reforming: between maxRanks deep and minRanks deep. */
  filesRange(men = this.men): [number, number] {
    const t = this.type;
    return [Math.max(1, Math.ceil(men / t.maxRanks)), Math.max(1, Math.ceil(men / t.minRanks))];
  }

  contains(px: number, pz: number, margin = 0): boolean {
    const { f, l } = toLocal(this, px, pz);
    return Math.abs(f) <= this.depth / 2 + margin && Math.abs(l) <= this.frontage / 2 + margin;
  }

  /** Apply (possibly fractional) casualties. Returns whole men lost. */
  wound(kills: number): number {
    if (kills <= 0 || this.men <= 0) return 0;
    this.woundAcc += kills;
    const whole = Math.min(this.men, Math.floor(this.woundAcc));
    this.woundAcc -= whole;
    this.men -= whole;
    this.lostThisTick += whole;
    return whole;
  }

  get lostFraction(): number {
    return 1 - this.men / this.maxMen;
  }

  setState(s: MoraleState) {
    if (s === this.state) return;
    this.state = s;
    this.stateTime = 0;
    if (s !== 'steady' && s !== 'wavering') this.order = null;
  }
}
