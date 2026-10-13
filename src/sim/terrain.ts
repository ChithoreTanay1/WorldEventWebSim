// Analytic terrain: gentle undulation + gaussian hills - a carved river. Pure functions, so the
// simulation and the renderer agree exactly on heights.
import type { Hill, River } from './types';

export const WATER_LEVEL = -0.5;

export class Terrain {
  readonly width: number;
  readonly depth: number;

  constructor(
    size: [number, number],
    private readonly hills: Hill[],
    readonly river?: River,
  ) {
    [this.width, this.depth] = size;
    if (river) {
      const pad = river.width / 2 + 10;
      const xs = river.points.map((p) => p[0]), zs = river.points.map((p) => p[1]);
      this.riverBox = [Math.min(...xs) - pad, Math.min(...zs) - pad, Math.max(...xs) + pad, Math.max(...zs) + pad];
    }
  }

  /** Bounding box of the river channel, for a cheap early-out (height() runs for every soldier every frame). */
  private riverBox: [number, number, number, number] | null = null;

  /** Distance from (x, z) to the river centre line. */
  riverDistance(x: number, z: number): number {
    if (!this.river) return Infinity;
    const p = this.river.points;
    let best = Infinity;
    for (let i = 0; i < p.length - 1; i++) {
      const [ax, az] = p[i];
      const [bx, bz] = p[i + 1];
      const dx = bx - ax, dz = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
      best = Math.min(best, Math.hypot(x - (ax + t * dx), z - (az + t * dz)));
    }
    return best;
  }

  private fordFactor(x: number, z: number): number {
    for (const f of this.river?.fords ?? []) {
      const d = Math.hypot(x - f.pos[0], z - f.pos[1]);
      if (d < f.radius) return 1 - d / f.radius;
    }
    return 0;
  }

  height(x: number, z: number): number {
    let h = 0.6 + 0.35 * Math.sin(x * 0.021) * Math.cos(z * 0.017) + 0.25 * Math.sin((x + z) * 0.043);
    for (const hill of this.hills) {
      const d2 = (x - hill.pos[0]) ** 2 + (z - hill.pos[1]) ** 2;
      const s = hill.radius / 2;
      h += hill.height * Math.exp(-d2 / (2 * s * s));
    }
    const rb = this.riverBox;
    if (this.river && rb && x >= rb[0] && x <= rb[2] && z >= rb[1] && z <= rb[3]) {
      const half = this.river.width / 2;
      const d = this.riverDistance(x, z);
      if (d < half + 8) {
        const t = Math.max(0, Math.min(1, (half + 8 - d) / 8)); // 0 at bank top, 1 inside channel
        const s = t * t * (3 - 2 * t);
        const depth = this.river.depth * (1 - 0.75 * this.fordFactor(x, z));
        h = h * (1 - s) + (WATER_LEVEL - depth + 0.3) * s;
      }
    }
    return h;
  }

  inWater(x: number, z: number): boolean {
    return this.height(x, z) < WATER_LEVEL;
  }

  /** 0 on dry ground, 0.5 at a ford, 1 in the river: scales the shallow-water modifiers. */
  waterFactor(x: number, z: number): number {
    if (!this.inWater(x, z)) return 0;
    return this.fordFactor(x, z) > 0 ? 0.5 : 1;
  }

  /**
   * Line of sight between two points, eyes `eye` metres above ground. Ground rising above the sight
   * line blocks it outright (wiki: ridges create dead ground).
   */
  lineOfSight(ax: number, az: number, bx: number, bz: number, eye = 3): boolean {
    const ha = this.height(ax, az) + eye, hb = this.height(bx, bz) + eye;
    const n = Math.max(4, Math.ceil(Math.hypot(bx - ax, bz - az) / 25));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (this.height(ax + (bx - ax) * t, az + (bz - az) * t) > ha + (hb - ha) * t) return false;
    }
    return true;
  }

  /** Movement multiplier for terrain at a point, by unit category. */
  speedFactor(x: number, z: number, cls: string): number {
    if (!this.inWater(x, z)) return 1;
    const ford = this.fordFactor(x, z) > 0;
    if (cls === 'elephant') return ford ? 0.8 : 0.55;
    if (cls === 'cavalry') return ford ? 0.6 : 0.35;
    return ford ? 0.55 : 0.3;
  }

  inside(x: number, z: number, margin = 0): boolean {
    return x >= margin && z >= margin && x <= this.width - margin && z <= this.depth - margin;
  }
}
