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
  /** Pairs of factions at peace: they never fight or take each other's towns. All others are at war. */
  alliances?: [string, string][];
  /** Money: realms tax their towns and pay to raise and keep troops (absent = no money at all). */
  economy?: Economy;
  /** End-screen lines. */
  victory?: string;
  defeat?: string;
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

export interface Economy {
  /** Realms that raise troops for free (no treasury). */
  exempt: string[];
  /** Gold per turn from each town held, and from a capital held by its own realm. */
  income: { town: number; capital: number };
  startGold: number;
  /** Fraction of a unit's price paid every turn to keep it. */
  upkeep: number;
  /** Price to raise one unit, by unit type. */
  costs: Record<string, number>;
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
  /** Factions with no towns and no armies left (announced once). */
  fallen?: string[];
  /** Treasury of each realm that pays for its troops. */
  gold?: Record<string, number>;
  /** Towns under siege: the besieging army and the turn the siege began. */
  sieges?: Record<string, { army: number; since: number }>;
  /** Each AI realm's current war focus and the turn it will reconsider. */
  wars?: Record<string, { target: string; until: number }>;
}

export interface Recruit {
  town: string;
  faction: string;
  type: string;
}
