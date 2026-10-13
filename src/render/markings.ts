// Battlefield markings: objectives (flag, capture circle, progress), the deployment zone, the selected
// unit's range fan (red Close / yellow Effective / white Max, wiki "Indicators") and its organization
// radius (tinted by side, inverted and widened after breaking).
import {
  BufferAttribute, BufferGeometry, Color, DoubleSide, Group, Line, LineBasicMaterial, LineLoop, Mesh,
  MeshBasicMaterial, MeshLambertMaterial, PlaneGeometry, BoxGeometry,
} from 'three';
import type { Battle, Objective } from '../sim/battle';
import { maxRange } from '../sim/combat';
import type { Unit } from '../sim/unit';

const LIFT = 0.6;

function drapedRing(terrain: Battle['terrain'], x: number, z: number, r: number, from = 0, to = Math.PI * 2, n = 64): Float32Array {
  const pos = new Float32Array((n + 1) * 3);
  for (let i = 0; i <= n; i++) {
    const a = from + ((to - from) * i) / n;
    const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
    pos.set([px, terrain.height(px, pz) + LIFT, pz], i * 3);
  }
  return pos;
}

interface ObjectiveView {
  ring: LineLoop;
  progress: Line;
  flag: Mesh;
  pole: Mesh;
}

export class Markings {
  readonly root = new Group();
  private objViews = new Map<number, ObjectiveView>();
  private zone: Line;
  private fan: Mesh[] = [];
  private orgRing: LineLoop;

  constructor(private readonly battle: Battle) {
    this.zone = new Line(new BufferGeometry(), new LineBasicMaterial({ color: '#fff0b8', transparent: true, opacity: 0.8, depthTest: false }));
    this.zone.renderOrder = 4;
    this.root.add(this.zone);
    for (let i = 0; i < 3; i++) {
      const m = new Mesh(new BufferGeometry(), new MeshBasicMaterial({ color: ['#e0503a', '#e8c040', '#ffffff'][i], transparent: true, opacity: 0.16, side: DoubleSide, depthWrite: false }));
      m.renderOrder = 3;
      this.fan.push(m);
      this.root.add(m);
    }
    this.orgRing = new LineLoop(new BufferGeometry(), new LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.5, depthTest: false }));
    this.orgRing.renderOrder = 4;
    this.root.add(this.orgRing);
  }

  private objectiveView(o: Objective): ObjectiveView {
    let v = this.objViews.get(o.id);
    if (v) return v;
    const t = this.battle.terrain;
    const R = this.battle.rules.captureRadius;
    const ringGeo = new BufferGeometry();
    ringGeo.setAttribute('position', new BufferAttribute(drapedRing(t, o.x, o.z, R), 3));
    const ring = new LineLoop(ringGeo, new LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.7, depthTest: false }));
    const progress = new Line(new BufferGeometry(), new LineBasicMaterial({ color: '#ffffff', depthTest: false }));
    ring.renderOrder = progress.renderOrder = 4;
    const h = t.height(o.x, o.z);
    const size = o.size === 'big' ? 1.4 : 1;
    const pole = new Mesh(new BoxGeometry(0.25, 12 * size, 0.25), new MeshLambertMaterial({ color: '#3a2e1d' }));
    pole.position.set(o.x, h + 6 * size, o.z);
    const flag = new Mesh(new PlaneGeometry(6 * size, 3.6 * size), new MeshLambertMaterial({ color: '#cccccc', side: DoubleSide }));
    flag.position.set(o.x + 3 * size, h + 10 * size, o.z);
    this.root.add(ring, progress, pole, flag);
    v = { ring, progress, flag, pole };
    this.objViews.set(o.id, v);
    return v;
  }

  update(selected: Unit[], time: number) {
    const b = this.battle;
    for (const o of b.objectives) {
      const v = this.objectiveView(o);
      const color = o.owner ? b.sides.get(o.owner)!.color : '#9a968c';
      (v.flag.material as MeshLambertMaterial).color.set(color);
      v.flag.rotation.y = Math.sin(time * 1.3 + o.id) * 0.25;
      ((v.ring.material as LineBasicMaterial).color as Color).set(color);
      if (o.capturer && o.progress > 0) {
        const frac = Math.min(1, o.progress / b.rules.capturePoints);
        v.progress.geometry.setAttribute('position', new BufferAttribute(drapedRing(b.terrain, o.x, o.z, b.rules.captureRadius - 2, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2, 48), 3));
        (v.progress.material as LineBasicMaterial).color.set(b.sides.get(o.capturer)!.color);
        v.progress.visible = true;
      } else v.progress.visible = false;
    }

    // Deployment zone outline.
    if (b.phase === 'deployment') {
      const [x0, z0, x1, z1] = b.sides.get(b.player)!.zone;
      const pts: number[] = [];
      const corners: [number, number][] = [[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]];
      for (let i = 0; i < 4; i++) {
        const [ax, az] = corners[i], [bx, bz] = corners[i + 1];
        for (let k = 0; k <= 20; k++) {
          const x = ax + ((bx - ax) * k) / 20, z = az + ((bz - az) * k) / 20;
          pts.push(x, b.terrain.height(x, z) + LIFT, z);
        }
      }
      this.zone.geometry.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3));
      this.zone.visible = true;
    } else this.zone.visible = false;

    // Range fan and org radius for a single selected unit.
    const u = selected.length === 1 ? selected[0] : null;
    for (const m of this.fan) m.visible = false;
    this.orgRing.visible = false;
    if (!u || !u.alive) return;
    const panic = u.routing && u.startedRouting > 0;
    const r = u.type.orgRadius * (panic ? 1.5 : 1);
    this.orgRing.geometry.setAttribute('position', new BufferAttribute(drapedRing(b.terrain, u.x, u.z, r), 3));
    (this.orgRing.material as LineBasicMaterial).color.set(panic ? '#ff4040' : b.sides.get(u.side)!.color);
    this.orgRing.visible = true;
    const ranged = u.type.ranged;
    if (!ranged || u.routing) return;
    const f = b.forms[u.shapeFormation];
    const arc = f.fire === 'front' ? (f.arc * Math.PI) / 180 : Math.PI * 2;
    const bands = [ranged.weapon.close, ranged.weapon.effective, maxRange(ranged.weapon)];
    const allowed = u.autofire === 'close' ? 0 : u.autofire === 'effective' ? 1 : 2;
    let inner = 0;
    bands.forEach((outer, i) => {
      const m = this.fan[i];
      const n = 24;
      const pos: number[] = [];
      for (let k = 0; k < n; k++) {
        const a0 = u.facing - arc / 2 + (arc * k) / n, a1 = u.facing - arc / 2 + (arc * (k + 1)) / n;
        const quad = [[inner, a0], [outer, a0], [outer, a1], [inner, a0], [outer, a1], [inner, a1]];
        for (const [rr, a] of quad) {
          const x = u.x + Math.cos(a) * rr, z = u.z + Math.sin(a) * rr;
          pos.push(x, b.terrain.height(x, z) + LIFT * 0.5, z);
        }
      }
      m.geometry.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
      (m.material as MeshBasicMaterial).opacity = i <= allowed ? 0.18 : 0.05;
      m.visible = true;
      inner = outer;
    });
  }
}
