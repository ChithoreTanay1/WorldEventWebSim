// Render-side ground heights, sampled once on the terrain mesh's own grid and interpolated across the
// same triangles the mesh draws: things placed with it sit exactly on the visible ground, at the cost
// of a few array reads instead of the analytic terrain function. The simulation keeps using Terrain.
import type { Terrain } from '../sim/terrain';

/** Terrain mesh cell size (metres); terrainView builds its grid from this cache. */
export const TERRAIN_CELL = 4;
/** Height of the flat land drawn beyond the map edge. */
export const OUTSIDE_HEIGHT = -0.15;

export class HeightCache {
  readonly nx: number;
  readonly nz: number;
  readonly cx: number;
  readonly cz: number;
  readonly h: Float32Array;

  constructor(readonly terrain: Terrain) {
    this.nx = Math.round(terrain.width / TERRAIN_CELL);
    this.nz = Math.round(terrain.depth / TERRAIN_CELL);
    this.cx = terrain.width / this.nx;
    this.cz = terrain.depth / this.nz;
    this.h = new Float32Array((this.nx + 1) * (this.nz + 1));
    for (let iz = 0, i = 0; iz <= this.nz; iz++) {
      for (let ix = 0; ix <= this.nx; ix++, i++) this.h[i] = terrain.height(ix * this.cx, iz * this.cz);
    }
  }

  /** Grid vertex height (the terrain mesh reads these). */
  at(ix: number, iz: number): number {
    return this.h[iz * (this.nx + 1) + ix];
  }

  /** Height of the drawn ground at a point (the mesh splits each cell along the b-d diagonal). */
  height(x: number, z: number): number {
    const fx = x / this.cx, fz = z / this.cz;
    if (fx < 0 || fz < 0 || fx > this.nx || fz > this.nz) return OUTSIDE_HEIGHT;
    const ix = Math.min(this.nx - 1, Math.floor(fx)), iz = Math.min(this.nz - 1, Math.floor(fz));
    const tx = fx - ix, tz = fz - iz;
    const w = this.nx + 1, i = iz * w + ix;
    const a = this.h[i], b = this.h[i + 1], d = this.h[i + w], e = this.h[i + w + 1];
    return tx + tz <= 1 ? a + (b - a) * tx + (d - a) * tz : e + (d - e) * (1 - tx) + (b - e) * (1 - tz);
  }
}
