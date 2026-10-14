// WEGO AI: plans one order per unit at the start of each turn, using only enemies its side can see
// (fog of war applies to it too). Army level picks a plan; unit level applies per-type rules.
import type { Battle } from './battle';
import { bearingFrom } from './geometry';
import type { Order } from './types';
import type { Unit } from './unit';

export type Plan = 'harass' | 'flank' | 'advance' | 'withdraw';

const PLAN_TEXT: Record<Plan, string> = {
  harass: 'Enemy skirmishers and horse archers ride forward to harass your line.',
  flank: 'Enemy heavy horse swings wide around your southern flank!',
  advance: 'The enemy senses weakness and commits to a general attack!',
  withdraw: 'The enemy host begins to pull back.',
};

export class ArmyAI {
  current: Plan = 'harass';

  constructor(readonly side: string) {}

  private visibleEnemies(b: Battle): Unit[] {
    return b.units.filter((e) => e.side !== this.side && e.alive && b.seen(this.side, e) > 0);
  }

  private forward(b: Battle): number {
    return b.sides.get(this.side)!.rearX > b.terrain.width / 2 ? -1 : 1;
  }

  private rear(b: Battle): number {
    return b.sides.get(this.side)!.rearX;
  }

  plan(b: Battle) {
    const mine = b.units.filter((u) => u.side === this.side && u.alive);
    for (const u of mine) if (!u.ai.post) u.ai.post = { x: u.x, z: u.z };
    const enemies = this.visibleEnemies(b);
    const plan = this.choosePlan(b, enemies);
    if (plan !== this.current) b.log.push({ turn: b.battleTurn(), side: this.side, text: PLAN_TEXT[plan], kind: 'warn' });
    this.current = plan;
    for (const u of mine) {
      if (!u.standing) continue;
      u.autofire = 'max';
      b.setOrder(u.id, null);
      if (plan === 'withdraw') {
        this.goTo(b, u, u.x + Math.sign(this.rear(b) - u.x) * 200, u.z, 'run');
        continue;
      }
      if (this.rest(b, u)) continue;
      if (this.defend(b, u, enemies)) continue;
      if (u.type.category === 'cavalry' && u.type.ranged) this.horseArcher(b, u, enemies);
      else if (u.type.ranged) this.skirmisher(b, u, enemies);
      else if (u.general) this.general(b, u, enemies);
      else this.shockCavalry(b, u, enemies);
    }
  }

  // ---------------------------------------------------------------- army level

  /** Enemy units well ahead of their own line and far from friends: the bait the feigned retreat is for. */
  isolated(b: Battle, e: Unit): boolean {
    if (!e.alive || e.routing) return false;
    const friends = b.units.filter((f) => f.side === e.side && f !== e && f.alive && !f.routing);
    if (friends.length === 0) return false;
    const nearest = Math.min(...friends.map((f) => Math.hypot(f.x - e.x, f.z - e.z)));
    const cx = friends.reduce((s, f) => s + f.x, 0) / friends.length;
    return nearest > 90 && (e.x - cx) * this.forward(b) < -40;
  }

  private choosePlan(b: Battle, enemies: Unit[]): Plan {
    const myLost = b.powerLost(this.side);
    const theirLost = b.powerLost([...b.sides.keys()].find((s) => s !== this.side)!);
    const ha = b.units.filter((u) => u.side === this.side && u.alive && u.type.ranged && u.type.category === 'cavalry');
    const ammo = ha.reduce((s, u) => s + u.ammo, 0) / Math.max(1, ha.reduce((s, u) => s + (u.type.ranged?.ammo ?? 0), 0));
    const disorder = enemies.filter((e) => !e.standing || this.isolated(b, e)).length / Math.max(1, enemies.length);
    if (myLost > 0.55 && myLost > theirLost + 0.2) return 'withdraw';
    if (disorder > 0.35 || theirLost > myLost + 0.25) return 'advance';
    if (ammo > 0.3 && b.battleTurn() < 9) return 'harass';
    return theirLost > myLost ? 'advance' : 'flank';
  }

  // ---------------------------------------------------------------- unit level

  private goTo(b: Battle, u: Unit, x: number, z: number, type: Order['type'], facing?: number) {
    const p = this.safePoint(b, x, z);
    b.setOrder(u.id, { type, path: [p], facing });
  }

  private safePoint(b: Battle, x: number, z: number): { x: number; z: number } {
    x = Math.max(20, Math.min(b.terrain.width - 20, x));
    z = Math.max(20, Math.min(b.terrain.depth - 20, z));
    for (let i = 0; i < 12 && b.terrain.inWater(x, z); i++) z += z > b.terrain.depth / 2 ? -12 : 12;
    return { x, z };
  }

  /**
   * Our objectives can only be taken by enemy infantry standing in the circle, and we have no infantry
   * to contest them: the only defence is to drive the capturers off. They become everyone's priority.
   */
  private defend(b: Battle, u: Unit, enemies: Unit[]): boolean {
    const R = b.rules.captureRadius;
    const ours = b.objectives.filter((o) => o.owner === this.side);
    const capturers = enemies.filter((e) => e.standing && e.type.canCapture && ours.some((o) => Math.hypot(e.x - o.x, e.z - o.z) <= R + 40));
    if (!capturers.length) return false;
    const t = capturers.sort((a, c) => Math.hypot(a.x - u.x, a.z - u.z) - Math.hypot(c.x - u.x, c.z - u.z))[0];
    const d = Math.hypot(t.x - u.x, t.z - u.z);
    if (u.type.ranged && u.ammo > 0) {
      b.setOrder(u.id, { type: 'fireAdvance', target: t.id });
      return true;
    }
    if (u.type.ranged) return false;
    // Horse only goes in where the capturer is exposed (flank or rear, or already shaken).
    if (this.score(b, u, t) < -0.5) return false;
    if (d < u.type.run * 0.9 && u.staminaFrac > 0.45) b.setOrder(u.id, { type: 'run', target: t.id });
    else b.setOrder(u.id, { type: 'walk', target: t.id });
    return true;
  }

  /** Shaken units step back to recover; a reserve moves up to cover the gap. */
  private rest(b: Battle, u: Unit): boolean {
    if (u.general || u.contacts.length > 0) return false;
    if (u.orgFrac > 0.45) return false;
    this.goTo(b, u, u.x + Math.sign(this.rear(b) - u.x) * 160, u.z, 'walk');
    const reserve = b.units.find((r) => r.side === this.side && r.reserve && r.standing && !r.order && r.orgFrac > 0.8);
    if (reserve) {
      this.goTo(b, reserve, u.x, u.z, 'walk', u.facing);
      b.log.push({ turn: b.battleTurn(), side: this.side, text: `${reserve.name} move up to cover for ${u.name}.`, kind: 'info' });
    }
    return true;
  }

  /**
   * Could `e` plausibly catch `u` this turn? Horse must turn before it can charge, so only horse that is
   * both close and roughly facing us counts; foot only threatens at walking distance.
   */
  private threatens(e: Unit, u: Unit): boolean {
    if (!e.standing || e.type.ranged) return false;
    const d = Math.hypot(e.x - u.x, e.z - u.z);
    if (e.type.category === 'cavalry' || e.type.category === 'elephant') {
      const facing = bearingFrom(e, u.x, u.z) < 75;
      return d < e.type.run * (facing ? 0.95 : 0.65) + 20;
    }
    return d < e.type.walk * 0.9 + 20;
  }

  private escape(b: Battle, u: Unit, from: Unit[]): { x: number; z: number } {
    const base = Math.atan2(u.z - from[0].z, u.x - from[0].x);
    const melee = b.units.filter((o) => o.side !== this.side && o.standing && !o.type.ranged && b.seen(this.side, o) > 0);
    let best = { x: u.x, z: u.z };
    let bestScore = -Infinity;
    // Sample all round, so horse archers can slip past the enemy's flank instead of backing into a corner.
    for (let off = -180; off < 180; off += 30) {
      const a = base + (off * Math.PI) / 180;
      const x = u.x + Math.cos(a) * u.type.run * 0.8, z = u.z + Math.sin(a) * u.type.run * 0.8;
      const edge = Math.min(x, z, b.terrain.width - x, b.terrain.depth - z);
      // Don't ride through the threat to get somewhere: penalise paths passing close to any of them.
      const pass = Math.min(...from.map((o) => {
        const t = Math.max(0, Math.min(1, ((o.x - u.x) * (x - u.x) + (o.z - u.z) * (z - u.z)) / ((x - u.x) ** 2 + (z - u.z) ** 2)));
        return Math.hypot(u.x + (x - u.x) * t - o.x, u.z + (z - u.z) * t - o.z);
      }));
      let score = Math.min(...melee.map((o) => Math.hypot(o.x - x, o.z - z))) - Math.abs(off) * 0.1;
      if (pass < 60) score -= 400;
      if (edge < 25) score -= 1000;
      else if (edge < 100) score -= (100 - edge) * 2;
      if (b.terrain.inWater(x, z)) score -= 500;
      if (score > bestScore) (bestScore = score), (best = { x, z });
    }
    return this.safePoint(b, best.x, best.z);
  }

  private horseArcher(b: Battle, u: Unit, enemies: Unit[]) {
    const threats = enemies.filter((e) => this.threatens(e, u)).sort((a, c) => Math.hypot(a.x - u.x, a.z - u.z) - Math.hypot(c.x - u.x, c.z - u.z));
    const fast = threats.filter((t) => t.type.category === 'cavalry' || t.type.category === 'elephant');
    const soft = this.current === 'advance' ? this.bestTarget(b, u, enemies) : null;
    if (u.ammo === 0) {
      if (soft && this.score(b, u, soft) > 0.5 && Math.hypot(soft.x - u.x, soft.z - u.z) < u.type.run * 0.9) b.setOrder(u.id, { type: 'run', target: soft.id });
      else this.goTo(b, u, u.ai.post!.x + Math.sign(this.rear(b) - u.x) * 120, u.ai.post!.z, 'walk');
      return;
    }
    if (fast.length) {
      // Feigned retreat: ride away from horse that could catch us; turn and shoot next turn.
      const p = this.escape(b, u, fast);
      b.setOrder(u.id, { type: 'run', path: [p] });
      if (fast[0].type.category === 'cavalry' && b.rng.next() < 0.4) {
        b.log.push({ turn: b.battleTurn(), side: this.side, text: `${u.name} wheel away from ${fast[0].name}. A feigned retreat?`, kind: 'warn' });
      }
      return;
    }
    if (threats.length && Math.hypot(threats[0].x - u.x, threats[0].z - u.z) < 100) {
      b.setOrder(u.id, { type: 'fallback', target: threats[0].id });
      return;
    }
    // Losing the exchange of arrows while merely harassing? Break off and wait out of range.
    const enemy = [...b.sides.keys()].find((k) => k !== this.side)!;
    if (this.current === 'harass' && b.powerLost(this.side) > b.powerLost(enemy) + 0.02) {
      this.goTo(b, u, u.ai.post!.x, u.ai.post!.z, 'walk');
      return;
    }
    // Each horse archer works its own lane (its starting z), so they don't bunch on one target.
    const lane = u.ai.post!.z;
    // Foot archers outrange horse bows: prefer targets they don't cover.
    const archers = enemies.filter((x) => x.type.category === 'missile' && x.ammo > 0 && x.standing);
    const covered = (t: Unit) => archers.some((a) => a !== t && Math.hypot(a.x - t.x, a.z - t.z) < (a.type.ranged ? 150 : 0)) || t.type.category === 'missile';
    const cost = (t: Unit) => Math.hypot(t.x - u.x, t.z - lane);
    const e = enemies.filter((x) => !x.routing && !covered(x)).sort((a, c) => cost(a) - cost(c))[0];
    if (!e) {
      // Everything is under the enemy's bows: wait out of their reach for an opening.
      const nearestArcher = archers.sort((a, c) => Math.hypot(a.x - u.x, a.z - u.z) - Math.hypot(c.x - u.x, c.z - u.z))[0];
      if (nearestArcher && Math.hypot(nearestArcher.x - u.x, nearestArcher.z - u.z) < 200) {
        const a = Math.atan2(u.z - nearestArcher.z, u.x - nearestArcher.x);
        this.goTo(b, u, nearestArcher.x + Math.cos(a) * 230, nearestArcher.z + Math.sin(a) * 230, 'walk');
      } else if (!enemies.length) this.goTo(b, u, u.x + this.forward(b) * 120, lane, 'walk');
      return;
    }
    // Stand off inside good bow range; fall back next turn if foot comes on.
    const a = Math.atan2(lane - e.z, u.x - e.x);
    const p = this.safePoint(b, e.x + Math.cos(a) * 88, e.z + Math.sin(a) * 88);
    b.setOrder(u.id, { type: 'fireAdvance', path: [p], facing: a + Math.PI });
  }

  private skirmisher(b: Battle, u: Unit, enemies: Unit[]) {
    const threat = enemies.find((e) => this.threatens(e, u));
    // Javelins are outranged by bows: stay out of reach of archers that still have arrows.
    const bows = enemies.filter((e) => e.type.ranged && e.ammo > 0 && e.standing && e.type.ranged.weapon.bands[e.type.ranged.weapon.bands.length - 1][1] > 100);
    const bow = bows.sort((a, c) => Math.hypot(a.x - u.x, a.z - u.z) - Math.hypot(c.x - u.x, c.z - u.z))[0];
    if (bow && Math.hypot(bow.x - u.x, bow.z - u.z) < 240) {
      const a = Math.atan2(u.z - bow.z, u.x - bow.x);
      this.goTo(b, u, bow.x + Math.cos(a) * 280, bow.z + Math.sin(a) * 280, 'walk');
      return;
    }
    if (u.ammo === 0 || u.orgFrac < 0.7 || (threat && Math.hypot(threat.x - u.x, threat.z - u.z) < 140)) {
      this.goTo(b, u, u.x + Math.sign(this.rear(b) - u.x) * 150, u.z, 'run');
      return;
    }
    const e = enemies.filter((x) => !x.routing).sort((a, c) => Math.hypot(a.x - u.x, a.z - u.z) - Math.hypot(c.x - u.x, c.z - u.z))[0];
    if (e && (u.x - u.ai.post!.x) * this.forward(b) < 200) b.setOrder(u.id, { type: 'fireAdvance', target: e.id });
  }

  private general(b: Battle, u: Unit, enemies: Unit[]) {
    if (this.current === 'advance') {
      const t = this.bestTarget(b, u, enemies);
      if (t && !t.standing && Math.hypot(t.x - u.x, t.z - u.z) < u.type.run * 0.9) {
        b.setOrder(u.id, { type: 'run', target: t.id });
        return;
      }
    }
    const friends = b.units.filter((f) => f.side === this.side && f.alive && f !== u && !f.routing);
    if (!friends.length) return;
    const cx = friends.reduce((s, f) => s + f.x, 0) / friends.length;
    const cz = friends.reduce((s, f) => s + f.z, 0) / friends.length;
    const p = this.safePoint(b, cx - this.forward(b) * 100, cz);
    if (Math.hypot(p.x - u.x, p.z - u.z) > 30) b.setOrder(u.id, { type: 'walk', path: [p] });
  }

  private shockCavalry(b: Battle, u: Unit, enemies: Unit[]) {
    // Cycle charge: break off a losing melee, re-form, come again.
    if (u.contacts.length > 0) {
      if (u.orgFrac < 0.5) this.goTo(b, u, u.x + Math.sign(this.rear(b) - u.x) * 180, u.z, 'run');
      return;
    }
    const reach = u.type.run * 0.9;
    const near = (e: Unit) => Math.hypot(e.x - u.x, e.z - u.z);
    // The trap: punish anything that chased our horse archers away from its army.
    const bait = enemies.filter((e) => this.isolated(b, e) && near(e) < reach * 1.6).sort((a, c) => near(a) - near(c))[0];
    if (bait) {
      if (near(bait) < reach && u.staminaFrac > 0.5) b.setOrder(u.id, { type: 'run', target: bait.id });
      else b.setOrder(u.id, { type: 'walk', target: bait.id });
      return;
    }
    if (this.current === 'advance' || this.current === 'flank') {
      const t = this.bestTarget(b, u, enemies);
      if (t && this.score(b, u, t) > -1) {
        if (this.current === 'flank' && u.ai.role !== 'turned-in' && bearingFrom(t, u.x, u.z) < 70) {
          // Swing wide around the open (southern) flank before turning in.
          const zMin = Math.min(...enemies.map((e) => e.z));
          const p = this.safePoint(b, t.x + this.forward(b) * 20, zMin - 90);
          if (Math.hypot(p.x - u.x, p.z - u.z) > 40) {
            b.setOrder(u.id, { type: 'walk', path: [p] });
            return;
          }
          u.ai.role = 'turned-in';
        }
        if (near(t) < reach && u.staminaFrac > 0.5) b.setOrder(u.id, { type: 'run', target: t.id });
        else b.setOrder(u.id, { type: 'walk', target: t.id });
        return;
      }
    }
    const post = u.ai.post!;
    if (Math.hypot(post.x - u.x, post.z - u.z) > 40) b.setOrder(u.id, { type: 'walk', path: [post] });
  }

  private bestTarget(b: Battle, u: Unit, enemies: Unit[]): Unit | null {
    let best: Unit | null = null;
    let bestScore = -Infinity;
    for (const e of enemies) {
      const s = this.score(b, u, e);
      if (s > bestScore) (bestScore = s), (best = e);
    }
    return best;
  }

  /** Charge targets: exposed flanks, archers, shaken and isolated units first; avoid spears and elephants head-on. */
  score(b: Battle, u: Unit, e: Unit): number {
    const d = Math.hypot(e.x - u.x, e.z - u.z);
    let s = -d / 300;
    if (e.routing) s += this.current === 'advance' ? 0.5 : -3;
    if (e.status === 'recovering' || e.orgFrac < 0.5) s += 1.5;
    if (this.isolated(b, e)) s += 2.5;
    if (e.type.category === 'missile') s += 1.5;
    if (e.type.category === 'elephant') s -= 2.5;
    const angle = bearingFrom(e, u.x, u.z);
    if (angle > 70) s += 2;
    else if (e.type.melee.antiCavalry) s -= 2;
    if (e.contacts.length > 0 && angle > 70) s += 1;
    // Formed melee troops (and elephants) close by will punish a charge: avoid supported targets.
    const support = b.units.filter((f) => f.side === e.side && f !== e && f.standing && !f.type.ranged && f.type.category !== 'cavalry' && Math.hypot(f.x - e.x, f.z - e.z) < 90).length;
    s -= 1.2 * support;
    return s;
  }
}
