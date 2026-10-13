// Order visuals laid on the terrain as clean ribbons: this turn's movement is a solid, type-coloured
// ribbon with an arrowhead and a ghost of the unit at its final position and facing; the projected
// continuation of a multi-turn path is a thinner faded ribbon. Ribbons are smoothed (Catmull-Rom),
// have a dark edge for contrast, and keep a readable width at any zoom.
import {
  BoxGeometry, BufferAttribute, BufferGeometry, DoubleSide, EdgesGeometry, Group, LineBasicMaterial,
  LineSegments, Mesh, MeshBasicMaterial,
} from 'three';
import { smoothPath } from '../input/formation';
import type { Terrain } from '../sim/terrain';
import type { XZ } from '../sim/types';

const LIFT = 0.9;
const MAX_PTS = 400;
const STEP = 2.5;

/** A flat strip following a polyline, draped over the ground. */
class Ribbon {
  readonly mesh: Mesh;
  private readonly pos = new Float32Array(MAX_PTS * 2 * 3);
  readonly mat: MeshBasicMaterial;

  constructor(order: number) {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(this.pos, 3));
    const idx: number[] = [];
    for (let i = 0; i < MAX_PTS - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geo.setIndex(idx);
    this.mat = new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, side: DoubleSide, depthTest: false, depthWrite: false });
    this.mesh = new Mesh(geo, this.mat);
    this.mesh.renderOrder = order;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** Lay the ribbon along `pts`. Returns the end point and direction (for an arrowhead). */
  set(terrain: Terrain, raw: XZ[], width: number, color: string, opacity: number, trimEnd = 0): { x: number; z: number; dir: number } | null {
    const smooth = raw.length >= 3 ? smoothPath(raw, STEP) : raw;
    // Resample evenly so curves stay round and straight runs don't waste vertices.
    const pts: XZ[] = [smooth[0]];
    let carry = 0;
    for (let i = 1; i < smooth.length; i++) {
      const a = smooth[i - 1], b = smooth[i];
      const seg = Math.hypot(b.x - a.x, b.z - a.z);
      let t = STEP - carry;
      while (t <= seg && pts.length < MAX_PTS - 1) {
        pts.push({ x: a.x + ((b.x - a.x) * t) / seg, z: a.z + ((b.z - a.z) * t) / seg });
        t += STEP;
      }
      carry = seg - (t - STEP);
    }
    const last = smooth[smooth.length - 1];
    if (Math.hypot(last.x - pts[pts.length - 1].x, last.z - pts[pts.length - 1].z) > 0.2) pts.push(last);
    // Stop short of the end so an arrowhead can sit there.
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
    if (pts.length < 2 || L < 0.5) {
      this.mesh.visible = false;
      return null;
    }
    const half = width / 2;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const nx = -(b.z - a.z) / l, nz = (b.x - a.x) / l;
      const p = pts[i];
      const lx = p.x + nx * half, lz = p.z + nz * half, rx = p.x - nx * half, rz = p.z - nz * half;
      this.pos.set([lx, terrain.height(lx, lz) + LIFT, lz, rx, terrain.height(rx, rz) + LIFT, rz], i * 6);
    }
    this.mesh.geometry.setDrawRange(0, (pts.length - 1) * 6);
    (this.mesh.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    this.mat.color.set(color);
    this.mat.opacity = opacity;
    this.mesh.visible = true;
    const n = pts.length;
    return { x: pts[n - 1].x, z: pts[n - 1].z, dir: Math.atan2(pts[n - 1].z - pts[n - 2].z, pts[n - 1].x - pts[n - 2].x) };
  }

  hide() {
    this.mesh.visible = false;
  }
}

/** A flat arrowhead (triangle) draped at a point. */
class Arrowhead {
  readonly mesh: Mesh;
  private readonly pos = new Float32Array(9);
  constructor(order: number) {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(this.pos, 3));
    this.mesh = new Mesh(geo, new MeshBasicMaterial({ color: '#ffffff', transparent: true, side: DoubleSide, depthTest: false, depthWrite: false }));
    this.mesh.renderOrder = order;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }
  set(terrain: Terrain, x: number, z: number, dir: number, size: number, color: string, opacity: number) {
    const c = Math.cos(dir), s = Math.sin(dir);
    const tip = { x: x + c * size * 1.3, z: z + s * size * 1.3 };
    const l = { x: x - s * size * 0.75, z: z + c * size * 0.75 };
    const r = { x: x + s * size * 0.75, z: z - c * size * 0.75 };
    let i = 0;
    for (const p of [tip, l, r]) this.pos.set([p.x, terrain.height(p.x, p.z) + LIFT, p.z], i++ * 3);
    (this.mesh.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    const m = this.mesh.material as MeshBasicMaterial;
    m.color.set(color);
    m.opacity = opacity;
    this.mesh.visible = true;
  }
}

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

/** One path drawing: a dark edge ribbon, the coloured ribbon, and an arrowhead (with its own edge). */
class PathDrawing {
  readonly edge = new Ribbon(5);
  readonly body = new Ribbon(6);
  readonly headEdge = new Arrowhead(5);
  readonly head = new Arrowhead(6);
  meshes() {
    return [this.edge.mesh, this.body.mesh, this.headEdge.mesh, this.head.mesh];
  }
  draw(terrain: Terrain, pts: XZ[], width: number, color: string, opacity: number, arrow: boolean) {
    const trim = arrow ? width * 1.2 : 0;
    this.edge.set(terrain, pts, width * 1.7, '#14110b', opacity * 0.55, trim);
    const end = this.body.set(terrain, pts, width, color, opacity, trim);
    if (arrow && end) {
      this.headEdge.set(terrain, end.x, end.z, end.dir, width * 2.1, '#14110b', opacity * 0.55);
      this.head.set(terrain, end.x, end.z, end.dir, width * 1.7, color, opacity);
    } else {
      this.head.mesh.visible = this.headEdge.mesh.visible = false;
    }
  }
  hide() {
    for (const m of this.meshes()) m.visible = false;
  }
}

export class OrderOverlay {
  readonly root = new Group();
  private paths: PathDrawing[] = [];
  private ghosts: Group[] = [];
  private readonly trail = new PathDrawing();
  private readonly box = new BoxGeometry(1, 1, 1);
  /** World width of a ribbon, scaled with camera distance so it reads the same at any zoom. */
  private width = 2;

  constructor(private readonly terrain: Terrain) {
    this.root.add(...this.trail.meshes());
    this.trail.hide();
  }

  setCameraDistance(d: number) {
    this.width = Math.max(1.2, Math.min(7, d * 0.007));
  }

  private path(i: number): PathDrawing {
    while (this.paths.length <= i) {
      const p = new PathDrawing();
      this.paths.push(p);
      this.root.add(...p.meshes());
    }
    return this.paths[i];
  }

  private ghost(i: number, color: string): Group {
    while (this.ghosts.length <= i) {
      const g = new Group();
      g.add(
        new Mesh(this.box, new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.16, depthWrite: false })),
        new LineSegments(new EdgesGeometry(this.box), new LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.8 })),
      );
      this.ghosts.push(g);
      this.root.add(g);
    }
    const g = this.ghosts[i];
    ((g.children[0] as Mesh).material as MeshBasicMaterial).color.set(color);
    ((g.children[1] as LineSegments).material as LineBasicMaterial).color.set(color);
    return g;
  }

  show(items: OrderVisual[]) {
    let pi = 0, gi = 0;
    for (const it of items) {
      if (it.now.length >= 2) this.path(pi++).draw(this.terrain, it.now, it.arrow ? this.width : this.width * 0.6, it.color, 0.95, it.arrow && !it.later.length);
      if (it.later.length >= 2) this.path(pi++).draw(this.terrain, it.later, this.width * 0.55, it.color, 0.35, it.arrow);
      if (it.ghost) {
        const g = this.ghost(gi++, it.color);
        g.position.set(it.ghost.x, this.terrain.height(it.ghost.x, it.ghost.z) + 1, it.ghost.z);
        g.rotation.y = -it.ghost.facing;
        g.scale.set(it.ghost.depth, 2, it.ghost.frontage);
        g.visible = true;
      }
    }
    for (let i = pi; i < this.paths.length; i++) this.paths[i].hide();
    for (let i = gi; i < this.ghosts.length; i++) this.ghosts[i].visible = false;
  }

  /** The curve being drawn right now. */
  setTrail(points: XZ[] | null, color = '#ffffff') {
    if (!points || points.length < 2) {
      this.trail.hide();
      return;
    }
    this.trail.draw(this.terrain, points, this.width * 0.9, color, 0.9, true);
  }
}
