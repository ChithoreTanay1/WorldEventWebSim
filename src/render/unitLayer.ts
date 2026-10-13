// Unit rendering from recorded frames (live play and replays use the same path). Each unit is a block
// (plate, outline, front edge, facing arrow, banner, top icon) filled with box soldiers drawn via
// InstancedMesh. Fog of war: unseen enemies are hidden, distant ones are grey silhouettes.
// Routing units go semi-transparent and scatter (dispersed). Zoomed out, blocks swap for NATO markers.
import {
  BoxGeometry, BufferGeometry, CanvasTexture, Color, DoubleSide, EdgesGeometry, Group, InstancedMesh,
  LineBasicMaterial, LineSegments, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, PlaneGeometry,
  Shape, ShapeGeometry, SRGBColorSpace, type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Battle, UnitSnap } from '../sim/battle';
import type { Unit } from '../sim/unit';
import { markerCanvas, topIconCanvas } from './icons';

type BodyKind = 'foot' | 'horse' | 'elephant';
const bodyKind = (u: Unit): BodyKind => (u.type.category === 'cavalry' ? 'horse' : u.type.category === 'elephant' ? 'elephant' : 'foot');

function soldierGeometry(kind: BodyKind): BufferGeometry {
  const box = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    const g = new BoxGeometry(w, h, d);
    g.translate(x, y, z);
    return g.toNonIndexed();
  };
  if (kind === 'foot') return mergeGeometries([box(0.42, 1.25, 0.5, 0, 0.62, 0), box(0.28, 0.3, 0.28, 0, 1.4, 0)]);
  if (kind === 'horse') return mergeGeometries([box(2.1, 1.0, 0.75, 0, 1.15, 0), box(0.6, 0.9, 0.5, 1.1, 1.75, 0), box(0.45, 0.9, 0.45, -0.1, 2.05, 0)]);
  return mergeGeometries([box(4.0, 2.4, 2.3, 0, 2.3, 0), box(1.3, 1.4, 1.4, 2.3, 2.9, 0), box(1.8, 1.0, 1.9, -0.4, 4.0, 0)]);
}

interface View {
  unit: Unit;
  group: Group;
  plate: Mesh;
  outline: LineSegments;
  outlineMat: LineBasicMaterial;
  front: Mesh;
  frontMat: MeshLambertMaterial;
  arrow: Mesh;
  banner: Group;
  icon: Mesh;
  marker: Mesh;
  markerMat: MeshBasicMaterial;
  unknownMat: MeshBasicMaterial;
  ring: Mesh;
  kind: BodyKind;
  base: number;
  cap: number;
  seeds: Float32Array;
  color: Color;
}

const tmp = new Matrix4();
const tmpColor = new Color();
const WHITE = new Color('#ffffff');
const GREY = new Color('#8d8a82');

export class UnitLayer {
  readonly root = new Group();
  private readonly views: View[] = [];
  private readonly bodies: Record<BodyKind, InstancedMesh>;
  private selected = new Set<number>();
  private hover: number | null = null;
  markerMode = false;
  private readonly textures: CanvasTexture[] = [];

  constructor(private readonly battle: Battle) {
    const counts: Record<BodyKind, number> = { foot: 0, horse: 0, elephant: 0 };
    for (const u of battle.units) counts[bodyKind(u)] += Math.ceil(u.type.figures * u.strength);
    const mat = new MeshLambertMaterial({ color: '#ffffff', flatShading: true, transparent: true });
    this.bodies = {
      foot: new InstancedMesh(soldierGeometry('foot'), mat, Math.max(1, counts.foot)),
      horse: new InstancedMesh(soldierGeometry('horse'), mat.clone(), Math.max(1, counts.horse)),
      elephant: new InstancedMesh(soldierGeometry('elephant'), mat.clone(), Math.max(1, counts.elephant)),
    };
    for (const m of Object.values(this.bodies)) {
      m.frustumCulled = false;
      m.setColorAt(0, WHITE);
      this.root.add(m);
    }
    const used: Record<BodyKind, number> = { foot: 0, horse: 0, elephant: 0 };
    for (const u of battle.units) {
      const kind = bodyKind(u);
      const cap = Math.ceil(u.type.figures * u.strength);
      this.views.push(this.buildView(u, kind, used[kind], cap));
      used[kind] += cap;
    }
  }

  private texture(canvas: HTMLCanvasElement): CanvasTexture {
    const t = new CanvasTexture(canvas);
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = 4;
    this.textures.push(t);
    return t;
  }

  private buildView(u: Unit, kind: BodyKind, base: number, cap: number): View {
    const side = this.battle.sides.get(u.side)!;
    const color = new Color(side.color);
    const group = new Group();
    const unitBox = new BoxGeometry(1, 1, 1);
    const plate = new Mesh(unitBox, new MeshBasicMaterial({ color: '#15130e', transparent: true, opacity: 0.22, depthWrite: false }));
    const outlineMat = new LineBasicMaterial({ color, transparent: true, opacity: 0.85 });
    const outline = new LineSegments(new EdgesGeometry(unitBox), outlineMat);
    const frontMat = new MeshLambertMaterial({ color: color.clone().offsetHSL(0, 0.1, 0.12), transparent: true });
    const front = new Mesh(unitBox, frontMat);
    const tri = new Shape();
    tri.moveTo(1.4, 0);
    tri.lineTo(-0.9, 1.3);
    tri.lineTo(-0.9, -1.3);
    tri.closePath();
    const arrowGeo = new ShapeGeometry(tri);
    arrowGeo.rotateX(-Math.PI / 2);
    const arrow = new Mesh(arrowGeo, new MeshBasicMaterial({ color: color.clone().offsetHSL(0, 0, 0.2), side: DoubleSide }));
    const banner = new Group();
    const pole = new Mesh(new BoxGeometry(0.14, 6.5, 0.14), new MeshLambertMaterial({ color: '#4a3b26' }));
    pole.position.y = 3.25;
    const flag = new Mesh(new PlaneGeometry(2.8, 1.7), new MeshLambertMaterial({ color, side: DoubleSide }));
    flag.rotation.y = Math.PI / 2;
    flag.position.set(0, 5.5, 1.45);
    banner.add(pole, flag);
    const iconGeo = new PlaneGeometry(1, 1);
    iconGeo.rotateX(-Math.PI / 2);
    iconGeo.rotateY(-Math.PI / 2);
    const icon = new Mesh(iconGeo, new MeshBasicMaterial({ map: this.texture(topIconCanvas(u.type.icon)), transparent: true, depthWrite: false }));
    const markerMat = new MeshBasicMaterial({ map: this.texture(markerCanvas(u.type.icon, side.color)), transparent: true, depthTest: false });
    const unknownMat = new MeshBasicMaterial({ map: this.texture(markerCanvas('unknown', '#7d7a72')), transparent: true, depthTest: false });
    const marker = new Mesh(iconGeo, markerMat);
    marker.renderOrder = 10;
    const ring = new Mesh(iconGeo, new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85, depthTest: false }));
    ring.renderOrder = 9;
    group.add(plate, outline, front, arrow, banner, icon, marker, ring);
    this.root.add(group);
    const seeds = new Float32Array(cap * 3);
    let s = (u.id + 1) * 9973;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < seeds.length; k++) seeds[k] = rnd();
    return { unit: u, group, plate, outline, outlineMat, front, frontMat, arrow, banner, icon, marker, markerMat, unknownMat, ring, kind, base, cap, seeds, color };
  }

  setSelected(ids: Iterable<number>) {
    this.selected = new Set(ids);
  }

  setHover(id: number | null) {
    this.hover = id;
  }

  /** Draw the interpolation between two frames. */
  update(a: UnitSnap[], b: UnitSnap[], alpha: number, time: number, cameraDistance: number) {
    if (this.markerMode && cameraDistance < 330) this.markerMode = false;
    else if (!this.markerMode && cameraDistance > 380) this.markerMode = true;
    const terrain = this.battle.terrain;
    for (const v of this.views) {
      const s0 = a[v.unit.id], s1 = b[v.unit.id];
      const body = this.bodies[v.kind];
      const gone = s1.status === 'shattered' || s1.status === 'deserted' || s1.status === 'destroyed' || s1.seen === 0;
      v.group.visible = !gone;
      if (gone) {
        for (let k = 0; k < v.cap; k++) body.setMatrixAt(v.base + k, tmp.makeScale(0, 0, 0));
        continue;
      }
      const x = s0.x + (s1.x - s0.x) * alpha;
      const z = s0.z + (s1.z - s0.z) * alpha;
      let d = s1.facing - s0.facing;
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      const facing = s0.facing + d * alpha;
      const cos = Math.cos(facing), sin = Math.sin(facing);
      const gy = terrain.height(x, z);
      const frontage = s1.frontage, depth = s1.depth, height = v.unit.type.height;
      const sel = this.selected.has(v.unit.id), hov = this.hover === v.unit.id;
      const known = s1.seen >= 3; // identified: real colours, soldiers and banner
      const routing = s1.status === 'routing';
      const recovering = s1.status === 'recovering';
      const fade = routing ? 0.45 : 1;
      v.group.position.set(x, gy, z);
      v.group.rotation.y = -facing;

      const blocks = !this.markerMode;
      v.plate.visible = v.outline.visible = blocks;
      v.front.visible = v.arrow.visible = blocks && known && !routing;
      v.banner.visible = v.icon.visible = blocks && known && !routing;
      v.marker.visible = !blocks;
      v.marker.material = known ? v.markerMat : v.unknownMat;
      v.ring.visible = !blocks && (sel || hov);
      if (blocks) {
        v.plate.scale.set(depth + 1, 0.3, frontage + 1);
        v.plate.position.y = 0.2;
        v.outline.scale.set(depth + 0.8, height + 0.6, frontage + 0.8);
        v.outline.position.y = (height + 0.6) / 2;
        const base = known ? v.color : GREY;
        v.outlineMat.color.copy(sel ? WHITE : hov ? tmpColor.set('#fff4c8') : base);
        v.outlineMat.opacity = (sel ? 1 : hov ? 0.95 : 0.6) * fade;
        v.front.scale.set(0.45, 0.35, frontage + 0.8);
        v.front.position.set(depth / 2 + 0.6, 0.25, 0);
        v.frontMat.color.copy(v.color).offsetHSL(0, 0.1, recovering ? -0.1 : 0.12);
        v.arrow.position.set(depth / 2 + 3.2, 0.35, 0);
        v.arrow.scale.setScalar(Math.max(1.2, Math.min(3, frontage / 14)));
        v.banner.position.set(depth / 2 - 0.5, 0, 0);
        const iconSize = Math.max(3.5, Math.min(10, Math.min(frontage, depth) * 0.9));
        v.icon.scale.set(iconSize, 1, iconSize);
        v.icon.position.y = height + 2.4;
      } else {
        const ms = cameraDistance * 0.06;
        v.marker.scale.set(ms * 1.3, 1, ms * 1.3);
        v.marker.position.y = 3;
        v.ring.scale.set(ms * 1.12, 1, ms * 1.12);
        v.ring.position.y = 2.9;
        v.markerMat.color.set(routing ? '#ff8a7a' : recovering ? '#ffc070' : '#ffffff');
        v.markerMat.opacity = routing ? 0.55 : 1;
      }

      // Soldiers: a grid sized to the formation footprint, thinned as HP falls.
      const shown = blocks && known ? s1.figures : 0;
      const aspect = Math.max(0.2, frontage / Math.max(1, depth));
      const files = Math.max(1, Math.round(Math.sqrt(Math.max(1, shown) * aspect)));
      const ranks = Math.max(1, Math.ceil(shown / files));
      const sx = frontage / files, sz = depth / ranks;
      const loose = s1.formation === 'loose' ? 0.35 : 0.12;
      const scatter = routing ? Math.min(14, s1.routTicks * 0.9) : 0;
      const fighting = s1.fighting && !routing;
      const tint = recovering ? 0.25 + 0.15 * Math.sin(time * 9) : routing ? 0.45 : 0;
      for (let k = 0; k < v.cap; k++) {
        const idx = v.base + k;
        if (k >= shown) {
          body.setMatrixAt(idx, tmp.makeScale(0, 0, 0));
          continue;
        }
        const r1 = v.seeds[k * 3], r2 = v.seeds[k * 3 + 1], r3 = v.seeds[k * 3 + 2];
        const rank = Math.floor(k / files);
        const inRank = rank === ranks - 1 ? shown - rank * files : files;
        const file = k % files;
        let f = depth / 2 - (rank + 0.5) * sz + (r1 - 0.5) * sz * loose * 2;
        let l = (file - (inRank - 1) / 2) * sx + (r2 - 0.5) * sx * loose * 2;
        let ang = facing + (r3 - 0.5) * 0.2;
        if (recovering) l += Math.sin(time * 18 + k) * 0.15;
        if (fighting) f += Math.sin(time * 7 + k * 1.7) * 0.3;
        if (routing) {
          const aa = r1 * Math.PI * 2;
          f += Math.cos(aa) * scatter * r2;
          l += Math.sin(aa) * scatter * r2;
          ang = facing + (r3 - 0.5) * 1.6;
        }
        const wx = x + f * cos - l * sin;
        const wz = z + f * sin + l * cos;
        tmp.makeRotationY(-ang).setPosition(wx, terrain.height(wx, wz), wz);
        body.setMatrixAt(idx, tmp);
        tmpColor.copy(v.color).offsetHSL(0, 0, (r3 - 0.5) * 0.12 + (v.kind === 'foot' ? 0.05 : 0));
        if (tint > 0) tmpColor.lerp(routing ? GREY : WHITE, tint);
        body.setColorAt(idx, tmpColor);
      }
    }
    for (const m of Object.values(this.bodies)) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  dispose() {
    this.root.traverse((o) => {
      const m = o as Mesh;
      m.geometry?.dispose();
      const mat = m.material as Material | Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
    this.textures.forEach((t) => t.dispose());
    this.root.removeFromParent();
  }
}
