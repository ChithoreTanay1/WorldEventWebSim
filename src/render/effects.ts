// Missile volleys: a pooled InstancedMesh of arrows flying on a ballistic arc. Purely visual; the
// simulation has already resolved the hits.
import { BoxGeometry, InstancedMesh, Matrix4, MeshBasicMaterial, Quaternion, Vector3 } from 'three';
import type { Terrain } from '../sim/terrain';
import type { Volley } from '../sim/types';

const CAP = 900;

interface Arrow {
  ax: number; az: number; ay: number;
  bx: number; bz: number; by: number;
  arc: number;
  t: number;
  dur: number;
}

const X = new Vector3(1, 0, 0);
const dir = new Vector3();
const q = new Quaternion();
const m = new Matrix4();
const one = new Vector3(1, 1, 1);
const p = new Vector3();

export class Effects {
  readonly mesh: InstancedMesh;
  private arrows: Arrow[] = [];

  constructor(private readonly terrain: Terrain) {
    this.mesh = new InstancedMesh(new BoxGeometry(1.5, 0.07, 0.07), new MeshBasicMaterial({ color: '#2a2218' }), CAP);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }

  spawn(v: Volley) {
    const dist = Math.hypot(v.toX - v.fromX, v.toZ - v.fromZ);
    for (let i = 0; i < v.count && this.arrows.length < CAP; i++) {
      const ax = v.fromX + (Math.random() - 0.5) * 18, az = v.fromZ + (Math.random() - 0.5) * 18;
      const bx = v.toX + (Math.random() - 0.5) * 22, bz = v.toZ + (Math.random() - 0.5) * 22;
      this.arrows.push({
        ax, az, ay: this.terrain.height(ax, az) + 2,
        bx, bz, by: this.terrain.height(bx, bz) + 0.5,
        arc: dist * 0.2 + 4,
        t: -Math.random() * 0.35,
        dur: 0.7 + dist / 90,
      });
    }
  }

  update(dt: number) {
    let n = 0;
    this.arrows = this.arrows.filter((a) => (a.t += dt) < a.dur);
    for (const a of this.arrows) {
      if (a.t < 0) continue;
      const t = a.t / a.dur;
      const x = a.ax + (a.bx - a.ax) * t;
      const z = a.az + (a.bz - a.az) * t;
      const y = a.ay + (a.by - a.ay) * t + a.arc * 4 * t * (1 - t);
      const dy = (a.by - a.ay) + a.arc * 4 * (1 - 2 * t);
      dir.set(a.bx - a.ax, dy, a.bz - a.az).normalize();
      q.setFromUnitVectors(X, dir);
      m.compose(p.set(x, y, z), q, one);
      this.mesh.setMatrixAt(n++, m);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
