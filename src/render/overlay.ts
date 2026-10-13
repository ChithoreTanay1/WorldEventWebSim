// Order visuals draped over the terrain (wiki "Reading orders on the map"): this turn's movement is a
// solid, type-coloured arrow ending in a ghost of the unit at its final position and facing; the
// projected continuation of a multi-turn path is faded. Also the raw drag trail and lock-on lines.
import {
  BoxGeometry, BufferAttribute, BufferGeometry, DoubleSide, EdgesGeometry, Group, Line, LineBasicMaterial,
  LineSegments, Mesh, MeshBasicMaterial, Shape, ShapeGeometry,
} from 'three';
import type { Terrain } from '../sim/terrain';
import type { XZ } from '../sim/types';

const LIFT = 0.8;
const MAX_PTS = 256;

class DrapedLine {
  readonly line: Line;
  private readonly pos = new Float32Array(MAX_PTS * 3);
  readonly mat: LineBasicMaterial;
  constructor() {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(this.pos, 3));
    this.mat = new LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, depthTest: false });
    this.line = new Line(geo, this.mat);
    this.line.renderOrder = 5;
    this.line.frustumCulled = false;
  }
  /** Drape a polyline, resampling long segments so it follows the ground. */
  set(terrain: Terrain, pts: XZ[], color: string, opacity: number) {
    let n = 0;
    for (let i = 0; i < pts.length - 1 && n < MAX_PTS - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const steps = Math.max(1, Math.min(24, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 8)));
      for (let k = 0; k < steps && n < MAX_PTS - 1; k++) {
        const t = k / steps;
        const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
        this.pos.set([x, terrain.height(x, z) + LIFT, z], n++ * 3);
      }
    }
    const last = pts[pts.length - 1];
    this.pos.set([last.x, terrain.height(last.x, last.z) + LIFT, last.z], n++ * 3);
    this.line.geometry.setDrawRange(0, n);
    (this.line.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    this.mat.color.set(color);
    this.mat.opacity = opacity;
    this.line.visible = n >= 2;
  }
}

export interface OrderVisual {
  /** Solid part: movement this turn. */
  now: XZ[];
  /** Faded part: the projected continuation (multi-turn paths). */
  later: XZ[];
  color: string;
  ghost: { x: number; z: number; facing: number; frontage: number; depth: number } | null;
  /** Draw an arrowhead at the end of `now` (move orders) or not (lock-on lines). */
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

export class OrderOverlay {
  readonly root = new Group();
  private lines: DrapedLine[] = [];
  private arrows: Mesh[] = [];
  private ghosts: Group[] = [];
  private readonly trail = new DrapedLine();
  private readonly arrowGeo: ShapeGeometry;
  private readonly box = new BoxGeometry(1, 1, 1);

  constructor(private readonly terrain: Terrain) {
    const tri = new Shape();
    tri.moveTo(2.2, 0);
    tri.lineTo(-1.2, 1.8);
    tri.lineTo(-0.4, 0);
    tri.lineTo(-1.2, -1.8);
    tri.closePath();
    this.arrowGeo = new ShapeGeometry(tri);
    this.arrowGeo.rotateX(-Math.PI / 2);
    this.trail.line.visible = false;
    this.root.add(this.trail.line);
  }

  private line(i: number): DrapedLine {
    while (this.lines.length <= i) {
      const l = new DrapedLine();
      this.lines.push(l);
      this.root.add(l.line);
    }
    return this.lines[i];
  }

  private arrow(i: number, color: string): Mesh {
    while (this.arrows.length <= i) {
      const m = new Mesh(this.arrowGeo, new MeshBasicMaterial({ color: '#ffffff', side: DoubleSide, transparent: true, opacity: 0.95, depthTest: false }));
      m.renderOrder = 6;
      this.arrows.push(m);
      this.root.add(m);
    }
    (this.arrows[i].material as MeshBasicMaterial).color.set(color);
    return this.arrows[i];
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
    let li = 0, ai = 0, gi = 0;
    for (const it of items) {
      if (it.now.length >= 2) this.line(li++).set(this.terrain, it.now, it.color, 0.95);
      if (it.later.length >= 2) this.line(li++).set(this.terrain, it.later, it.color, 0.3);
      if (it.arrow && it.now.length >= 2) {
        const n = it.now.length;
        const a = it.now[n - 2], b = it.now[n - 1];
        const m = this.arrow(ai++, it.color);
        m.position.set(b.x, this.terrain.height(b.x, b.z) + LIFT, b.z);
        m.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
        m.scale.setScalar(1.6);
        m.visible = true;
      }
      if (it.ghost) {
        const g = this.ghost(gi++, it.color);
        g.position.set(it.ghost.x, this.terrain.height(it.ghost.x, it.ghost.z) + 1, it.ghost.z);
        g.rotation.y = -it.ghost.facing;
        g.scale.set(it.ghost.depth, 2, it.ghost.frontage);
        g.visible = true;
      }
    }
    for (let i = li; i < this.lines.length; i++) this.lines[i].line.visible = false;
    for (let i = ai; i < this.arrows.length; i++) this.arrows[i].visible = false;
    for (let i = gi; i < this.ghosts.length; i++) this.ghosts[i].visible = false;
  }

  setTrail(points: XZ[] | null) {
    if (!points || points.length < 2) {
      this.trail.line.visible = false;
      return;
    }
    this.trail.set(this.terrain, points.length > 200 ? points.filter((_, i) => i % Math.ceil(points.length / 200) === 0) : points, '#ffffff', 0.9);
  }
}
