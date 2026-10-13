// Order visuals draped over the terrain: one order line per unit from its position to its slot,
// an arrow at the slot showing facing, ghost blocks while dragging, and the raw drag trail.
import {
  BoxGeometry, BufferAttribute, BufferGeometry, DoubleSide, EdgesGeometry, Group, Line, LineBasicMaterial,
  LineSegments, Mesh, MeshBasicMaterial, Shape, ShapeGeometry,
} from 'three';
import type { Terrain } from '../sim/terrain';

const SAMPLES = 28;
const LIFT = 0.7;

class DrapedLine {
  readonly line: Line;
  private readonly pos: Float32Array;
  constructor(color: string, opacity: number) {
    this.pos = new Float32Array(SAMPLES * 3);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(this.pos, 3));
    this.line = new Line(geo, new LineBasicMaterial({ color, transparent: true, opacity, depthTest: false }));
    this.line.renderOrder = 5;
    this.line.frustumCulled = false;
  }
  set(terrain: Terrain, ax: number, az: number, bx: number, bz: number) {
    for (let i = 0; i < SAMPLES; i++) {
      const t = i / (SAMPLES - 1);
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      this.pos.set([x, terrain.height(x, z) + LIFT, z], i * 3);
    }
    (this.line.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    this.line.visible = true;
  }
}

export interface OrderVisual {
  fromX: number;
  fromZ: number;
  toX: number;
  toZ: number;
  facing: number | null;
  frontage: number;
  depth: number;
  kind: 'move' | 'attack' | 'preview';
}

export class OrderOverlay {
  readonly root = new Group();
  private lines: DrapedLine[] = [];
  private arrows: Mesh[] = [];
  private ghosts: Group[] = [];
  private trail: Line;
  private trailPos: Float32Array;
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
    this.trailPos = new Float32Array(512 * 3);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(this.trailPos, 3));
    this.trail = new Line(g, new LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, depthTest: false }));
    this.trail.renderOrder = 6;
    this.trail.frustumCulled = false;
    this.trail.visible = false;
    this.root.add(this.trail);
  }

  private line(i: number, color: string): DrapedLine {
    while (this.lines.length <= i) {
      const l = new DrapedLine('#ffffff', 0.9);
      this.lines.push(l);
      this.root.add(l.line);
    }
    (this.lines[i].line.material as LineBasicMaterial).color.set(color);
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

  private ghost(i: number): Group {
    while (this.ghosts.length <= i) {
      const g = new Group();
      const body = new Mesh(this.box, new MeshBasicMaterial({ color: '#fff0b8', transparent: true, opacity: 0.18, depthWrite: false }));
      const edges = new LineSegments(new EdgesGeometry(this.box), new LineBasicMaterial({ color: '#fff0b8', transparent: true, opacity: 0.8 }));
      g.add(body, edges);
      this.ghosts.push(g);
      this.root.add(g);
    }
    return this.ghosts[i];
  }

  /** Replace everything shown with these order visuals. */
  show(items: OrderVisual[]) {
    let li = 0, ai = 0, gi = 0;
    for (const it of items) {
      const color = it.kind === 'attack' ? '#ff6b52' : it.kind === 'preview' ? '#ffe9a0' : '#d9f0ff';
      this.line(li++, color).set(this.terrain, it.fromX, it.fromZ, it.toX, it.toZ);
      if (it.facing !== null) {
        const a = this.arrow(ai++, color);
        const s = Math.max(1.3, Math.min(3.5, it.frontage / 12));
        a.scale.setScalar(s);
        a.rotation.y = -it.facing;
        // Arrow sits just in front of the slot, pointing the way the unit will face.
        const ax = it.toX + Math.cos(it.facing) * (it.depth / 2 + 3);
        const az = it.toZ + Math.sin(it.facing) * (it.depth / 2 + 3);
        a.position.set(ax, this.terrain.height(ax, az) + LIFT, az);
        a.visible = true;
      }
      if (it.kind === 'preview' && it.facing !== null) {
        const g = this.ghost(gi++);
        g.position.set(it.toX, this.terrain.height(it.toX, it.toZ) + 1, it.toZ);
        g.rotation.y = -it.facing;
        g.scale.set(it.depth, 2, it.frontage);
        g.visible = true;
      }
    }
    for (let i = li; i < this.lines.length; i++) this.lines[i].line.visible = false;
    for (let i = ai; i < this.arrows.length; i++) this.arrows[i].visible = false;
    for (let i = gi; i < this.ghosts.length; i++) this.ghosts[i].visible = false;
  }

  setTrail(points: { x: number; z: number }[] | null) {
    if (!points || points.length < 2) {
      this.trail.visible = false;
      return;
    }
    const n = Math.min(points.length, 512);
    const step = points.length / n;
    for (let i = 0; i < n; i++) {
      const p = points[Math.floor(i * step)];
      this.trailPos.set([p.x, this.terrain.height(p.x, p.z) + LIFT + 0.1, p.z], i * 3);
    }
    this.trail.geometry.setDrawRange(0, n);
    (this.trail.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    this.trail.visible = true;
  }
}
