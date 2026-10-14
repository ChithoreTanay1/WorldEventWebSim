// Campaign map renderer: low-poly relief of North India tinted by who holds each town, roads, towns,
// army standards and the planned march of the selected army. Same flat-shaded style as the battles.
import { createRenderer, gpuTimer } from '../render/renderer';
import {
  BufferAttribute, BufferGeometry, Color, ConeGeometry, DirectionalLight, Fog, Group,
  HemisphereLight, Mesh, MeshBasicMaterial, MeshLambertMaterial, PerspectiveCamera, PlaneGeometry, Scene, TorusGeometry,
  Vector3, WebGLRenderer,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Rng } from '../sim/rng';
import { Standards, TownSet } from './mapProps';
import { perf } from '../perf';
import type { Campaign } from './campaign';
import { GEO_CELL, MAP_WATER, type MapGeo, type XZ } from './geo';

const SKY = '#b7c3c4';
const MIN_DIST = 70;
const MAX_DIST = 1500;

/** Orbit camera fixed to face north; tilts lower as it zooms in, like a strategy map. */
export class MapCamera {
  readonly camera = new PerspectiveCamera(40, 1, 2, 9000);
  target = { x: 0, z: 0 };
  distance = 700;
  private s = { x: 0, z: 0, d: 700 };
  private tween: { from: { x: number; z: number; d: number }; to: { x: number; z: number; d: number }; t: number; dur: number; done: () => void } | null = null;

  constructor(private readonly geo: MapGeo) {}

  static pitchFor(d: number): number {
    const t = Math.max(0, Math.min(1, (d - MIN_DIST) / (900 - MIN_DIST)));
    return ((40 + 28 * t) * Math.PI) / 180;
  }

  set(x: number, z: number, d: number) {
    this.target = { x, z };
    this.distance = d;
    this.s = { x, z, d };
    this.tween = null;
  }

  pan(dx: number, dz: number) {
    if (this.tween) return;
    this.target.x = Math.max(0, Math.min(this.geo.width, this.target.x + dx));
    this.target.z = Math.max(0, Math.min(this.geo.depth, this.target.z + dz));
  }

  zoom(factor: number, toward?: XZ) {
    if (this.tween) return;
    const nd = Math.max(MIN_DIST, Math.min(MAX_DIST, this.distance * factor));
    if (toward) {
      // Keep the point under the cursor roughly fixed while zooming.
      const k = 1 - nd / this.distance;
      this.pan((toward.x - this.target.x) * k, (toward.z - this.target.z) * k);
    }
    this.distance = nd;
  }

  /** Eased flight to a view; resolves when it arrives. Used for the zoom into and out of battles. */
  flyTo(x: number, z: number, d: number, dur: number): Promise<void> {
    return new Promise((done) => {
      this.tween?.done();
      this.tween = { from: { ...this.s }, to: { x, z, d }, t: 0, dur, done };
    });
  }

  get zoomDistance(): number {
    return this.s.d;
  }

  get focus(): XZ {
    return { x: this.s.x, z: this.s.z };
  }

  update(dt: number) {
    if (this.tween) {
      const tw = this.tween;
      tw.t = Math.min(1, tw.t + dt / tw.dur);
      const e = tw.t < 0.5 ? 4 * tw.t ** 3 : 1 - (-2 * tw.t + 2) ** 3 / 2;
      // Zoom in log space so the descent feels even all the way down.
      this.s.d = Math.exp(Math.log(tw.from.d) + (Math.log(tw.to.d) - Math.log(tw.from.d)) * e);
      this.s.x = tw.from.x + (tw.to.x - tw.from.x) * e;
      this.s.z = tw.from.z + (tw.to.z - tw.from.z) * e;
      if (tw.t >= 1) {
        this.target = { x: tw.to.x, z: tw.to.z };
        this.distance = tw.to.d;
        this.tween = null;
        tw.done();
      }
    } else {
      const k = 1 - Math.exp(-dt * 10);
      this.s.x += (this.target.x - this.s.x) * k;
      this.s.z += (this.target.z - this.s.z) * k;
      this.s.d += (this.distance - this.s.d) * k;
    }
    const pitch = MapCamera.pitchFor(this.s.d);
    const ground = Math.max(MAP_WATER, this.geo.height(this.s.x, this.s.z));
    this.camera.position.set(this.s.x, ground + Math.sin(pitch) * this.s.d, this.s.z + Math.cos(pitch) * this.s.d);
    this.camera.lookAt(this.s.x, ground, this.s.z);
  }
}


export class MapView {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly cam: MapCamera;
  private readonly terrainColors: BufferAttribute;
  private readonly baseColors: Float32Array;
  /** Per terrain vertex: nearest and second-nearest settlement index and their distance gap. */
  private readonly nearest: Int16Array;
  private readonly second: Int16Array;
  private readonly gap: Float32Array;
  private readonly nearDist: Float32Array;
  /** Terrain vertex heights (realm colour stays off high mountains and water). */
  private readonly vertexY: Float32Array;
  /** Centre of each realm's land (political-view names sit here), updated with ownership. */
  readonly realmCentre = new Map<string, { x: number; z: number; cells: number }>();
  private readonly settlementIds: string[];
  private readonly towns: TownSet;
  private readonly townPos = new Map<string, Vector3>();
  private readonly standards = new Standards();
  /** Where each army's standard was drawn this frame (reused objects; read by labels and picking). */
  private readonly tokens = new Map<number, Vector3>();
  private readonly fanout = new Map<number, number>();
  private readonly armyColors = new Map<string, Color>();
  private townScale = 1;
  /** Canvas rectangle, read once per resize instead of on every projection (avoids layout thrash). */
  private rect: DOMRect;
  private readonly routeGroup = new Group();
  private readonly v = new Vector3();
  private routeKey = '';
  selected: number | null = null;
  selectedTown: string | null = null;
  /** Political view (Tab): every province filled with its owner's colour, strong borders. */
  political = false;
  hovered: number | null = null;
  private readonly townRing = new Mesh(new TorusGeometry(17, 1, 6, 36), new MeshBasicMaterial({ color: '#f2c96b' }));

  constructor(readonly canvas: HTMLCanvasElement, private readonly c: Campaign) {
    const geo = c.geo;
    this.renderer = createRenderer(canvas);
    this.scene.background = new Color(SKY);
    this.scene.fog = new Fog(SKY, 1800, 4200);
    this.scene.add(new HemisphereLight('#e8eef2', '#6a5b3c', 1.15));
    const sun = new DirectionalLight('#fff0d6', 1.6);
    sun.position.set(-400, 700, 300);
    this.scene.add(sun);
    this.cam = new MapCamera(geo);
    this.settlementIds = c.data.settlements.map((s) => s.id);

    // ---- terrain
    const nx = geo.nx, nz = geo.nz, n = (nx + 1) * (nz + 1);
    const pos = new Float32Array(n * 3);
    this.baseColors = new Float32Array(n * 3);
    this.nearest = new Int16Array(n);
    this.second = new Int16Array(n);
    this.gap = new Float32Array(n);
    this.nearDist = new Float32Array(n);
    this.vertexY = new Float32Array(n);
    const col = new Color();
    const sp = this.settlementIds.map((id) => c.pos[id]);
    for (let iz = 0, i = 0; iz <= nz; iz++) {
      for (let ix = 0; ix <= nx; ix++, i++) {
        const x = ix * GEO_CELL, z = iz * GEO_CELL, h = geo.gridHeight(ix, iz);
        pos.set([x, h, z], i * 3);
        this.vertexY[i] = h;
        baseColor(geo, x, z, h, col);
        this.baseColors.set([col.r, col.g, col.b], i * 3);
        let b1 = -1, b2 = -1, d1 = Infinity, d2 = Infinity;
        sp.forEach((p, k) => {
          const d = Math.hypot(p.x - x, p.z - z);
          if (d < d1) (d2 = d1), (b2 = b1), (d1 = d), (b1 = k);
          else if (d < d2) (d2 = d), (b2 = k);
        });
        this.nearest[i] = b1;
        this.second[i] = b2;
        this.gap[i] = d2 - d1;
        this.nearDist[i] = d1;
      }
    }
    const idx: number[] = [];
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const a = iz * (nx + 1) + ix, b = a + 1, d = a + nx + 1, e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
    }
    const tg = new BufferGeometry();
    tg.setAttribute('position', new BufferAttribute(pos, 3));
    this.terrainColors = new BufferAttribute(new Float32Array(n * 3), 3);
    tg.setAttribute('color', this.terrainColors);
    tg.setIndex(idx);
    tg.computeVertexNormals();
    this.scene.add(new Mesh(tg, new MeshLambertMaterial({ vertexColors: true, flatShading: true })));
    const water = new Mesh(new PlaneGeometry(geo.width, geo.depth), new MeshLambertMaterial({ color: '#3f6f7d', transparent: true, opacity: 0.9 }));
    water.rotation.x = -Math.PI / 2;
    water.position.set(geo.width / 2, MAP_WATER, geo.depth / 2);
    this.scene.add(water);
    // Lands beyond the map: a dim plain, so the edge reads as the end of the known world, not a coast.
    const beyond = new Mesh(new PlaneGeometry(geo.width + 6000, geo.depth + 6000), new MeshLambertMaterial({ color: '#5c6244' }));
    beyond.rotation.x = -Math.PI / 2;
    beyond.position.set(geo.width / 2, MAP_WATER - 0.4, geo.depth / 2);
    this.scene.add(beyond);
    this.scene.add(this.buildRoads());
    this.scene.add(this.buildTrees());
    const capitals = new Set(Object.values(c.data.factions).map((f) => f.capital));
    this.towns = new TownSet(c.data.settlements.map((s) => {
      const p = c.pos[s.id];
      this.townPos.set(s.id, new Vector3(p.x, geo.height(p.x, p.z), p.z));
      return { id: s.id, x: p.x, y: geo.height(p.x, p.z), z: p.z, capital: capitals.has(s.id) };
    }));
    this.scene.add(this.towns.root);
    this.scene.add(this.standards.root);
    for (const [id, f] of Object.entries(c.data.factions)) this.armyColors.set(id, new Color(f.color));
    this.scene.add(this.routeGroup);
    this.townRing.rotation.x = -Math.PI / 2;
    this.townRing.visible = false;
    this.scene.add(this.townRing);
    this.rect = canvas.getBoundingClientRect();
    this.refreshOwners();
    this.resize();
    this.cam.set(geo.width / 2, geo.depth / 2, 900);
  }

  /** Every road in one mesh. */
  private buildRoads(): Mesh {
    const parts = this.c.data.roads.map(([a, b]) => ribbon(this.c.geo, [this.c.pos[a], this.c.pos[b]], 2.4, 0.35));
    const merged = mergeGeometries(parts);
    for (const g of parts) g.dispose();
    return new Mesh(merged, new MeshLambertMaterial({ color: '#b49a6a' }));
  }

  private buildTrees(): Mesh {
    const geo = this.c.geo;
    const rng = new Rng(9001);
    const spots: [number, number, number][] = [];
    for (let tries = 0; tries < 30000 && spots.length < 1400; tries++) {
      const x = rng.range(0, geo.width), z = rng.range(0, geo.depth);
      const h = geo.height(x, z);
      if (h < MAP_WATER + 0.6 || h > 24 || geo.desert(x, z) > 0.25) continue;
      const river = geo.riverDistance(x, z).d;
      // Groves along rivers and on the hills, scattered thin elsewhere.
      const p = river < 40 ? 0.55 : h > 5 ? 0.4 : 0.06;
      if (rng.next() > p) continue;
      if (Object.values(this.c.pos).some((s) => Math.hypot(s.x - x, s.z - z) < 16)) continue;
      spots.push([x, z, rng.range(0.8, 1.5)]);
    }
    const cone = new ConeGeometry(2.4, 7, 5);
    cone.translate(0, 3.5, 0);
    const parts: number[] = [];
    const v = new Vector3();
    const p = cone.toNonIndexed().getAttribute('position');
    for (const [x, z, s] of spots) {
      const y = geo.height(x, z);
      for (let k = 0; k < p.count; k++) {
        v.fromBufferAttribute(p, k);
        parts.push(x + v.x * s, y + v.y * s, z + v.z * s);
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(parts), 3));
    g.computeVertexNormals();
    return new Mesh(g, new MeshLambertMaterial({ color: '#5d7339', flatShading: true }));
  }

  setPolitical(on: boolean) {
    if (on === this.political) return;
    this.political = on;
    this.refreshOwners();
  }

  /** Re-tint territory and flags after towns change hands (plain number loop: 60k+ vertices). */
  refreshOwners() {
    // Normal view: a light wash near each town. Political view: solid colour over all the land.
    const pol = this.political;
    const strength = pol ? 0.62 : 0.24, reach = pol ? 1e9 : 260, full = pol ? 1e9 : 200;
    const owners = this.c.state.owners;
    // Owner colour and identity per settlement index, resolved once.
    const n = this.settlementIds.length;
    const rgb = new Float32Array(n * 3), who = new Int32Array(n).fill(-1);
    const factionIds = Object.keys(this.c.data.factions);
    const grey = new Color('#999999');
    this.settlementIds.forEach((id, k) => {
      const f = factionIds.indexOf(owners[id]);
      who[k] = f;
      const col = f >= 0 ? this.armyColors.get(owners[id])! : grey;
      rgb.set([col.r, col.g, col.b], k * 3);
      this.towns.setFlag(id, col);
    });
    const out = this.terrainColors.array as Float32Array, base = this.baseColors;
    const sx = new Float64Array(n), sz = new Float64Array(n), sc = new Float64Array(n);
    const nx = this.c.geo.nx + 1;
    for (let i = 0; i < this.nearest.length; i++) {
      let r = base[i * 3], g = base[i * 3 + 1], b = base[i * 3 + 2];
      const k1 = this.nearest[i], d = this.nearDist[i], y = this.vertexY[i];
      // Land a realm can hold: above water, below the high mountains.
      const land = y > MAP_WATER + 0.2 && y < 30;
      if (land && who[k1] >= 0) {
        sx[k1] += (i % nx) * GEO_CELL;
        sz[k1] += Math.floor(i / nx) * GEO_CELL;
        sc[k1]++;
      }
      if (d < reach && who[k1] >= 0) {
        let fade = d < full ? 1 : 1 - (d - full) / 60;
        if (pol) fade *= y < 14 ? 1 : y > 30 ? 0 : 1 - (y - 14) / 16;
        const t = strength * fade;
        r += (rgb[k1 * 3] - r) * t;
        g += (rgb[k1 * 3 + 1] - g) * t;
        b += (rgb[k1 * 3 + 2] - b) * t;
        // Province borders: a faint line between towns, a strong one between rivals.
        const gap = this.gap[i];
        if (gap < 4) {
          const m = who[k1] !== who[this.second[i]] ? (pol ? 0.35 : 0.55) + 0.1 * gap : 1 - 0.05 * fade;
          r *= m;
          g *= m;
          b *= m;
        }
      }
      out[i * 3] = r;
      out[i * 3 + 1] = g;
      out[i * 3 + 2] = b;
    }
    this.terrainColors.needsUpdate = true;
    // Realm centres from the land around their towns (cells nearest each town, summed per owner).
    this.realmCentre.clear();
    this.settlementIds.forEach((id, k) => {
      if (!sc[k]) return;
      const o = owners[id];
      const e = this.realmCentre.get(o) ?? { x: 0, z: 0, cells: 0 };
      e.x += sx[k];
      e.z += sz[k];
      e.cells += sc[k];
      this.realmCentre.set(o, e);
    });
    for (const e of this.realmCentre.values()) {
      e.x /= e.cells;
      e.z /= e.cells;
    }
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.cam.camera.aspect = w / h;
    this.cam.camera.updateProjectionMatrix();
    this.rect = this.canvas.getBoundingClientRect();
  }

  /** Token scale grows when zoomed out so armies stay readable. */
  get markerScale(): number {
    return Math.max(0.8, Math.min(2.4, this.cam.zoomDistance / 420));
  }

  frame(dt: number, time: number) {
    this.cam.update(dt);
    const s = this.markerScale;
    const armies = this.c.armies;
    // Several armies on one spot fan out a little so each stays clickable.
    this.fanout.clear();
    this.standards.begin(armies.length);
    for (const id of this.tokens.keys()) if (!this.c.army(id)) this.tokens.delete(id);
    for (let i = 0; i < armies.length; i++) {
      const a = armies[i];
      const p = this.c.armyPos(a);
      const key = Math.round(p.x / 8) * 100003 + Math.round(p.z / 8);
      const k = this.fanout.get(key) ?? 0;
      this.fanout.set(key, k + 1);
      const off = k * 9 * s;
      const x = p.x + off, z = p.z + off * 0.4;
      const y = Math.max(MAP_WATER, this.c.geo.height(x, z)) + 0.3;
      let t = this.tokens.get(a.id);
      if (!t) this.tokens.set(a.id, (t = new Vector3()));
      t.set(x, y, z);
      const scale = s * (this.hovered === a.id ? 1.12 : 1);
      // A marching standard bobs a little; the selected one has a pulsing ring.
      const bob = a.marching ? 0.6 * Math.abs(Math.sin(time * 6 + a.id)) : 0;
      const ring = this.selected === a.id ? scale * (1 + 0.08 * Math.sin(time * 5)) : 0;
      this.standards.set(i, x, y, z, scale, this.armyColors.get(a.faction)!, bob, ring);
    }
    this.standards.end(armies.length);
    const townScale = Math.max(1, Math.min(1.9, this.cam.zoomDistance / 520));
    if (townScale !== this.townScale) this.towns.setScale((this.townScale = townScale));
    const town = this.selectedTown ? this.townPos.get(this.selectedTown) : undefined;
    this.townRing.visible = !!town;
    if (town) {
      this.townRing.position.set(town.x, town.y + 1.4, town.z);
      this.townRing.scale.setScalar(townScale * (1 + 0.05 * Math.sin(time * 4)));
    }
    this.updateRoute();
    const t = performance.now();
    gpuTimer.begin(this.renderer);
    this.renderer.render(this.scene, this.cam.camera);
    gpuTimer.end();
    perf.add('render', performance.now() - t);
  }

  /** Where an army's standard is drawn (the fan-out offset included). */
  tokenPos(id: number): Vector3 | null {
    return this.tokens.get(id) ?? null;
  }

  private updateRoute() {
    const a = this.selected !== null ? this.c.army(this.selected) : undefined;
    const r = a && a.faction === this.c.player ? this.c.routePoints(a) : { points: [], reach: 0 };
    const key = r.points.map((p) => `${p.x.toFixed(1)},${p.z.toFixed(1)}`).join(';') + `|${r.reach}`;
    if (key === this.routeKey) return;
    this.routeKey = key;
    for (const m of this.routeGroup.children as Mesh[]) m.geometry.dispose();
    this.routeGroup.clear();
    if (r.points.length < 2) return;
    const [now, later] = splitAt(r.points, r.reach);
    if (now.length > 1) this.routeGroup.add(new Mesh(ribbon(this.c.geo, now, 3.2, 0.9), new MeshBasicMaterial({ color: '#f2c96b' })));
    if (later.length > 1) this.routeGroup.add(new Mesh(ribbon(this.c.geo, later, 2.4, 0.8), new MeshBasicMaterial({ color: '#f6efdc', transparent: true, opacity: 0.55 })));
    const end = r.points[r.points.length - 1];
    const ring = new Mesh(new TorusGeometry(13, 1.1, 6, 28), new MeshBasicMaterial({ color: '#f2c96b' }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(end.x, this.c.geo.height(end.x, end.z) + 1.2, end.z);
    this.routeGroup.add(ring);
  }

  /** Ground point under a pixel: intersect a level plane, then refine against the heightfield. */
  pickGround(clientX: number, clientY: number): XZ | null {
    const r = this.rect;
    const cam = this.cam.camera;
    const ndc = new Vector3(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1, 0.5).unproject(cam);
    const dir = ndc.sub(cam.position).normalize();
    if (dir.y >= -1e-3) return null;
    let y = 2, x = 0, z = 0;
    for (let k = 0; k < 4; k++) {
      const t = (y - cam.position.y) / dir.y;
      x = cam.position.x + dir.x * t;
      z = cam.position.z + dir.z * t;
      y = Math.max(MAP_WATER, this.c.geo.height(x, z));
    }
    return { x, z };
  }

  /** World point to client pixels. Writes into `out` (reused by per-frame callers) or a fresh object. */
  project(x: number, y: number, z: number, out = { x: 0, y: 0, visible: false }): { x: number; y: number; visible: boolean } {
    const r = this.rect;
    this.v.set(x, y, z).project(this.cam.camera);
    out.x = r.left + ((this.v.x + 1) / 2) * r.width;
    out.y = r.top + ((1 - this.v.y) / 2) * r.height;
    out.visible = this.v.z < 1 && Math.abs(this.v.x) < 1.1 && Math.abs(this.v.y) < 1.1;
    return out;
  }

  /** Remove tokens of armies that no longer exist and rebuild flags (after loading or a new campaign). */
  reset() {
    this.tokens.clear();
    this.routeKey = '';
    this.refreshOwners();
  }
}

function baseColor(geo: MapGeo, x: number, z: number, h: number, c: Color) {
  if (h < MAP_WATER + 0.15) return c.set('#55775f');
  const river = geo.riverDistance(x, z).d;
  const desert = geo.desert(x, z);
  c.set('#8a9a52');
  if (river < 30) c.lerp(new Color('#6b8a44'), 0.6 * (1 - river / 30));
  if (desert > 0) c.lerp(new Color('#d2b77c'), desert * 0.9);
  if (h > 4) c.lerp(new Color('#93845a'), Math.min(1, (h - 4) / 10));
  if (h > 16) c.lerp(new Color('#857d72'), Math.min(1, (h - 16) / 10));
  if (h > 34) c.lerp(new Color('#eef1f3'), Math.min(1, (h - 34) / 6));
  const n = Math.sin(x * 0.07 + z * 0.05) * Math.cos(z * 0.06 - x * 0.03) * 0.03 + Math.sin(x * 0.9) * Math.sin(z * 0.8) * 0.012;
  c.offsetHSL(0, 0, n);
  return c;
}

/** Flat strip following the ground along a polyline. */
function ribbon(geo: MapGeo, pts: XZ[], width: number, lift: number): BufferGeometry {
  const s: XZ[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 5));
    for (let k = 0; k < n; k++) s.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
  }
  s.push(pts[pts.length - 1]);
  const pos = new Float32Array(s.length * 6);
  s.forEach((p, i) => {
    const q0 = s[Math.max(0, i - 1)], q1 = s[Math.min(s.length - 1, i + 1)];
    let tx = q1.x - q0.x, tz = q1.z - q0.z;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l;
    tz /= l;
    const nx = -tz * (width / 2), nz = tx * (width / 2);
    const y = (x: number, z: number) => Math.max(MAP_WATER + 0.2, geo.height(x, z)) + lift;
    pos.set([p.x + nx, y(p.x + nx, p.z + nz), p.z + nz, p.x - nx, y(p.x - nx, p.z - nz), p.z - nz], i * 6);
  });
  const idx: number[] = [];
  for (let i = 0; i < s.length - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Split a polyline at a distance along it. */
function splitAt(pts: XZ[], d: number): [XZ[], XZ[]] {
  const a: XZ[] = [pts[0]];
  let left = d;
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i], q = pts[i + 1];
    const l = Math.hypot(q.x - p.x, q.z - p.z);
    if (left >= l) {
      a.push(q);
      left -= l;
      continue;
    }
    const m = { x: p.x + ((q.x - p.x) * left) / (l || 1), z: p.z + ((q.z - p.z) * left) / (l || 1) };
    if (left > 0) a.push(m);
    return [a, [m, ...pts.slice(i + 1)]];
  }
  return [a, []];
}

