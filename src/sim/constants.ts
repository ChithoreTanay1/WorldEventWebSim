// Engine constants. Values from the Lines of Battle wiki (v1.7) where it gives them; the rest are
// marked as our estimates (the wiki leaves them unspecified).

/** A turn is 16 ticks; attacks happen every 2 ticks (8 per turn). (wiki) */
export const TICKS_PER_TURN = 16;
export const ATTACK_EVERY = 2;
export const ATTACKS_PER_TURN = TICKS_PER_TURN / ATTACK_EVERY;
/** Movement/collision sub-steps per tick, for smooth motion and collision (estimate). */
export const SUBSTEPS = 4;
export const STEPS_PER_TURN = TICKS_PER_TURN * SUBSTEPS;

/** Nearby-units organization field clamp, per turn (wiki, Napoleonic). */
export const ORG_FIELD_CLAMP = 56;
/**
 * Each contributor gives radiusBonus x scale at full strength. The wiki's Napoleonic value is 5
 * (line infantry 9 -> 45); we use 3 because our battlefield is far smaller, so units sit inside each
 * other's radius far more of the time (estimate).
 */
export const ORG_FIELD_SCALE = 3;
/** Routing receivers take nearby contributions x5 (wiki). */
export const ROUTING_FIELD_MULT = 5;

/** Low-organization penalties start below 95% and max out at 35% of base max org (wiki). */
export const LOW_ORG_START = 0.95;
export const LOW_ORG_FULL = 0.35;

/** Stamina penalties start at 85% and max out at 40% (wiki). */
export const STAMINA_START = 0.85;
export const STAMINA_FULL = 0.4;

/** Stacking: overlap below 10% is free, penalties scale to a cap at 60% (wiki). */
export const OVERLAP_START = 0.1;
export const OVERLAP_FULL = 0.6;
/** 40%+ hard ally overlap clears a unit's run-up for 5 ticks (wiki). */
export const OVERLAP_RUN_RESET = 0.4;

/** Routing units pass through enemies for their first 12 ticks (wiki). */
export const DISPERSED_TICKS = 12;
/** Rout lock: no recovery for this many ticks after breaking (estimate; wiki: "a short time"). */
export const ROUT_LOCK_TICKS = 16;
/** Panic: a freshly routed unit's radius flips sign and widens for this long (estimate). */
export const PANIC_TICKS = 8;

/** Base org recovery per turn as a share of base max org (estimate). */
export const ORG_RECOVERY_SHARE = 0.06;
/** No standing enemy within this distance counts as Safe (estimate). */
export const SAFETY_DISTANCE = 160;

/** Run-up: ticks of running at sprint before a unit is charge-ready (estimate). */
export const RUN_RAMP_TICKS = 3;
/** Contact margin for melee, metres (estimate). */
export const CONTACT_MARGIN = 1.5;
/** Nearby-ally charge resistance bonus range, metres (wiki: 64 px, ~200 m at map scale; scaled to our map). */
export const CHARGE_SUPPORT_RANGE = 70;

/** Running stamina cost per turn at full run (estimate; wiki gives terrain multipliers only). */
export const RUN_STAMINA_PER_TURN = 160;
export const MELEE_STAMINA_PER_TICK = 15.6;
export const RANGED_STAMINA_PER_TURN = 33;
export const CHARGE_STAMINA = 100;
/** Height of one elevation level in metres (estimate) and climb costs per level (wiki). */
export const ELEVATION_LEVEL = 2.5;
export const CLIMB_WALK = 15;
export const CLIMB_RUN = 25;
