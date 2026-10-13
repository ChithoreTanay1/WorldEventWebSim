// Two-layer AI. Army level picks a plan every few seconds; unit level runs a small rule set per
// unit type. The AI issues orders through the same Battle methods the player uses, and its units
// obey the same morale and retreat rules.
import type { Battle } from './battle';
import { sideOf } from './geometry';
import type { Unit } from './unit';

export type Plan = 'harass' | 'flank' | 'advance' | 'withdraw';

const PLAN_TEXT: Record<Plan, string> = {
  harass: 'The nomad horse archers ride forward to harass your line.',
  flank: 'Enemy heavy horse swings wide around your southern flank!',
  advance: 'The nomads sense weakness and commit to a general attack!',
  withdraw: 'The nomad host begins to pull back.',
};

export class ArmyAI {
  plan: Plan = 'harass';
  private nextPlanAt = 0;
  private lastFeintLog = -999;
  private startRatio: number | undefined;
  private planSince = 0;

  constructor(readonly side: string) {}

  think(b: Battle) {
    const mine = b.units.filter((u) => u.side === this.side && u.alive);
    for (const u of mine) if (!u.ai.post) u.ai.post = { x: u.x, z: u.z };
    if (b.time >= this.nextPlanAt) {
      const plan = this.choosePlan(b);
      if (plan !== this.plan) {
        b.log.push({ t: b.time, side: this.side, text: PLAN_TEXT[plan], kind: 'warn' });
        this.planSince = b.time;
      }
      this.plan = plan;
      this.nextPlanAt = b.time + 3;
    }
    // A sustained withdrawal ends the battle: nomad armies simply rode away from lost fights.
    if (this.plan === 'withdraw' && b.time - this.planSince > 30) {
      b.concede(this.side, `${b.sides.get(this.side)!.name} rides away from the field.`);
      return;
    }
    for (const u of mine) {
      if (!u.controllable) continue;
      if (this.plan === 'withdraw') {
        b.setStance(u.id, 'withdraw');
        continue;
      }
      if (this.pullBack(b, u)) continue;
      if (u.type.class === 'cavalry' && u.type.range) this.horseArcher(b, u);
      else if (u.type.range) this.skirmisher(b, u);
      else if (u.general) this.general(b, u);
      else this.shockCavalry(b, u);
    }
  }

  // ---------------------------------------------------------------- army level

  private power(u: Unit): number {
    const t = u.type;
    return u.men * t.hp * (t.attack + t.armor + t.charge * 0.5) * (0.4 + 0.6 * (u.morale / 100));
  }

  private forward(b: Battle): number {
    return b.sides.get(this.side)!.rearX > b.terrain.width / 2 ? -1 : 1;
  }

  /** Enemy units well ahead of their own line and far from friends: the bait the feigned retreat is for. */
  isolated(b: Battle, e: Unit): boolean {
    if (!e.alive || e.state === 'routing') return false;
    const friends = b.units.filter((f) => f.side === e.side && f !== e && f.alive && f.state !== 'routing');
    if (friends.length === 0) return false;
    const nearest = Math.min(...friends.map((f) => Math.hypot(f.x - e.x, f.z - e.z)));
    const cx = friends.reduce((s, f) => s + f.x, 0) / friends.length;
    return nearest > 70 && (e.x - cx) * this.forward(b) < -30;
  }

  private choosePlan(b: Battle): Plan {
    const mine = b.units.filter((u) => u.side === this.side && u.alive && u.state !== 'routing');
    const theirs = b.units.filter((u) => u.side !== this.side && u.alive);
    if (theirs.length === 0) return 'advance';
    const ratio = mine.reduce((s, u) => s + this.power(u), 0) / Math.max(1, theirs.filter((u) => u.state !== 'routing').reduce((s, u) => s + this.power(u), 0));
    const disorder = theirs.filter((u) => u.state !== 'steady' || this.isolated(b, u)).length / theirs.length;
    const ha = mine.filter((u) => u.type.range && u.type.class === 'cavalry');
    const ammo = ha.reduce((s, u) => s + u.ammo, 0) / Math.max(1, ha.reduce((s, u) => s + (u.type.ammo ?? 0), 0));
    // Judge the fight relative to how it started, so the power metric's scale doesn't matter.
    this.startRatio ??= ratio;
    const trend = ratio / this.startRatio;
    if (trend < 0.45) return 'withdraw';
    // Pinned against our own map edge with the enemy closing: ride away rather than be caught.
    const rear = b.sides.get(this.side)!.rearX;
    const pinned = ha.filter((u) => Math.abs(u.x - rear) < 120 && b.nearestEnemy(u) && Math.hypot(b.nearestEnemy(u)!.x - u.x, b.nearestEnemy(u)!.z - u.z) < 200);
    if (ha.length > 0 && pinned.length >= Math.ceil(ha.length / 2)) return 'withdraw';
    if (disorder > 0.35 || trend > 1.8) return 'advance';
    if (ammo > 0.25 && b.time < 240) return 'harass';
    // Out of arrows and running out of time: commit if winning, otherwise leave the field.
    if (b.time > 600 && disorder < 0.35) return 'withdraw';
    if (b.time > 360) return trend >= 0.9 ? 'advance' : 'withdraw';
    return trend > 1.25 ? 'advance' : 'flank';
  }

  // ---------------------------------------------------------------- unit level

  /** Wounded or shaken units step back out of the fight; a reserve moves up to cover the gap. */
  private pullBack(b: Battle, u: Unit): boolean {
    if (u.general || u.contacts.length > 0) return false;
    if (u.ai.resting) {
      if (u.morale > 70) u.ai.resting = false;
      else return true;
    }
    if (u.morale >= 40 && u.lostFraction <= 0.6) return false;
    // A unit that has lost most of its men rests only until its nerve returns; it can't heal.
    if (u.lostFraction > 0.6 && u.morale > 70) return false;
    u.ai.resting = true;
    const rear = b.sides.get(this.side)!.rearX;
    b.orderMove(u.id, { x: u.x + Math.sign(rear - u.x) * 120, z: u.z, facing: u.facing, files: u.files });
    const reserve = b.units.find((r) => r.side === this.side && r.reserve && r.controllable && !r.order && r.contacts.length === 0 && r !== u);
    if (reserve) {
      b.orderMove(reserve.id, { x: u.x, z: u.z, facing: u.facing, files: reserve.files });
      b.log.push({ t: b.time, side: this.side, text: `${reserve.name} move up to cover for ${u.name}.`, kind: 'info' });
    }
    return true;
  }

  private safePoint(b: Battle, x: number, z: number): { x: number; z: number } {
    x = Math.max(15, Math.min(b.terrain.width - 15, x));
    z = Math.max(15, Math.min(b.terrain.depth - 15, z));
    for (let i = 0; i < 12 && b.terrain.inWater(x, z); i++) z += z > b.terrain.depth / 2 ? -12 : 12;
    return { x, z };
  }

  private horseArcher(b: Battle, u: Unit) {
    const range = u.type.range!;
    const e = b.nearestEnemy(u);
    if (!e) return;
    // Feigned retreat: anything that could catch us in melee gets led away (while we keep shooting
    // if we still have arrows). This applies with or without ammunition.
    const threat = b.units
      .filter((o) => o.side !== u.side && o.alive && o.controllable && !o.type.range)
      .map((o) => ({ o, d: Math.hypot(o.x - u.x, o.z - u.z) }))
      .filter(({ o, d }) => d < range * (o.type.class === 'cavalry' || o.type.class === 'elephant' ? 0.9 : 0.5))
      .sort((a, c) => a.d - c.d)[0];
    const soft = this.plan === 'advance' ? this.bestTarget(b, u) : null;
    const charging = u.ammo === 0 && soft && this.score(b, u, soft) > 0.5;
    if (threat && !charging) {
      const p = this.escape(b, u, threat.o);
      b.orderMove(u.id, { x: p.x, z: p.z, facing: Math.atan2(p.z - u.z, p.x - u.x), files: u.files }, 1, true);
      if (threat.o.type.class === 'cavalry' && u.ammo > 0 && b.time - this.lastFeintLog > 30) {
        this.lastFeintLog = b.time;
        b.log.push({ t: b.time, side: this.side, text: `${u.name} wheel away from ${threat.o.name}. A feigned retreat?`, kind: 'warn' });
      }
      return;
    }
    if (u.ammo === 0) {
      if (charging) {
        b.orderAttack(u.id, soft!.id, true);
      } else {
        const p = this.safePoint(b, u.ai.post!.x + Math.sign(b.sides.get(this.side)!.rearX - u.x) * 80, u.ai.post!.z);
        b.orderMove(u.id, { x: p.x, z: p.z, facing: u.facing, files: u.files });
      }
      return;
    }
    const d = Math.hypot(e.x - u.x, e.z - u.z);
    if (d > range * 0.9) {
      const a = Math.atan2(u.z - e.z, u.x - e.x);
      const p = this.safePoint(b, e.x + Math.cos(a) * range * 0.75, e.z + Math.sin(a) * range * 0.75);
      b.orderMove(u.id, { x: p.x, z: p.z, facing: a + Math.PI, files: u.files });
    } else {
      b.halt(u.id);
    }
  }

  /**
   * Pick an escape point: away from the threat, but swinging round it if straight back would
   * pin us against the map edge or the river. Horse archers live by having room to run.
   */
  private escape(b: Battle, u: Unit, threat: Unit): { x: number; z: number } {
    const melee = b.units.filter((o) => o.side !== u.side && o.alive && o.state !== 'routing' && !o.type.range);
    const base = Math.atan2(u.z - threat.z, u.x - threat.x);
    let best = { x: u.x, z: u.z };
    let bestScore = -Infinity;
    for (const off of [0, 30, -30, 60, -60, 90, -90, 120, -120]) {
      const a = base + (off * Math.PI) / 180;
      const x = u.x + Math.cos(a) * 110, z = u.z + Math.sin(a) * 110;
      const edge = Math.min(x, z, b.terrain.width - x, b.terrain.depth - z);
      let score = Math.min(...melee.map((o) => Math.hypot(o.x - x, o.z - z))) - Math.abs(off) * 0.15;
      if (edge < 20) score -= 1000;
      else if (edge < 80) score -= (80 - edge) * 2;
      if (b.terrain.inWater(x, z)) score -= 500;
      if (score > bestScore) (bestScore = score), (best = { x, z });
    }
    return best;
  }

  private skirmisher(b: Battle, u: Unit) {
    const rear = b.sides.get(this.side)!.rearX;
    const melee = b.nearestEnemy(u, (o) => o.state !== 'routing' && !o.type.range);
    if (u.ammo === 0 || (melee && Math.hypot(melee.x - u.x, melee.z - u.z) < 60)) {
      b.orderMove(u.id, { ...this.safePoint(b, u.x + Math.sign(rear - u.x) * 60, u.z), facing: u.facing, files: u.files }, 1, true);
      return;
    }
    const e = b.nearestEnemy(u);
    if (!e) return;
    const d = Math.hypot(e.x - u.x, e.z - u.z);
    const ahead = (u.x - u.ai.post!.x) * this.forward(b);
    if (d > u.type.range! * 0.95 && ahead < 120) b.orderAttack(u.id, e.id);
    else b.halt(u.id);
  }

  private general(b: Battle, u: Unit) {
    const friends = b.units.filter((f) => f.side === this.side && f.alive && f !== u && f.state !== 'routing');
    const ratio = friends.length;
    const e = b.nearestEnemy(u);
    if (this.plan === 'advance' && ratio > 3) {
      const t = this.bestTarget(b, u);
      if (t && (t.state !== 'steady' || this.isolated(b, t))) {
        b.orderAttack(u.id, t.id, true);
        return;
      }
    }
    if (e && Math.hypot(e.x - u.x, e.z - u.z) < 60 && e.state !== 'steady') {
      b.orderAttack(u.id, e.id, true);
      return;
    }
    if (friends.length) {
      const cx = friends.reduce((s, f) => s + f.x, 0) / friends.length;
      const cz = friends.reduce((s, f) => s + f.z, 0) / friends.length;
      const p = this.safePoint(b, cx - this.forward(b) * 90, cz);
      if (Math.hypot(p.x - u.x, p.z - u.z) > 25) b.orderMove(u.id, { x: p.x, z: p.z, facing: u.facing, files: u.files });
    }
  }

  private shockCavalry(b: Battle, u: Unit) {
    // Cycle charge: a cavalry unit losing a long melee disengages, then comes again.
    if (u.contacts.length > 0) {
      if (u.morale < 50 && u.sinceCharge > 10) {
        b.setStance(u.id, 'withdraw');
        u.ai.until = b.time + 8;
      }
      return;
    }
    if (u.stance === 'withdraw') {
      if (b.time < (u.ai.until ?? 0)) return;
      b.setStance(u.id, 'hold');
    }
    // The trap: punish anything that chased our horse archers away from its army.
    const bait = b.units
      .filter((e) => e.side !== u.side && this.isolated(b, e) && Math.hypot(e.x - u.x, e.z - u.z) < 280)
      .sort((a, c) => Math.hypot(a.x - u.x, a.z - u.z) - Math.hypot(c.x - u.x, c.z - u.z))[0];
    if (bait) {
      b.orderAttack(u.id, bait.id, true);
      return;
    }
    if (this.plan === 'advance') {
      const t = this.bestTarget(b, u);
      // Don't throw horsemen at an intact, unflanked line.
      if (t && this.score(b, u, t) > -1) {
        b.orderAttack(u.id, t.id, true);
        return;
      }
    }
    if (this.plan === 'flank') {
      const enemies = b.units.filter((e) => e.side !== u.side && e.alive && e.state !== 'routing');
      if (enemies.length === 0) return;
      const cx = enemies.reduce((s, e) => s + e.x, 0) / enemies.length;
      const zMin = Math.min(...enemies.map((e) => e.z));
      const fwd = this.forward(b);
      if (u.ai.role !== 'turned-in') {
        // Swing wide around the open (southern) flank, then commit to the attack.
        const p = this.safePoint(b, cx - fwd * 40, zMin - 80);
        if (Math.hypot(p.x - u.x, p.z - u.z) > 30 && (u.x - cx) * fwd < 40) {
          b.orderMove(u.id, { x: p.x, z: p.z, facing: fwd > 0 ? 0 : Math.PI, files: u.files });
          return;
        }
        u.ai.role = 'turned-in';
      }
      const t = this.bestTarget(b, u);
      if (t) b.orderAttack(u.id, t.id, true);
      return;
    }
    // Harass phase: wait at the post.
    const post = u.ai.post!;
    if (Math.hypot(post.x - u.x, post.z - u.z) > 30) b.orderMove(u.id, { x: post.x, z: post.z, facing: u.facing, files: u.files });
  }

  /** Score enemy units as charge targets: exposed flanks, archers, wavering and isolated units first. */
  private bestTarget(b: Battle, u: Unit): Unit | null {
    let best: Unit | null = null;
    let bestScore = -Infinity;
    for (const e of b.units) {
      if (e.side === u.side || !e.alive) continue;
      const s = this.score(b, u, e);
      if (s > bestScore) (bestScore = s), (best = e);
    }
    return best;
  }

  score(b: Battle, u: Unit, e: Unit): number {
      const d = Math.hypot(e.x - u.x, e.z - u.z);
      let s = -d / 100;
      if (e.state === 'routing') s += this.plan === 'advance' ? 0.8 : -3;
      if (e.state === 'wavering' || e.state === 'retreating') s += 1.5;
      if (this.isolated(b, e)) s += 2.5;
      if (e.type.class === 'missile') s += 1.5;
      if (e.type.class === 'elephant') s -= 2.5;
      const side = sideOf(e, u.x, u.z);
      if (side !== 'front') s += 2;
      else if (e.type.antiCavalry) s -= 2;
      if (e.contacts.length > 0 && side !== 'front') s += 1;
      return s;
  }
}
