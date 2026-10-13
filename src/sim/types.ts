// Data model, following the Lines of Battle (v1.7) rules: HP + organization + stamina per unit,
// formation postures, WEGO turns of 16 ticks. World units are metres; the map is the x/z plane.
// Angles in data files are degrees (0 = facing +x / east); radians internally.

export type Category = 'infantry' | 'missile' | 'skirmisher' | 'cavalry' | 'elephant';
export type OrderType = 'fireAdvance' | 'run' | 'shoot' | 'walk' | 'fallback' | 'rotate';
/** Standing takes orders; Recovering fights but obeys nothing; Routing flees. The rest are gone. */
export type UnitStatus = 'standing' | 'recovering' | 'routing' | 'shattered' | 'deserted' | 'destroyed';
export type AutofireRange = 'close' | 'effective' | 'max';
export type Phase = 'deployment' | 'planning' | 'resolving' | 'ended';

export interface FormationDef {
  id: string;
  name: string;
  /** Walk modifier (Line -0.1), run modifier applied to the sprint bonus (Line -0.5). */
  walkMod: number;
  runMod: number;
  /** Degrees per turn. */
  turnRate: number;
  /** Minimum speed as a fraction of base walk. */
  speedFloor: number;
  aboutFace: boolean;
  /** Firing edges: front only, all round, or four faces. */
  fire: 'front' | 'all' | 'four';
  /** Arc of each firing edge, degrees. */
  arc: number;
  /** Emitters per edge (firepower is shared between them). */
  emitters: number;
  /** [front limit, full-flank limit] in degrees; null = cannot be flanked. */
  flank: [number, number] | null;
  rearFireVulnerable: boolean;
  rangedAttackMod: number;
  rangedTakenMod: number;
  meleeTakenMod: number;
  chargeResMod: number;
  ownChargeMod: number;
  flankChargeRes: number;
  orgTakenMod: number;
  /** Ticks to form this posture / to break it down when leaving. */
  formTicks: number;
  breakTicks: number;
  rootedWhileForming?: boolean;
  selectable?: boolean;
  /** Collision levels against allies and enemies (-1 = no blocking). */
  collision: { ally: number; enemy: number };
  note?: string;
}

export interface MeleeWeapon {
  name: string;
  orgRatio: number;
  /** "Been In Melee" duration, ticks. */
  bimTicks: number;
  /** Categories this weapon can charge. */
  canCharge: Category[];
}

/** Linear damage modifier band: from..to metres, modifier slides modFrom -> modTo, applied as x(1 + mod). */
export type RangeBand = [number, number, number, number];

export interface RangedWeapon {
  name: string;
  orgRatio: number;
  enfilade: boolean;
  /** Autofire limits for the Effective and Close settings, metres. */
  effective: number;
  close: number;
  bands: RangeBand[];
}

export interface UnitType {
  id: string;
  name: string;
  category: Category;
  /** Figures drawn at full strength. */
  figures: number;
  canCapture: boolean;
  captureRate: number;
  hp: number;
  org: number;
  stamina: number;
  /** Organization marks as fractions of base max org. */
  orgMarks: { route: number; recover: number; rally: number; shatter: number };
  /** Metres per turn. */
  walk: number;
  run: number;
  /** Allowed formations with their [frontage, depth] footprint in metres. First keys map to R T F G. */
  formations: Record<string, [number, number]>;
  defaultFormation: string;
  melee: {
    attack: number;
    defense: number;
    weapon: MeleeWeapon;
    chargeBonus: number;
    chargeResistance: number;
    runChargeResMod: number;
    chargePenetration: number;
    flankPenBonus: number;
    flankOrgMod: number;
    /** Extension: extra charge resistance against cavalry and elephants (spears). */
    antiCavalry?: number;
  };
  ranged?: { attack: number; weapon: RangedWeapon; ammo: number };
  /** Organization field reach (m) and points. */
  orgRadius: number;
  orgRadiusBonus: number;
  /** Enemies this close get priority fire regardless of autofire range. */
  panicDistance: number;
  /** How visible the unit is (skirmishers are harder to spot). */
  visibility: number;
  /** Extension: elephants trample what they run through while routing. */
  stampede?: boolean;
  causesFear?: boolean;
  height: number;
  icon: string;
  note?: string;
}

export interface ScenarioUnit {
  type: string;
  name?: string;
  pos: [number, number];
  facing: number;
  /** Fraction of full strength (HP and figures). */
  strength?: number;
  general?: boolean;
  reserve?: boolean;
}

export interface ObjectiveDef {
  size: 'big' | 'small';
  pos: [number, number];
}

export interface ScenarioSide {
  name: string;
  color: string;
  ai?: boolean;
  /** x of this side's own map edge: routers flee toward it. */
  rearX: number;
  /** [x0, z0, x1, z1] */
  deployZone: [number, number, number, number];
  objectives: ObjectiveDef[];
  units: ScenarioUnit[];
}

export interface Hill {
  pos: [number, number];
  radius: number;
  height: number;
}

export interface River {
  points: [number, number][];
  width: number;
  depth: number;
  fords?: { pos: [number, number]; radius: number }[];
}

export interface Rules {
  turnLimit: number;
  vpBase: number;
  tieMargin: number;
  captureRadius: number;
  capturePoints: number;
  pressureThreshold: number;
  visionRange: number;
  objectiveVp: { big: number; small: number; hill: number };
  neutralHills: number;
}

export interface Scenario {
  id: string;
  name: string;
  era: string;
  disclaimer: string;
  briefing: string;
  seed: number;
  player: string;
  rules: Rules;
  terrain: { size: [number, number]; hills: Hill[]; river?: River };
  sides: Record<string, ScenarioSide>;
}

export interface XZ {
  x: number;
  z: number;
}

export interface Order {
  type: OrderType;
  /** Remaining waypoints; the unit walks toward path[0]. */
  path?: XZ[];
  /** Final facing at the end of the path (radians), or the rotate target. */
  facing?: number;
  /** Locked enemy target. */
  target?: number;
  /** Friendly unit to follow. */
  follow?: number;
  /** True when this order is the re-sent remainder of last turn's path. */
  continued?: boolean;
}

export interface LogEntry {
  turn: number;
  side: string;
  text: string;
  kind: 'info' | 'warn' | 'bad' | 'good';
}

export interface Volley {
  side: string;
  fromX: number;
  fromZ: number;
  toX: number;
  toZ: number;
  count: number;
}
