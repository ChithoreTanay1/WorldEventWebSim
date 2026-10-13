// Data model for the battle simulation. World units are metres; the map lies in the x/z plane.
// Angles in data files are degrees, 0 = facing +x (east), 90 = facing +z. Internally radians.

export type UnitClass = 'infantry' | 'missile' | 'cavalry' | 'elephant';
export type Stance = 'hold' | 'advance' | 'charge' | 'withdraw';
export type MoraleState = 'steady' | 'wavering' | 'retreating' | 'routing' | 'rallying' | 'gone';

export interface UnitType {
  id: string;
  name: string;
  class: UnitClass;
  /** Default strength. For elephants this counts animals. */
  men: number;
  /** Hit points per man (elephants and horses soak more). */
  hp: number;
  attack: number;
  charge: number;
  armor: number;
  /** Walking and running speed, m/s. */
  speed: number;
  runSpeed: number;
  /** Formation turn rate, degrees per second. */
  turnRate: number;
  /** Morale quality 1-10: how well the unit shrugs off shocks. */
  morale: number;
  range?: number;
  ammo?: number;
  /** Chance per missile to hit an unarmoured man at close range. */
  accuracy?: number;
  /** Seconds between volleys. */
  reload?: number;
  /** Total firing arc in degrees, centred on facing (120 = 60 either side; 360 = all round). */
  fireArc?: number;
  fireOnMove?: boolean;
  /** Default frontage in files, and the allowed rank range when reforming. */
  files: number;
  minRanks: number;
  maxRanks: number;
  /** Metres per man: [lateral, depth]. */
  spacing: [number, number];
  shield?: boolean;
  /** Multiplier against cavalry, and charge reduction when charged frontally by cavalry. */
  antiCavalry?: number;
  causesFear?: boolean;
  /** Loose formation: harder to hit with missiles. */
  loose?: boolean;
  /** Render height in metres. */
  height: number;
  icon: string;
  note?: string;
}

export interface ScenarioUnit {
  type: string;
  name?: string;
  pos: [number, number];
  facing: number;
  men?: number;
  general?: boolean;
  reserve?: boolean;
}

export interface ScenarioSide {
  name: string;
  color: string;
  ai?: boolean;
  /** x coordinate of this side's own map edge: routers flee toward it. */
  rearX: number;
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

export interface Scenario {
  id: string;
  name: string;
  era: string;
  disclaimer: string;
  briefing: string;
  seed: number;
  player: string;
  terrain: { size: [number, number]; hills: Hill[]; river?: River };
  sides: Record<string, ScenarioSide>;
}

export type Order =
  | { kind: 'move'; x: number; z: number; facing: number; files: number; speedScale: number; run: boolean }
  | { kind: 'attack'; target: number; run: boolean };

export interface Slot {
  x: number;
  z: number;
  facing: number;
  files: number;
}

export interface LogEntry {
  t: number;
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
