// Campaign map geography: projection from lon/lat, a baked heightfield (mountains, hills, carved
// rivers, seas) and lookups the battle generator uses (is there a river here, how hilly is it).
import type { CampaignData, LonLat } from './types';

export const MAP_WATER = -0.5;
/** Heightfield sample spacing, map units. */
export const GEO_CELL = 6;
const RIVER_HALF = 4.5;
const RIVER_BANK = 5;

export interface XZ {
  x: number;
  z: number;
}

type Seg = [number, number, number, number];

export class MapGeo {
  readonly width: number;
  readonly depth: number;
  readonly nx: number;
  readonly nz: number;
  private readonly heights: Float32Array;
  /** Rivers as segments, each with a bounding box so far-away rivers are skipped cheaply. */
  private readonly riverSegs: { name: string; segs: Seg[]; box: [number, number, number, number] }[];
  /** Distance to the nearest river at every grid vertex (baked with the heights). */
  private readonly riverGrid: Float32Array;
  private readonly ridge: XZ[];
  private readonly hills: { x: number; z: number; s: number; h: number }[];
  private readonly deserts: { x: number; z: number; r: number }[];
  private readonly seas: XZ[][];

  constructor(readonly data: CampaignData) {
    const [lon0, lat0, lon1, lat1] = data.bounds;
    this.width = (lon1 - lon0) * data.scale;
    this.depth = (lat1 - lat0) * data.scale;
    this.riverSegs = data.rivers.map((r) => {
      const p = r.points.map((q) => this.project(q));
      const segs: Seg[] = [];
      for (let i = 0; i < p.length - 1; i++) segs.push([p[i].x, p[i].z, p[i + 1].x, p[i + 1].z]);
      const xs = p.map((q) => q.x), zs = p.map((q) => q.z);
      return { name: r.name, segs, box: [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)] as [number, number, number, number] };
    });
    this.ridge = data.ridge.map((q) => this.project(q));
    this.hills = data.hills.map((hl) => ({ ...this.project(hl.pos), s: (hl.radius * data.scale) / 2, h: hl.height }));
    this.deserts = data.deserts.map((d) => ({ ...this.project(d.pos), r: d.radius * data.scale }));
    this.seas = data.seas.map((poly) => poly.map((q) => this.project(q)));
    this.nx = Math.round(this.width / GEO_CELL);
    this.nz = Math.round(this.depth / GEO_CELL);
    this.heights = new Float32Array((this.nx + 1) * (this.nz + 1));
    this.riverGrid = new Float32Array((this.nx + 1) * (this.nz + 1));
    for (let iz = 0, i = 0; iz <= this.nz; iz++) {
      for (let ix = 0; ix <= this.nx; ix++, i++) {
        const x = ix * GEO_CELL, z = iz * GEO_CELL;
        const d = this.riverDistance(x, z).d;
        this.riverGrid[i] = d;
        this.heights[i] = this.rawHeight(x, z, d);
      }
    }
  }

  project([lon, lat]: LonLat): XZ {
    const [lon0, , , lat1] = this.data.bounds;
    return { x: (lon - lon0) * this.data.scale, z: (lat1 - lat) * this.data.scale };
  }

  /** How far north of the Himalayan crest a point is (positive = into the mountains). */
  private northOfRidge(x: number, z: number): number {
    const r = this.ridge;
    let rz = r[0].z;
    if (x >= r[r.length - 1].x) rz = r[r.length - 1].z;
    else {
      for (let i = 0; i < r.length - 1; i++) {
        if (x >= r[i].x && x <= r[i + 1].x) {
          rz = r[i].z + ((x - r[i].x) / (r[i + 1].x - r[i].x)) * (r[i + 1].z - r[i].z);
          break;
        }
      }
    }
    return rz - z;
  }

  riverDistance(x: number, z: number): { d: number; name: string } {
    let best = Infinity, name = '';
    for (const r of this.riverSegs) {
      // Skip a river whose bounding box is already further away than the best so far.
      const bx = Math.max(r.box[0] - x, 0, x - r.box[2]), bz = Math.max(r.box[1] - z, 0, z - r.box[3]);
      if (bx * bx + bz * bz >= best * best) continue;
      for (const [ax, az, bx, bz] of r.segs) {
        const dx = bx - ax, dz = bz - az;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
        const d = Math.hypot(x - (ax + t * dx), z - (az + t * dz));
        if (d < best) (best = d), (name = r.name);
      }
    }
    return { d: best, name };
  }

  /** 0..1 desert sand at a point. */
  desert(x: number, z: number): number {
    let v = 0;
    for (const d of this.deserts) v = Math.max(v, 1 - Math.hypot(x - d.x, z - d.z) / d.r);
    return Math.min(1, v * 2.2);
  }

  inSea(x: number, z: number): boolean {
    for (const poly of this.seas) {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  }

  /** Hill and mountain height only (no rivers or sea): the battle generator reads relief from this. */
  relief(x: number, z: number): number {
    let h = 0;
    const n = this.northOfRidge(x, z);
    if (n > -60) {
      const t = Math.min(1, (n + 60) / 160);
      // Ridged, non-repeating variation: sums of rotated sines read as spurs and valleys, not a grid of pits.
      const ridges = Math.abs(Math.sin(x * 0.021 + z * 0.013)) * 0.5 + Math.abs(Math.sin(x * 0.047 - z * 0.031 + 1.7)) * 0.3 + Math.abs(Math.sin(x * 0.011 - z * 0.029 + 0.4)) * 0.2;
      h += 46 * t * t * (3 - 2 * t) * (0.7 + 0.45 * ridges) + Math.max(0, n) * 0.04;
    }
    for (const hl of this.hills) {
      const d2 = (x - hl.x) ** 2 + (z - hl.z) ** 2;
      h += hl.h * Math.exp(-d2 / (2 * hl.s * hl.s)) * (0.85 + 0.15 * Math.sin(x * 0.11 + z * 0.07));
    }
    return h;
  }

  private rawHeight(x: number, z: number, d: number): number {
    let h = 1 + 0.5 * Math.sin(x * 0.013) * Math.cos(z * 0.011) + 0.3 * Math.sin((x - z) * 0.031);
    h += this.relief(x, z);
    if (this.inSea(x, z)) return MAP_WATER - 3;
    if (d < RIVER_HALF + RIVER_BANK) {
      const t = Math.max(0, Math.min(1, (RIVER_HALF + RIVER_BANK - d) / RIVER_BANK));
      const s = t * t * (3 - 2 * t);
      h = h * (1 - s) + (MAP_WATER - 1.2) * s;
    }
    return h;
  }

  /** Bilinear sample of the baked heightfield. */
  height(x: number, z: number): number {
    const fx = Math.max(0, Math.min(this.nx - 1e-6, x / GEO_CELL));
    const fz = Math.max(0, Math.min(this.nz - 1e-6, z / GEO_CELL));
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const w = this.nx + 1;
    const a = this.heights[iz * w + ix], b = this.heights[iz * w + ix + 1];
    const c = this.heights[(iz + 1) * w + ix], d = this.heights[(iz + 1) * w + ix + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }

  /** Grid height by vertex index (renderer). */
  /** Distance to the nearest river at a grid vertex. */
  gridRiver(ix: number, iz: number): number {
    return this.riverGrid[iz * (this.nx + 1) + ix];
  }

  /** Distance to the nearest river, from the baked grid (nearest vertex; for scattering, colouring). */
  riverNear(x: number, z: number): number {
    const ix = Math.max(0, Math.min(this.nx, Math.round(x / GEO_CELL)));
    const iz = Math.max(0, Math.min(this.nz, Math.round(z / GEO_CELL)));
    return this.riverGrid[iz * (this.nx + 1) + ix];
  }

  gridHeight(ix: number, iz: number): number {
    return this.heights[iz * (this.nx + 1) + ix];
  }
}
