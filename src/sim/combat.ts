// Combat formulas, following the Lines of Battle wiki (v1.7) "Melee Combat", "Ranged Combat",
// "Organization" and "Stamina" pages. Each function documents the source rule; values the wiki does
// not give are marked as estimates.
import {
  ATTACKS_PER_TURN, LOW_ORG_FULL, LOW_ORG_START, ORG_FIELD_CLAMP, OVERLAP_FULL, OVERLAP_START,
  STAMINA_FULL, STAMINA_START, CHARGE_STAMINA,
} from './constants';
import { bearingFrom, toLocal } from './geometry';

/**
 * Flanking. A hit's flank share runs from 0 on the front edge to 1 on the rear edge (0.5 square on a
 * side). Flank hits do more than the wiki's org bonus: extra casualties, a weaker reply from the unit
 * being flanked, and charges into a flank or rear add a shock to organization scaled by the charger's
 * weight, so heavy horse and elephants can break a unit outright.
 */
export const FLANK = {
  /** Melee casualties: x(1 + hp * flank). */
  hp: 1.0,
  /** Org damage: the unit's flankOrgMod is multiplied by this. */
  org: 2.0,
  /** A unit fighting an enemy on its flank strikes back at x(1 - reply * flank). */
  reply: 0.5,
  /** Charge damage into a flank or rear: x(1 + charge * flank). */
  charge: 1.5,
  /** Charge shock: up to this share of the defender's max org, at full flank and weight 1. */
  shock: 0.35,
};
import type { Terrain } from './terrain';
import type { Category, FormationDef, RangedWeapon, UnitType } from './types';
import type { Unit } from './unit';

/**
 * Casualty multipliers on HP damage (our extension; organization loss is unaffected). Tuned so a turn
 * of even melee costs each side roughly a tenth of its men, a good charge takes a fifth, and a
 * routed unit caught in melee is cut down quickly.
 */
export const CASUALTIES = { melee: 4, charge: 2.5, ranged: 2.2, pursuit: 2 };

export interface CombatCtx {
  forms: Record<string, FormationDef>;
  terrain: Terrain;
  /** Current nearby-units organization field for a unit (per turn, clamped +/-56). */
  field(u: Unit): number;
  /** Allies of `u` (standing or recovering) within `range` metres, excluding itself. */
  alliesNear(u: Unit, range: number): number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** 0 above `start`, 1 at or below `full`, linear between. */
const ramp = (v: number, start: number, full: number) => clamp((start - v) / (start - full), 0, 1);

/** Formation that sets a unit's combat and speed stats: the completed one (wiki: stats switch on completion). */
export function statForm(ctx: CombatCtx, u: Unit): FormationDef {
  return ctx.forms[u.routing ? 'dispersed' : u.formation];
}

/** Formation that sets the footprint, flank rules and firing faces: the incoming one, immediately. */
export function shapeForm(ctx: CombatCtx, u: Unit): FormationDef {
  return ctx.forms[u.shapeFormation];
}

export const lowOrgScale = (u: Unit) => ramp(u.orgFrac, LOW_ORG_START, LOW_ORG_FULL);
export const staminaScale = (u: Unit) => ramp(u.staminaFrac, STAMINA_START, STAMINA_FULL);
export const overlapScale = (u: Unit) => clamp((u.overlap - OVERLAP_START) / (OVERLAP_FULL - OVERLAP_START), 0, 1);

/** HP modifier = (attacker HP% / defender HP% - 1) x 0.5, clamped +/-0.2 (wiki). */
export function hpMod(a: Unit, d: Unit): number {
  if (d.hpFrac <= 0) return 0.2;
  return clamp((a.hpFrac / d.hpFrac - 1) * 0.5, -0.2, 0.2);
}

/** Org modifier = (attacker Org% / defender Org% - 1) x 0.5, clamped +/-0.25 (wiki). */
export function orgMod(a: Unit, d: Unit): number {
  const ao = Math.max(0.01, a.org / a.maxOrg), dO = Math.max(0.01, d.org / d.maxOrg);
  return clamp((ao / dO - 1) * 0.5, -0.25, 0.25);
}

/** Shallow-water terrain modifiers (wiki "Terrain modifiers" table), scaled by depth (ford = half). */
export function terrainMods(ctx: CombatCtx, u: Unit): { atk: number; def: number; chargeRes: number; chargeBonus: number } {
  const w = ctx.terrain.waterFactor(u.x, u.z);
  if (w === 0) return { atk: 0, def: 0, chargeRes: 0, chargeBonus: 0 };
  const table: Record<Category, [number, number, number, number]> = {
    infantry: [-0.8, -0.5, -0.5, -0.75],
    missile: [-0.8, -0.5, -0.5, -0.75],
    skirmisher: [-0.7, -1, 0, 0],
    cavalry: [-0.8, -0.5, -0.8, -0.8],
    // Estimate: elephants wade better than horses.
    elephant: [-0.4, -0.25, -0.4, -0.4],
  };
  const [atk, def, chargeRes, chargeBonus] = table[u.type.category];
  return { atk: atk * w, def: def * w, chargeRes: chargeRes * w, chargeBonus: chargeBonus * w };
}

/**
 * Flank share of an attack on `d` from `a`: where the attacker meets the block, measured in the block's
 * own proportions (corners at 45 and 135 degrees), so the end of a wide line counts as its flank, not
 * as part of a front arc that reaches nearly to its sides. 0 for formations that can't be flanked.
 */
export function flankOf(ctx: CombatCtx, d: Unit, a: Unit): number {
  if (!shapeForm(ctx, d).flank) return 0;
  const { f, l } = toLocal(d, a.x, a.z);
  const nf = f / Math.max(1, d.depth / 2), nl = Math.abs(l) / Math.max(1, d.frontage / 2);
  const angle = (Math.atan2(nl, nf) * 180) / Math.PI;
  return clamp((angle - 45) / 90, 0, 1);
}

/** Charge weight: how much a charger's mass adds to the shock of a flank or rear charge. */
function chargeWeight(a: Unit): number {
  const cat = a.type.category;
  const base = cat === 'elephant' ? 1.3 : cat === 'cavalry' ? 1 : 0.5;
  return base * clamp(a.type.melee.chargeBonus / 100, 0.5, 1.5);
}

// ---------------------------------------------------------------- weight, armour and quirks

export type Armour = 'heavy' | 'medium' | 'light';

/** Armour class from the unit's stats: heavy foot, elephants and armoured lancers; light missile troops. */
export function armourOf(t: UnitType): Armour {
  const c = t.category, def = t.melee.defense;
  if (c === 'elephant' || (c === 'infantry' && def >= 50) || (c === 'cavalry' && def >= 30 && t.melee.chargeBonus >= 90)) return 'heavy';
  if (c === 'skirmisher' || c === 'missile' || (c === 'cavalry' && def <= 20) || (c === 'infantry' && def <= 30)) return 'light';
  return 'medium';
}

/** Mass of a unit in a collision: elephants far above horse, horse above foot, armour adds. */
export function weightOf(t: UnitType): number {
  const base = t.category === 'elephant' ? 3 : t.category === 'cavalry' ? 1.6 : t.category === 'infantry' ? 1 : t.category === 'missile' ? 0.75 : 0.6;
  const a = armourOf(t);
  return base * (a === 'heavy' ? 1.25 : a === 'light' ? 0.85 : 1);
}

/** Tunable numbers for impacts and quirks. */
export const IMPACT = {
  /** Charge damage scales with (attacker weight / defender weight) to this power, within the clamp. */
  massPower: 0.6,
  massClamp: [0.4, 2.5] as [number, number],
  /** Backlash on the charger scales with (defender weight / attacker weight) to this power. */
  recoilPower: 0.8,
  recoilClamp: [0.5, 3] as [number, number],
  /** A defender below this organization share takes extra charge damage, up to x(1 + waver * 0.5). */
  waverBelow: 0.5,
  waver: 1.6,
  /** A dash (running into the enemy without a full charge run-up): this share of a charge, plus the run-up. */
  dashBase: 0.3,
  dashRamp: 0.45,
  /** Quirks. */
  arrowsBluntElephants: 0.18, // each recent volley takes this share off an elephant's charge
  elephantChargeFloor: 0.35,
  arrowsMaddenElephants: 1.6, // org damage from missiles on elephants
  braceRecoil: 1.5, // horse or elephants charging braced spears head-on
  horsesFearElephants: 0.5, // horse charging elephants
  horseFearShock: 1.5,
  skirmishersScatter: 0.6, // charges into loose skirmishers
  armourVsMissiles: { heavy: 0.8, medium: 1, light: 1.1 } as Record<Armour, number>,
};

/** The quirks that apply to a unit type, in words (unit cards). */
export function unitQuirks(t: UnitType): string[] {
  const q: string[] = [];
  const a = armourOf(t);
  if (a === 'heavy') q.push('Armoured: -20% damage from missiles');
  if (a === 'light') q.push('Lightly protected: +10% damage from missiles');
  if (t.category === 'elephant') q.push('Massed arrows blunt its charge and madden it (+60% morale loss from missiles)');
  if (t.melee.antiCavalry) q.push('Braced spears: horse or elephants charging its front take heavy recoil');
  if (t.category === 'cavalry') q.push('Horses fear elephants: half force when charging them');
  if (t.category === 'skirmisher') q.push('Scatters before a charge: charges against it lose 40% of their force');
  const w = weightOf(t);
  q.push(`Weight ${w.toFixed(1)}: heavier units hit harder in a charge or a dash, lighter ones bounce off`);
  return q;
}

/**
 * Org damage taken from `hp` damage: (damage / max HP) x 10 x org ratio x extra factors (wiki, melee).
 * Ranged uses the same shape without the x10 (wiki ranged formula); pass `scale` accordingly.
 */
function orgLoss(ctx: CombatCtx, d: Unit, hp: number, ratio: number, scale: number, extra: number, ranged = false): number {
  const f = statForm(ctx, d);
  let mult = 1 + extra;
  if (ranged) mult *= 1 + f.orgTakenMod; // wiki (ranged): Line takes +15% org damage
  mult *= 1 + 0.3 * overlapScale(d); // stacking: up to +30% org damage taken
  // Nearby support: up to -25% with friends around, up to +10% under enemy pressure (wiki).
  const field = ctx.field(d) / ORG_FIELD_CLAMP;
  mult *= 1 + (field >= 0 ? -0.25 * field : -0.1 * field);
  const o = d.order?.type;
  if (o === 'run') mult *= 1.05;
  if (o === 'fallback') mult *= 1.15;
  return Math.max(0, (hp / d.maxHp) * scale * ratio * mult);
}

export interface Hit {
  hp: number;
  org: number;
}

/**
 * One melee swing (every 2 ticks). Base = Atk^2 / (Atk + Def); swing = base / 8;
 * final = swing x max(0.2, product of factors). Flanking changes org loss, not HP (wiki).
 */
export function meleeSwing(ctx: CombatCtx, a: Unit, d: Unit): Hit {
  if (a.routing || a.hp <= 0) return { hp: 0, org: 0 };
  const atk = a.type.melee.attack, def = d.type.melee.defense;
  const base = (atk * atk) / (atk + def);
  const swing = base / ATTACKS_PER_TURN;
  const ta = terrainMods(ctx, d); // both terrain factors are read from the defender's tile (wiki)
  let factor = 1;
  factor *= 1 + statForm(ctx, d).meleeTakenMod;
  factor *= 1 + hpMod(a, d);
  factor *= 1 + orgMod(a, d);
  factor *= 1 - 0.4 * staminaScale(a);
  factor *= 1 + 0.2 * staminaScale(d);
  factor *= 1 + ta.atk;
  factor *= Math.max(0, 1 - ta.def);
  factor *= 1 - 0.5 * overlapScale(a);
  if (a.type.category === 'cavalry' && d.type.category === 'elephant') factor *= 0.6; // estimate: horses shy from elephants
  // Fighting an enemy that is on your own flank or rear: a weaker reply.
  factor *= 1 - FLANK.reply * flankOf(ctx, a, d);
  if (ta.def >= 1) factor = 0;
  const flank = flankOf(ctx, d, a);
  const hp = swing * Math.max(0.2, factor) * (1 + FLANK.hp * flank);
  const org = orgLoss(ctx, d, hp, a.type.melee.weapon.orgRatio, 10, a.type.melee.flankOrgMod * FLANK.org * flank);
  // Casualties: the wiki's HP damage is mostly a vehicle for organization loss, so men barely fall.
  // We keep org exactly as the wiki computes it and scale the men killed. Fleeing men die in droves.
  return { hp: hp * CASUALTIES.melee * (d.routing ? CASUALTIES.pursuit : 1), org };
}

/** All five wiki charge requirements. */
export function canCharge(_ctx: CombatCtx, a: Unit, d: Unit): boolean {
  if (d.routing || !a.standing) return false;
  if (a.order?.type !== 'run' || !a.running || a.runRamp < 1) return false;
  if (a.staminaFrac <= 0.4 || a.bim > 0) return false;
  if (!a.type.melee.weapon.canCharge.includes(d.type.category)) return false;
  // Last velocity must point at the target (estimate: within 60 degrees).
  const vx = a.velX, vz = a.velZ;
  const tx = d.x - a.x, tz = d.z - a.z;
  const vl = Math.hypot(vx, vz), tl = Math.hypot(tx, tz);
  if (vl < 1e-6 || tl < 1e-6) return false;
  return (vx * tx + vz * tz) / (vl * tl) > Math.cos(Math.PI / 3);
}

/** Total charge resistance of `d` against `a` (wiki "Charge Resistance"). */
export function chargeResistance(ctx: CombatCtx, d: Unit, a: Unit): number {
  const t = d.type.melee;
  let res = t.chargeResistance;
  if (d.hasRan > 0) res += t.runChargeResMod;
  res += 0.25 * Math.min(1, ctx.alliesNear(d, 70) / 2); // nearby allies: up to +0.25
  res += terrainMods(ctx, d).chargeRes;
  res += statForm(ctx, d).chargeResMod;
  if (d.rotated180 > 0) res -= 0.5;
  if (d.order?.type === 'fallback') res -= 0.2;
  // Extension: spears brace against horse and elephants coming at their front.
  if (t.antiCavalry && (a.type.category === 'cavalry' || a.type.category === 'elephant') && flankOf(ctx, d, a) < 0.5) res += t.antiCavalry;
  // Org gate: 1 at 95%+ org, down to 0.4 at 35%; then up to -0.5 for exhaustion (wiki).
  const gate = 1 - 0.6 * lowOrgScale(d);
  return clamp(res * gate - 0.5 * staminaScale(d), -1, 1);
}

export interface ChargeResult {
  defender: Hit;
  attacker: Hit;
  staminaA: number;
  staminaD: number;
  flank: number;
}

/**
 * Charge impact on first contact (wiki "Charge Damage" and "Backlash"), extended with weight: a heavy
 * charger hits a lighter unit harder and a wavering unit (low organization) harder still, while a light
 * unit crashing into a heavier one takes the damage itself. `scale` < 1 is a dash: running into the
 * enemy without a full charge run-up. Quirks: massed arrows blunt elephants, braced spears, horses
 * shying from elephants, skirmishers scattering.
 */
export function chargeImpact(ctx: CombatCtx, a: Unit, d: Unit, scale = 1): ChargeResult {
  const ta = terrainMods(ctx, d);
  const flank = flankOf(ctx, d, a);
  const sa = statForm(ctx, a);
  // Base charge = Charge Bonus x condition factors, floored at 0 (no 20% floor for charges).
  let base = a.type.melee.chargeBonus;
  base *= 1 + hpMod(a, d);
  base *= 1 + orgMod(a, d);
  base *= 1 - 0.4 * staminaScale(a);
  base *= 1 + ta.atk;
  base *= Math.max(0, 1 - ta.def);
  base *= 1 - 0.5 * overlapScale(a);
  base *= 1 + ta.chargeBonus;
  base *= 1 + sa.ownChargeMod;
  // Weight and wavering defenders.
  const ratio = weightOf(a.type) / weightOf(d.type);
  base *= clamp(ratio, IMPACT.massClamp[0], IMPACT.massClamp[1]) ** IMPACT.massPower;
  base *= 1 + Math.max(0, IMPACT.waverBelow - d.orgFrac) * IMPACT.waver;
  // Quirks.
  if (a.type.category === 'elephant') base *= Math.max(IMPACT.elephantChargeFloor, 1 - IMPACT.arrowsBluntElephants * a.volleys);
  if (a.type.category === 'cavalry' && d.type.category === 'elephant') base *= IMPACT.horsesFearElephants;
  if (d.type.category === 'skirmisher' || shapeForm(ctx, d).id === 'loose') base *= IMPACT.skirmishersScatter;
  base = Math.max(0, base * scale);
  // Penetration effectiveness from attacker org: 1 at 95%+, 0 at 35%-, plus up to +0.1 support.
  const eff = clamp(1 - lowOrgScale(a) + 0.1 * clamp(ctx.field(a) / ORG_FIELD_CLAMP, 0, 1), 0, 1.1);
  const pen = (a.type.melee.chargePenetration + flank * a.type.melee.flankPenBonus) * eff;
  const res = chargeResistance(ctx, d, a);
  const flankRes = shapeForm(ctx, d).flank ? statForm(ctx, d).flankChargeRes * flank : 0;
  const dmg = base * clamp(1 - res - flankRes + pen, 0, 1) * (1 + FLANK.charge * flank);
  // Shock: a charge into a flank or rear tears at cohesion, more so the heavier the charger.
  const shock = flank * FLANK.shock * chargeWeight(a) * d.maxOrg * eff;
  const dOrg = orgLoss(ctx, d, dmg, a.type.melee.weapon.orgRatio, 10, a.type.melee.flankOrgMod * FLANK.org * flank) + shock;

  // Backlash: the charger takes damage from a well-set defender.
  const td = d.type.melee;
  const lash = td.chargeBonus * 0.3 + td.defense * 0.3;
  const tAtk = terrainMods(ctx, a);
  // Condition = (1 - HP mod)(1 - Org mod)(1 + defender stamina mod)(1 + terrain atk)(1 - terrain def)...
  let cond = (1 - hpMod(a, d)) * (1 - orgMod(a, d)) * (1 - 0.4 * staminaScale(d)) * (1 + tAtk.atk) * Math.max(0, 1 - tAtk.def);
  cond *= 1 - 0.5 * overlapScale(d);
  cond *= 1 + ta.chargeBonus;
  cond *= 1 + statForm(ctx, d).ownChargeMod;
  cond = Math.max(0, cond);
  const landed = clamp(1 - (base > 0 ? dmg / base : 0), 0, 1);
  const cat = d.type.category === 'skirmisher' ? 0 : d.type.category === 'cavalry' ? 0.75 : d.hasRan > 0 ? 0.75 : 1.5;
  let backlash = Math.max(0, (lash * cond * landed * (1 - flank) * cat) / Math.max(0.75, res));
  // A lighter unit crashing into a heavier one recoils hard; braced spears punish horse and elephants.
  backlash *= clamp(1 / ratio, IMPACT.recoilClamp[0], IMPACT.recoilClamp[1]) ** IMPACT.recoilPower;
  const mounted = a.type.category === 'cavalry' || a.type.category === 'elephant';
  if (mounted && td.antiCavalry && flank < 0.5) backlash *= IMPACT.braceRecoil;
  backlash *= Math.max(scale, 0.5);
  const fear = a.type.category === 'cavalry' && d.type.category === 'elephant' ? IMPACT.horseFearShock : 1;
  const aOrg = orgLoss(ctx, a, backlash, td.weapon.orgRatio, 10, 0) * fear;

  return {
    defender: { hp: dmg * CASUALTIES.charge, org: dOrg },
    attacker: { hp: backlash * CASUALTIES.charge, org: aOrg },
    staminaA: 0.75 * CHARGE_STAMINA * (1 - flank) + 0.25 * CHARGE_STAMINA,
    staminaD: 0.75 * CHARGE_STAMINA * flank + 0.25 * CHARGE_STAMINA,
    flank,
  };
}

/** Linear range modifier within the weapon's bands; null beyond maximum range (wiki "Range and Damage Falloff"). */
export function rangeModifier(w: RangedWeapon, dist: number): number | null {
  for (const [from, to, m0, m1] of w.bands) {
    if (dist >= from && dist <= to) return m0 + ((m1 - m0) * (dist - from)) / (to - from || 1);
  }
  return null;
}

export function maxRange(w: RangedWeapon): number {
  return w.bands[w.bands.length - 1][1];
}

/**
 * One emitter's share of a volley (wiki): damage = Ranged Attack x combined factor x share x (1 + range mod),
 * spread over the turn's attacks. Org = damage / max HP x org ratio x (1 + bonus).
 */
export function rangedShot(ctx: CombatCtx, s: Unit, t: Unit, dist: number, share: number): Hit {
  const r = s.type.ranged!;
  const mod = rangeModifier(r.weapon, dist);
  if (mod === null) return { hp: 0, org: 0 };
  let factor = 1;
  factor *= 1 + statForm(ctx, s).rangedAttackMod;
  factor *= 0.5 + 0.5 * s.hpFrac; // wounds reduce fire to about half
  factor *= 1 - 0.7 * lowOrgScale(s); // disorder: down to -70%
  factor *= 1 - 0.15 * staminaScale(s);
  const o = s.order?.type;
  if (o === 'fireAdvance' && s.moving) factor *= 0.8;
  if (o === 'fallback') factor *= 0.65;
  factor *= 1 - 0.5 * overlapScale(s);
  factor *= 1 + terrainMods(ctx, s).atk * 0.5; // estimate: shooting from water is clumsy
  factor *= 1 + statForm(ctx, t).rangedTakenMod;
  if (t.routing) factor *= 0.5; // diminishing returns against broken targets
  factor = Math.max(0.2, factor);
  const hp = (r.attack * factor * share * (1 + mod)) / ATTACKS_PER_TURN;
  // Rear fire on line or column: +150% org (wiki), with an enfilade-capable weapon.
  let bonus = 0;
  if (r.weapon.enfilade && shapeForm(ctx, t).rearFireVulnerable && bearingFrom(t, s.x, s.z) > 135) bonus += 1.5;
  // Armour against arrows; elephants are maddened by them.
  const armour = IMPACT.armourVsMissiles[armourOf(t.type)];
  const org = orgLoss(ctx, t, hp * armour, r.weapon.orgRatio, 1, bonus, true) * (t.type.category === 'elephant' ? IMPACT.arrowsMaddenElephants : 1);
  return { hp: hp * armour * CASUALTIES.ranged, org };
}
