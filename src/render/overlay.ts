// Order visuals laid on the terrain as clean ribbons: this turn's movement is a solid, type-coloured
// ribbon with an arrowhead and a ghost of the unit at its final position and facing; the projected
// continuation of a multi-turn path is a thinner faded ribbon. Ribbons are smoothed (Catmull-Rom),
// have a dark edge for contrast, and keep a readable width at any zoom.
//
// Batched for speed: every ribbon and arrowhead goes into two shared meshes (dark edges underneath,
// colours on top) and the ghosts into one instanced box plus one line set: four draw calls however
// many orders are shown. Geometry is rebuilt only when the orders or the zoom change, not per frame.
import {
  BoxGeometry, BufferAttribute, BufferGeometry, Color, DoubleSide, EdgesGeometry, Group, InstancedBufferAttribute,
  InstancedMesh, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial,
} from 'three';
import { smoothPath } from '../input/formation';
import type { XZ } from '../sim/types';
import type { HeightCache } from './heightCache';

const LIFT = 0.9;
const STEP = 2.5;
const EDGE = '#14110b';

export interface OrderVisual {
  /** Solid part: movement this turn. */
  now: XZ[];
  /** Faded part: the projected continuation (multi-turn paths). */
  later: XZ[];
  color: string;
  ghost: { x: number; z: number; facing: number; frontage: number; depth: number } | null;
  /** Arrowhead at the end of `now` (move orders) or not (lock-on lines). */
  arrow: boolean;
}

export const ORDER_COLORS: Record<string, string> = {
  fireAdvance: '#ffb347',
  run: '#ff6b52',
  shoot: '#ff4f9a',
  walk: '#9fd4ff',
  fallback: '#b9a7ff',
  rotate: '#e6e6e6',
  follow: '#8fe3a8',
  deploy: '#fff0b8',
};

const tmp = new Color();

/** A growable triangle soup with RGBA vertex colours, drawn in one call. */
class TriBatch {
  readonly mesh: Mesh;
  private pos = new Float32Array(0);
  private col = new Float32Array(0);
  private n = 0;

  constructor(renderOrder: number) {
    // forceSinglePass: three otherwise draws transparent double-sided materials in two passes and
    // flags the material for a shader-program rebuild between them, every frame (CPU + garbage).
    const mat = new MeshBasicMaterial({ vertexColors: true, transparent: true, side: DoubleSide, depthTest: false, depthWrite: false, forceSinglePass: true });
    this.mesh = new Mesh(new BufferGeometry(), mat);
    this.mesh.renderOrder = renderOrder;
    this.mesh.frustumCulled = false;
    this.grow(4096);
  }

  private grow(cap: number) {
    const pos = new Float32Array(cap * 3), col = new Float32Array(cap * 4);
    pos.set(this.pos.subarray(0, this.n * 3));
    col.set(this.col.subarray(0, this.n * 4));
    this.pos = pos;
    this.col = col;
    const g = this.mesh.geometry;
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('color', new BufferAttribute(col, 4));
  }

  clear() {
    this.n = 0;
  }

  vertex(x: number, y: number, z: number, c: Color, a: number) {
    if (this.n * 3 + 3 > this.pos.length) this.grow(this.pos.length / 3 * 2);
    const i = this.n++;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.col[i * 4] = c.r;
    this.col[i * 4 + 1] = c.g;
    this.col[i * 4 + 2] = c.b;
    this.col[i * 4 + 3] = a;
  }

  commit() {
    const g = this.mesh.geometry;
    g.setDrawRange(0, this.n);
    g.getAttribute('position').needsUpdate = true;
    g.getAttribute('color').needsUpdate = true;
    this.mesh.visible = this.n > 0;
  }
}

export class OrderOverlay {
  readonly root = new Group();
  private readonly edges = new TriBatch(5);
  private readonly bodies = new TriBatch(6);
  private ghostBoxes: InstancedMesh;
  private ghostLines: LineSegments;
  private readonly boxEdges: Float32Array;
  private ghostCap = 0;
  /** World width of a ribbon, scaled with camera distance so it reads the same at any zoom. */
  private width = 2;
  private items: OrderVisual[] = [];
  private trail: { points: XZ[]; color: string; opacity: number; width: number } | null = null;
  private dirty = true;

  constructor(private readonly heights: HeightCache) {
    this.boxEdges = (new EdgesGeometry(new BoxGeometry(1, 1, 1)).getAttribute('position').array as Float32Array).slice();
    this.ghostBoxes = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.16, depthWrite: false }), 1);
    this.ghostLines = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ vertexColors: true, transparent: true }));
    this.growGhosts(16);
    this.root.add(this.edges.mesh, this.bodies.mesh);
  }

  private growGhosts(cap: number) {
    this.root.remove(this.ghostBoxes, this.ghostLines);
    this.ghostBoxes.dispose();
    this.ghostLines.geometry.dispose();
    this.ghostCap = cap;
    this.ghostBoxes = new InstancedMesh(this.ghostBoxes.geometry, this.ghostBoxes.material, cap);
    this.ghostBoxes.instanceColor = new InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.ghostBoxes.frustumCulled = false;
    const per = this.boxEdges.length / 3;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(cap * per * 3), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(cap * per * 4), 4));
    this.ghostLines = new LineSegments(g, this.ghostLines.material);
    this.ghostLines.frustumCulled = false;
    this.root.add(this.ghostBoxes, this.ghostLines);
  }

  setCameraDistance(d: number) {
    // Quantised so a smooth zoom rebuilds the ribbons a few times, not every frame.
    const w = Math.round(Math.max(1.2, Math.min(7, d * 0.007)) * 10) / 10;
    if (w !== this.width) {
      this.width = w;
      this.dirty = true;
    }
  }

  /** Show these order visuals. Pass the same array again (unchanged orders) and nothing is rebuilt. */
  show(items: OrderVisual[]) {
    if (items !== this.items) {
      this.items = items;
      this.dirty = true;
    }
    if (this.dirty) this.rebuild();
  }

  /** The curve being drawn right now. */
  setTrail(points: XZ[] | null, color = '#ffffff', opacity = 0.9, width = 0.9) {
    this.trail = points && points.length >= 2 ? { points, color, opacity, width } : null;
    this.dirty = true;
  }

  private rebuild() {
    this.dirty = false;
    this.edges.clear();
    this.bodies.clear();
    for (const it of this.items) {
      if (it.now.length >= 2) this.path(it.now, it.arrow ? this.width : this.width * 0.6, it.color, 0.95, it.arrow && !it.later.length);
      if (it.later.length >= 2) this.path(it.later, this.width * 0.55, it.color, 0.35, it.arrow);
    }
    if (this.trail) this.path(this.trail.points, this.width * this.trail.width, this.trail.color, this.trail.opacity, this.trail.opacity > 0.5);
    this.edges.commit();
    this.bodies.commit();
    this.rebuildGhosts();
  }

  private rebuildGhosts() {
    const ghosts = this.items.filter((it) => it.ghost);
    if (ghosts.length > this.ghostCap) this.growGhosts(Math.max(ghosts.length, this.ghostCap * 2));
    const m = this.ghostBoxes.instanceMatrix.array as Float32Array;
    const c = this.ghostBoxes.instanceColor!.array as Float32Array;
    const lp = this.ghostLines.geometry.getAttribute('position').array as Float32Array;
    const lc = this.ghostLines.geometry.getAttribute('color').array as Float32Array;
    const per = this.boxEdges.length / 3;
    m.fill(0);
    lc.fill(0);
    ghosts.forEach((it, i) => {
      const g = it.ghost!;
      const y = this.heights.height(g.x, g.z) + 1;
      // Box rotated by -facing, scaled (depth, 2, frontage): as the unit block itself.
      const cs = Math.cos(g.facing), sn = -Math.sin(g.facing);
      const o = i * 16;
      m[o] = cs * g.depth; m[o + 2] = -sn * g.depth;
      m[o + 5] = 2;
      m[o + 8] = sn * g.frontage; m[o + 10] = cs * g.frontage;
      m[o + 12] = g.x; m[o + 13] = y; m[o + 14] = g.z; m[o + 15] = 1;
      tmp.set(it.color);
      c.set([tmp.r, tmp.g, tmp.b], i * 3);
      for (let v = 0; v < per; v++) {
        const lx = this.boxEdges[v * 3] * g.depth, ly = this.boxEdges[v * 3 + 1] * 2, lz = this.boxEdges[v * 3 + 2] * g.frontage;
        const q = (i * per + v) * 3;
        lp[q] = g.x + cs * lx + sn * lz;
        lp[q + 1] = y + ly;
        lp[q + 2] = g.z - sn * lx + cs * lz;
        lc.set([tmp.r, tmp.g, tmp.b, 0.8], (i * per + v) * 4);
      }
    });
    this.ghostBoxes.instanceMatrix.needsUpdate = true;
    this.ghostBoxes.instanceColor!.needsUpdate = true;
    this.ghostLines.geometry.setDrawRange(0, ghosts.length * per);
    this.ghostLines.geometry.getAttribute('position').needsUpdate = true;
    this.ghostLines.geometry.getAttribute('color').needsUpdate = true;
  }

  /** One drawing: a dark edge ribbon, the coloured ribbon, and an arrowhead (with its own edge). */
  private path(raw: XZ[], width: number, color: string, opacity: number, arrow: boolean) {
    const trim = arrow ? width * 1.2 : 0;
    const pts = this.resampled(raw, trim);
    if (!pts) return;
    const edge = tmp.set(EDGE).clone();
    this.strip(this.edges, pts, width * 1.7, edge, opacity * 0.55);
    const body = tmp.set(color).clone();
    this.strip(this.bodies, pts, width, body, opacity);
    if (!arrow) return;
    const n = pts.length;
    const dir = Math.atan2(pts[n - 1].z - pts[n - 2].z, pts[n - 1].x - pts[n - 2].x);
    this.head(this.edges, pts[n - 1], dir, width * 2.1, edge, opacity * 0.55);
    this.head(this.bodies, pts[n - 1], dir, width * 1.7, body, opacity);
  }

  /** Smooth and resample a polyline evenly, stopping `trimEnd` short of its end (room for an arrowhead). */
  private resampled(raw: XZ[], trimEnd: number): XZ[] | null {
    const smooth = raw.length >= 3 ? smoothPath(raw, STEP) : raw;
    const pts: XZ[] = [smooth[0]];
    let carry = 0;
    for (let i = 1; i < smooth.length; i++) {
      const a = smooth[i - 1], b = smooth[i];
      const seg = Math.hypot(b.x - a.x, b.z - a.z);
      let t = STEP - carry;
      while (t <= seg) {
        pts.push({ x: a.x + ((b.x - a.x) * t) / seg, z: a.z + ((b.z - a.z) * t) / seg });
        t += STEP;
      }
      carry = seg - (t - STEP);
    }
    const last = smooth[smooth.length - 1];
    if (Math.hypot(last.x - pts[pts.length - 1].x, last.z - pts[pts.length - 1].z) > 0.2) pts.push(last);
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    while (trimEnd > 0 && pts.length > 2) {
      const n = pts.length;
      const seg = Math.hypot(pts[n - 1].x - pts[n - 2].x, pts[n - 1].z - pts[n - 2].z);
      if (seg > trimEnd) {
        const k = (seg - trimEnd) / seg;
        pts[n - 1] = { x: pts[n - 2].x + (pts[n - 1].x - pts[n - 2].x) * k, z: pts[n - 2].z + (pts[n - 1].z - pts[n - 2].z) * k };
        break;
      }
      pts.pop();
      trimEnd -= seg;
    }
    return pts.length < 2 || L < 0.5 ? null : pts;
  }

  /** A flat strip draped over the ground along the points. */
  private strip(batch: TriBatch, pts: XZ[], width: number, c: Color, a: number) {
    const half = width / 2;
    let plx = 0, ply = 0, plz = 0, prx = 0, pry = 0, prz = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q0 = pts[Math.max(0, i - 1)], q1 = pts[Math.min(pts.length - 1, i + 1)];
      const l = Math.hypot(q1.x - q0.x, q1.z - q0.z) || 1;
      const nx = -(q1.z - q0.z) / l, nz = (q1.x - q0.x) / l;
      const lx = p.x + nx * half, lz = p.z + nz * half, rx = p.x - nx * half, rz = p.z - nz * half;
      const ly = this.heights.height(lx, lz) + LIFT, ry = this.heights.height(rx, rz) + LIFT;
      if (i > 0) {
        batch.vertex(plx, ply, plz, c, a);
        batch.vertex(prx, pry, prz, c, a);
        batch.vertex(lx, ly, lz, c, a);
        batch.vertex(prx, pry, prz, c, a);
        batch.vertex(rx, ry, rz, c, a);
        batch.vertex(lx, ly, lz, c, a);
      }
      plx = lx; ply = ly; plz = lz; prx = rx; pry = ry; prz = rz;
    }
  }

  /** A flat arrowhead (triangle) draped at a point. */
  private head(batch: TriBatch, at: XZ, dir: number, size: number, c: Color, a: number) {
    const cs = Math.cos(dir), sn = Math.sin(dir);
    const pts = [
      [at.x + cs * size * 1.3, at.z + sn * size * 1.3],
      [at.x - sn * size * 0.75, at.z + cs * size * 0.75],
      [at.x + sn * size * 0.75, at.z - cs * size * 0.75],
    ];
    for (const [x, z] of pts) batch.vertex(x, this.heights.height(x, z) + LIFT, z, c, a);
  }
}
