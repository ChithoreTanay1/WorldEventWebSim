// Campaign data (loaded from data/campaign/*.json) and the mutable campaign state that is saved.
// Map data is in longitude/latitude; the map projects it onto the x/z plane (north is -z).

export type LonLat = [number, number];

export interface CampaignFaction {
  name: string;
  color: string;
  /** Settlement whose loss ends the campaign for this faction. */
  capital: string;
  ai?: boolean;
  /** Movement per campaign turn, map units (an army of only cavalry uses `fastMove`). */
  move: number;
  fastMove: number;
  /** Unit types this faction can raise in its towns. */
  recruits: string[];
}

export interface SettlementDef {
  id: string;
  name: string;
  pos: LonLat;
  owner: string;
  /** A short line of flavour for the tooltip. */
  note?: string;
}

export interface ArmyUnitDef {
  type: string;
  name?: string;
  /** Fraction of full strength, 0..1. */
  strength?: number;
  general?: boolean;
}

export interface ArmyDef {
  name: string;
  faction: string;
  at: string;
  units: ArmyUnitDef[];
}

export interface Reinforcement {
  faction: string;
  /** Every N campaign turns, if `at` is still held and the faction has fewer than `maxArmies`. */
  every: number;
  at: string;
  maxArmies: number;
  name: string;
  units: ArmyUnitDef[];
}

export interface MapRiver {
  name: string;
  points: LonLat[];
}

export interface MapHill {
  pos: LonLat;
  /** Degrees. */
  radius: number;
  height: number;
}

export interface CampaignData {
  id: string;
  name: string;
  era: string;
  disclaimer: string;
  briefing: string;
  startYear: number;
  player: string;
  /** [lonMin, latMin, lonMax, latMax] */
  bounds: [number, number, number, number];
  /** Map units per degree. */
  scale: number;
  factions: Record<string, CampaignFaction>;
  settlements: SettlementDef[];
  roads: [string, string][];
  rivers: MapRiver[];
  /** The Himalayan crest, west to east: everything north of it is mountain. */
  ridge: LonLat[];
  hills: MapHill[];
  deserts: MapHill[];
  seas: LonLat[][];
  armies: ArmyDef[];
  reinforcements: Reinforcement[];
}

// ---------------------------------------------------------------- saved state

export interface ArmyUnit {
  type: string;
  name: string;
  strength: number;
  general?: boolean;
}

export interface Army {
  id: number;
  name: string;
  faction: string;
  units: ArmyUnit[];
  /** Last settlement reached, the one it is walking toward (null = parked) and metres along that road. */
  from: string;
  to: string | null;
  progress: number;
  /** Settlements still to visit after `to`. */
  route: string[];
  /** Has orders to march (an army can halt mid-road). */
  marching: boolean;
  /** Movement left this turn (shown while planning). */
  moveLeft: number;
}

export interface CampaignLogEntry {
  turn: number;
  text: string;
  kind: 'info' | 'good' | 'bad' | 'warn';
}

export interface CampaignState {
  version: 1;
  dataId: string;
  turn: number;
  owners: Record<string, string>;
  armies: Army[];
  nextArmyId: number;
  log: CampaignLogEntry[];
  /** Winning faction once the campaign is decided. */
  winner: string | null;
  /** Units being raised this turn: one per town, ready at the start of next turn. */
  recruits: Recruit[];
}

export interface Recruit {
  town: string;
  faction: string;
  type: string;
}
