// Campaign map props drawn in a handful of draw calls: every town's houses, roofs, plinths and flags
// are merged into one mesh per material (towns still grow with zoom: a vertex-shader scale about each
// town's centre), and army standards are instanced, one slot per army.
import {
  BoxGeometry, BufferAttribute, BufferGeometry, Color, ConeGeometry, CylinderGeometry, Group, InstancedBufferAttribute,
  InstancedMesh, Mesh, MeshBasicMaterial, MeshLambertMaterial, TorusGeometry, type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Rng } from '../sim/rng';

// ---------------------------------------------------------------- towns

const houseGeo = new BoxGeometry(1, 1, 1);
const roofGeo = new ConeGeometry(0.75, 0.7, 4);

/** Lambert material whose vertices scale about their town's centre (attribute aCenter). */
function townMaterial(params: ConstructorParameters<typeof MeshLambertMaterial>[0], scale: { value: number }): MeshLambertMaterial {
  const m = new MeshLambertMaterial(params);
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTownScale = scale;
    sh.vertexShader = 'attribute vec3 aCenter;\nuniform float uTownScale;\n' + sh.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\ntransformed = aCenter + (transformed - aCenter) * uTownScale;',
    );
  };
  m.customProgramCacheKey = () => 'town-scale';
  return m;
}

export interface TownSpec {
  id: string;
  x: number;
  y: number;
  z: number;
  capital: boolean;
}

export class TownSet {
  readonly root = new Group();
  private readonly scale = { value: 1 };
  private readonly flagColors: BufferAttribute;
  /** Vertex range of each town's flag in the merged flag mesh. */
  private readonly flagRange = new Map<string, [number, number]>();

  constructor(towns: TownSpec[]) {
    const wall = townMaterial({ color: '#e6d8b8', flatShading: true }, this.scale);
    const roof = townMaterial({ color: '#a5532e', flatShading: true }, this.scale);
    const plinth = townMaterial({ color: '#b39f74', flatShading: true }, this.scale);
    const pole = townMaterial({ color: '#4a3b28' }, this.scale);
    const flag = townMaterial({ color: '#ffffff', vertexColors: true }, this.scale);
    const buckets = new Map<Material, BufferGeometry[]>([[wall, []], [roof, []], [plinth, []], [pole, []], [flag, []]]);
    let flagVerts = 0;
    for (const t of towns) {
      const g = buildTown(t.capital, t.id, wall, roof, plinth, pole, flag);
      g.position.set(t.x, t.y, t.z);
      g.updateMatrixWorld(true);
      g.traverse((o) => {
        const m = o as Mesh;
        if (!m.isMesh) return;
        const geo = m.geometry.clone().applyMatrix4(m.matrixWorld);
        const n = geo.getAttribute('position').count;
        const centre = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) centre.set([t.x, t.y, t.z], i * 3);
        geo.setAttribute('aCenter', new BufferAttribute(centre, 3));
        if (m.material === flag) {
          geo.setAttribute('color', new BufferAttribute(new Float32Array(n * 3).fill(1), 3));
          this.flagRange.set(t.id, [flagVerts, n]);
          flagVerts += n;
        }
        buckets.get(m.material as Material)!.push(geo);
      });
    }
    for (const [mat, geos] of buckets) {
      const merged = mergeGeometries(geos);
      const mesh = new Mesh(merged, mat);
      mesh.frustumCulled = false;
      this.root.add(mesh);
      if (mat === flag) this.flagColors = merged.getAttribute('color') as BufferAttribute;
      for (const g of geos) g.dispose();
    }
    this.flagColors ??= new BufferAttribute(new Float32Array(3), 3);
  }

  setScale(s: number) {
    this.scale.value = s;
  }

  setFlag(id: string, color: Color) {
    const r = this.flagRange.get(id);
    if (!r) return;
    const a = this.flagColors.array as Float32Array;
    for (let i = r[0]; i < r[0] + r[1]; i++) {
      a[i * 3] = color.r;
      a[i * 3 + 1] = color.g;
      a[i * 3 + 2] = color.b;
    }
    this.flagColors.needsUpdate = true;
  }
}

function buildTown(capital: boolean, id: string, wall: Material, roof: Material, plinth: Material, pole: Material, flag: Material): Group {
  const g = new Group();
  const rng = new Rng([...id].reduce((h, ch) => h * 31 + ch.charCodeAt(0), 7));
  const r = capital ? 12 : 9;
  const base = new Mesh(new CylinderGeometry(r, r + 1.5, 1.6, 12), plinth);
  base.position.y = 0.4;
  g.add(base);
  const houses = capital ? 9 : 5;
  for (let i = 0; i < houses; i++) {
    const a = (i / houses) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const d = rng.range(2.5, r - 3);
    const w = rng.range(2.2, 3.6), h = rng.range(1.8, 3.2);
    const house = new Mesh(houseGeo, wall);
    house.scale.set(w, h, w * rng.range(0.8, 1.2));
    house.position.set(Math.cos(a) * d, 1.2 + h / 2, Math.sin(a) * d);
    house.rotation.y = rng.range(0, Math.PI);
    g.add(house);
    const top = new Mesh(roofGeo, roof);
    top.scale.set(w * 1.05, 2.2, w * 1.05);
    top.position.set(house.position.x, 1.2 + h + 0.75, house.position.z);
    top.rotation.y = house.rotation.y + Math.PI / 4;
    g.add(top);
  }
  // A temple spire in the middle of every town; a taller one in a capital.
  const spire = new Mesh(new ConeGeometry(capital ? 3.2 : 2.2, capital ? 13 : 8, 6), wall);
  spire.position.y = 1.2 + (capital ? 6.5 : 4);
  g.add(spire);
  const staff = new Mesh(new CylinderGeometry(0.3, 0.3, 18, 5), pole);
  staff.position.set(r - 2, 9, 0);
  g.add(staff);
  const cloth = new Mesh(new BoxGeometry(7, 4.5, 0.3), flag);
  cloth.position.set(r - 2 + 3.6, 15.5, 0);
  g.add(cloth);
  return g;
}

// ---------------------------------------------------------------- army standards

class Slotted {
  readonly mesh: InstancedMesh;
  constructor(geo: BufferGeometry, mat: Material, cap: number, colors: boolean) {
    this.mesh = new InstancedMesh(geo, mat, cap);
    this.mesh.frustumCulled = false;
    (this.mesh.instanceMatrix.array as Float32Array).fill(0);
    if (colors) this.mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(cap * 3), 3);
  }
  /** Uniform scale `s` at (x, y, z), or hidden when s is 0. */
  set(i: number, x: number, y: number, z: number, s: number) {
    const a = this.mesh.instanceMatrix.array as Float32Array, o = i * 16;
    a.fill(0, o, o + 16);
    a[o] = a[o + 5] = a[o + 10] = s;
    a[o + 12] = x;
    a[o + 13] = y;
    a[o + 14] = z;
    a[o + 15] = 1;
  }
  color(i: number, c: Color, k: number) {
    const a = this.mesh.instanceColor!.array as Float32Array;
    a[i * 3] = c.r * k;
    a[i * 3 + 1] = c.g * k;
    a[i * 3 + 2] = c.b * k;
  }
  flush() {
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

function at(geo: BufferGeometry, x: number, y: number, z: number): BufferGeometry {
  geo.translate(x, y, z);
  return geo;
}

export class Standards {
  readonly root = new Group();
  private cap = 0;
  private base!: Slotted;
  private troops!: Slotted;
  private pole!: Slotted;
  private banner!: Slotted;
  private trim!: Slotted;
  private ring!: Slotted;
  private all: Slotted[] = [];
  private readonly mats = {
    base: new MeshLambertMaterial({ color: '#ffffff', flatShading: true }),
    troops: new MeshLambertMaterial({ color: '#ffffff', flatShading: true }),
    pole: new MeshLambertMaterial({ color: '#4a3b28' }),
    banner: new MeshLambertMaterial({ color: '#ffffff' }),
    trim: new MeshLambertMaterial({ color: '#f6efdc' }),
    ring: new MeshBasicMaterial({ color: '#f2c96b' }),
  };
  private readonly geos = {
    base: at(new CylinderGeometry(6, 7, 2, 10), 0, 1, 0),
    troops: at(new BoxGeometry(8, 3.6, 4), 0, 3.8, 0),
    pole: at(new CylinderGeometry(0.35, 0.35, 20, 5), -3, 12, 0),
    banner: at(new BoxGeometry(8, 5.5, 0.4), 1.2, 18.6, 0),
    trim: at(new BoxGeometry(8, 0.8, 0.5), 1.2, 15.9, 0),
    ring: at(new TorusGeometry(10, 0.9, 6, 30).rotateX(-Math.PI / 2), 0, 0.6, 0),
  };
  /** Slots used last frame (hidden again if no longer used). */
  private used = 0;

  constructor() {
    this.grow(32);
  }

  private grow(cap: number) {
    for (const s of this.all) this.root.remove(s.mesh);
    for (const s of this.all) s.mesh.dispose();
    this.cap = cap;
    this.base = new Slotted(this.geos.base, this.mats.base, cap, true);
    this.troops = new Slotted(this.geos.troops, this.mats.troops, cap, true);
    this.pole = new Slotted(this.geos.pole, this.mats.pole, cap, false);
    this.banner = new Slotted(this.geos.banner, this.mats.banner, cap, true);
    this.trim = new Slotted(this.geos.trim, this.mats.trim, cap, false);
    this.ring = new Slotted(this.geos.ring, this.mats.ring, cap, false);
    this.all = [this.base, this.troops, this.pole, this.banner, this.trim, this.ring];
    for (const s of this.all) this.root.add(s.mesh);
    this.used = 0;
  }

  /** Lay out standards for this frame: call begin(n), then set() for slots 0..n-1, then end(). */
  begin(n: number) {
    if (n > this.cap) this.grow(Math.max(n, this.cap * 2));
  }

  set(i: number, x: number, y: number, z: number, scale: number, color: Color, bob: number, ring: number) {
    this.base.set(i, x, y, z, scale);
    this.base.color(i, color, 0.75);
    const sy = y + bob * scale;
    this.troops.set(i, x, sy, z, scale);
    this.troops.color(i, color, 0.5);
    this.pole.set(i, x, sy, z, scale);
    this.banner.set(i, x, sy, z, scale);
    this.banner.color(i, color, 1);
    this.trim.set(i, x, sy, z, scale);
    this.ring.set(i, x, y, z, ring);
  }

  end(n: number) {
    for (let i = n; i < this.used; i++) for (const s of this.all) s.set(i, 0, 0, 0, 0);
    this.used = n;
    for (const s of this.all) s.flush();
  }
}
