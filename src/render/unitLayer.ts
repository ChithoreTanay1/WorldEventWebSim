// Unit rendering from recorded frames (live play and replays use the same path). Each unit is a block
// (plate, outline, front edge, facing arrow, banner, top icon) filled with box soldiers. Fog of war:
// unseen enemies are hidden, distant ones are grey silhouettes. Routing units go semi-transparent and
// scatter. Zoomed out, blocks swap for NATO-style markers.
//
// Built for a steady 60 FPS on integrated graphics: every part is an InstancedMesh (or one merged line
// set) shared by all units, so the whole army is ~20 draw calls; matrices and colours are written
// straight into typed arrays; a unit whose drawn state hasn't changed since last frame is skipped, and
// only the changed instance ranges are uploaded. No allocation per frame.
import {
  BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Color, DoubleSide, EdgesGeometry, InstancedBufferAttribute,
  InstancedMesh, LineBasicMaterial, LineSegments, Group, MeshBasicMaterial, MeshLambertMaterial, PlaneGeometry, Shape,
  ShapeGeometry, SRGBColorSpace, type Material, type Mesh,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Battle, UnitSnap } from '../sim/battle';
import type { Unit } from '../sim/unit';
import type { HeightCache } from './heightCache';
import { barSymbolCanvas, topIconCanvas } from './icons';

type BodyKind = 'foot' | 'horse' | 'elephant';
const KINDS: BodyKind[] = ['foot', 'horse', 'elephant'];
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

const WHITE = new Color('#ffffff');
const GREY = new Color('#8d8a82');
const HOVER = new Color('#fff4c8');
const PARCH = new Color('#f6efdc');
const ROUT_TINT = new Color('#7a3a30');
const RECOVER_TINT = new Color('#c89040');
const tmpColor = new Color();

/** Write T(x,y,z)·Ry(θ)·S(sx,sy,sz) into a column-major matrix array, with c = cos θ, s = sin θ. */
function writeTRS(a: Float32Array, i: number, x: number, y: number, z: number, c: number, s: number, sx: number, sy: number, sz: number) {
  const o = i * 16;
  a[o] = c * sx; a[o + 1] = 0; a[o + 2] = -s * sx; a[o + 3] = 0;
  a[o + 4] = 0; a[o + 5] = sy; a[o + 6] = 0; a[o + 7] = 0;
  a[o + 8] = s * sz; a[o + 9] = 0; a[o + 10] = c * sz; a[o + 11] = 0;
  a[o + 12] = x; a[o + 13] = y; a[o + 14] = z; a[o + 15] = 1;
}

function writeZero(a: Float32Array, i: number) {
  a.fill(0, i * 16, i * 16 + 16);
}

/** An instanced part with one slot per unit (or per unit of one icon type). */
class Part {
  readonly mesh: InstancedMesh;
  readonly m: Float32Array;
  readonly c: Float32Array | null;
  dirty = false;

  constructor(geo: BufferGeometry, mat: Material, count: number, colors: boolean, renderOrder = 0) {
    this.mesh = new InstancedMesh(geo, mat, Math.max(1, count));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.m = this.mesh.instanceMatrix.array as Float32Array;
    this.m.fill(0);
    if (colors) {
      this.mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(Math.max(1, count) * 3), 3);
      this.c = this.mesh.instanceColor.array as Float32Array;
    } else this.c = null;
  }

  color(i: number, col: Color) {
    if (!this.c) return;
    this.c[i * 3] = col.r;
    this.c[i * 3 + 1] = col.g;
    this.c[i * 3 + 2] = col.b;
  }

  hide(i: number) {
    writeZero(this.m, i);
    this.dirty = true;
  }

  flush() {
    if (!this.dirty) return;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.dirty = false;
  }
}

/** One LineSegments for every unit's copy of a small line shape, coloured per vertex (with alpha). */
class LineSet {
  readonly lines: LineSegments;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly shape: Float32Array;
  readonly per: number;
  dirty = false;

  constructor(shape: BufferGeometry, count: number, depthTest: boolean, renderOrder: number) {
    this.shape = (shape.getAttribute('position').array as Float32Array).slice();
    this.per = this.shape.length / 3;
    this.pos = new Float32Array(this.per * count * 3);
    this.col = new Float32Array(this.per * count * 4);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(this.pos, 3));
    g.setAttribute('color', new BufferAttribute(this.col, 4));
    this.lines = new LineSegments(g, new LineBasicMaterial({ vertexColors: true, transparent: true, depthTest }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = renderOrder;
  }

  /** Place shape copy `i`: scaled, lifted by `oy`, rotated (c, s as in writeTRS) and moved to (x, y, z). */
  set(i: number, x: number, y: number, z: number, c: number, s: number, sx: number, sy: number, sz: number, oy: number, col: Color, alpha: number) {
    const sh = this.shape, p = this.pos, k = this.col;
    for (let v = 0; v < this.per; v++) {
      const lx = sh[v * 3] * sx, ly = sh[v * 3 + 1] * sy + oy, lz = sh[v * 3 + 2] * sz;
      const o = (i * this.per + v) * 3;
      p[o] = x + c * lx + s * lz;
      p[o + 1] = y + ly;
      p[o + 2] = z - s * lx + c * lz;
      const q = (i * this.per + v) * 4;
      k[q] = col.r;
      k[q + 1] = col.g;
      k[q + 2] = col.b;
      k[q + 3] = alpha;
    }
    this.dirty = true;
  }

  hide(i: number) {
    for (let v = 0; v < this.per; v++) this.col[(i * this.per + v) * 4 + 3] = 0;
    this.dirty = true;
  }

  flush() {
    if (!this.dirty) return;
    this.lines.geometry.getAttribute('position').needsUpdate = true;
    this.lines.geometry.getAttribute('color').needsUpdate = true;
    this.dirty = false;
  }
}

interface View {
  unit: Unit;
  kind: BodyKind;
  /** First soldier instance and how many slots this unit owns. */
  base: number;
  cap: number;
  seeds: Float32Array;
  /** Per-soldier base colours (side colour with a little variation), computed once. */
  colors: Float32Array;
  color: Color;
  frontColor: Color;
  arrowColor: Color;
  iconPart: Part;
  iconSlot: number;
  symbolPart: Part;
  symbolSlot: number;
  /** Last drawn state, to skip units that haven't changed. */
  sig: Float64Array;
  shownLast: number;
  tintLast: number;
}

const SIG = 14;

export class UnitLayer {
  readonly root = new Group();
  private readonly views: View[] = [];
  private readonly bodies: Record<BodyKind, InstancedMesh>;
  private readonly bodyDirty: Record<BodyKind, [number, number]> = { foot: [Infinity, -1], horse: [Infinity, -1], elephant: [Infinity, -1] };
  private readonly plate: Part;
  private readonly front: Part;
  private readonly arrow: Part;
  private readonly pole: Part;
  private readonly flag: Part;
  private readonly icons: Part[] = [];
  private readonly outline: LineSet;
  private readonly markerBody: Part;
  private readonly markerRout: Part;
  private readonly markerBorder: LineSet;
  private readonly symbols: Part[] = [];
  private readonly unknownSymbol: Part;
  private readonly chevron: Part;
  private readonly parts: Part[] = [];
  private selected = new Set<number>();
  private hover: number | null = null;
  markerMode = false;
  private readonly textures: CanvasTexture[] = [];

  constructor(battle: Battle, private readonly heights: HeightCache) {
    const n = battle.units.length;
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
      (m.instanceMatrix.array as Float32Array).fill(0);
      m.instanceColor = new InstancedBufferAttribute(new Float32Array(m.count * 3), 3);
      this.root.add(m);
    }

    // Block parts.
    const unitBox = new BoxGeometry(1, 1, 1);
    this.plate = this.part(unitBox, new MeshBasicMaterial({ color: '#15130e', transparent: true, opacity: 0.22, depthWrite: false }), n, false);
    this.front = this.part(unitBox, new MeshLambertMaterial({ color: '#ffffff' }), n, true);
    const tri = new Shape();
    tri.moveTo(1.4, 0);
    tri.lineTo(-0.9, 1.3);
    tri.lineTo(-0.9, -1.3);
    tri.closePath();
    const arrowGeo = new ShapeGeometry(tri);
    arrowGeo.rotateX(-Math.PI / 2);
    this.arrow = this.part(arrowGeo, new MeshBasicMaterial({ color: '#ffffff', side: DoubleSide, transparent: true, opacity: 0.55, forceSinglePass: true }), n, true);
    const poleGeo = new BoxGeometry(0.1, 5, 0.1);
    poleGeo.translate(0, 2.5, 0);
    this.pole = this.part(poleGeo, new MeshLambertMaterial({ color: '#4a3b26' }), n, false);
    const flagGeo = new PlaneGeometry(1.8, 1.1);
    flagGeo.rotateY(Math.PI / 2);
    flagGeo.translate(0, 4.3, 0.95);
    this.flag = this.part(flagGeo, new MeshLambertMaterial({ color: '#ffffff', side: DoubleSide }), n, true);
    const iconGeo = new PlaneGeometry(1, 1);
    iconGeo.rotateX(-Math.PI / 2);
    iconGeo.rotateY(-Math.PI / 2);
    this.outline = new LineSet(new EdgesGeometry(unitBox), n, true, 0);
    this.root.add(this.outline.lines);

    // Zoomed-out marker parts (drawn over everything, in this order).
    const flat = new PlaneGeometry(1, 1);
    flat.rotateX(-Math.PI / 2);
    this.markerBody = this.part(flat, new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.82, depthTest: false }), n, true, 10);
    this.markerRout = this.part(flat, new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.45, depthTest: false }), n, true, 10);
    const rect = new BufferGeometry();
    rect.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0, 0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, -0.5, 0, -0.5]), 3));
    this.markerBorder = new LineSet(rect, n, false, 11);
    this.root.add(this.markerBorder.lines);
    this.unknownSymbol = this.part(iconGeo, new MeshBasicMaterial({ map: this.texture(barSymbolCanvas('unknown')), transparent: true, depthTest: false }), n, false, 12);
    const chev = new Shape();
    chev.moveTo(1, 0);
    chev.lineTo(-0.2, 0.9);
    chev.lineTo(0.15, 0);
    chev.lineTo(-0.2, -0.9);
    chev.closePath();
    const chevGeo = new ShapeGeometry(chev);
    chevGeo.rotateX(-Math.PI / 2);
    this.chevron = this.part(chevGeo, new MeshBasicMaterial({ color: '#f6efdc', transparent: true, opacity: 0.9, side: DoubleSide, depthTest: false, forceSinglePass: true }), n, false, 12);

    // One icon mesh (top icon and bar symbol) per unit-type icon, with a slot for each unit using it.
    const byIcon = new Map<string, Unit[]>();
    for (const u of battle.units) byIcon.set(u.type.icon, [...(byIcon.get(u.type.icon) ?? []), u]);
    const iconOf = new Map<number, { icon: Part; symbol: Part; slot: number }>();
    for (const [icon, us] of byIcon) {
      const ip = this.part(iconGeo, new MeshBasicMaterial({ map: this.texture(topIconCanvas(icon)), transparent: true, depthWrite: false }), us.length, false);
      const sp = this.part(iconGeo, new MeshBasicMaterial({ map: this.texture(barSymbolCanvas(icon)), transparent: true, depthTest: false }), us.length, false, 12);
      this.icons.push(ip);
      this.symbols.push(sp);
      us.forEach((u, slot) => iconOf.set(u.id, { icon: ip, symbol: sp, slot }));
    }

    const used: Record<BodyKind, number> = { foot: 0, horse: 0, elephant: 0 };
    for (const u of battle.units) {
      const kind = bodyKind(u);
      const cap = Math.ceil(u.type.figures * u.strength);
      const color = new Color(battle.sides.get(u.side)!.color);
      const seeds = new Float32Array(cap * 3);
      let s = (u.id + 1) * 9973;
      const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      for (let k = 0; k < seeds.length; k++) seeds[k] = rnd();
      const colors = new Float32Array(cap * 3);
      for (let k = 0; k < cap; k++) {
        tmpColor.copy(color).offsetHSL(0, 0, (seeds[k * 3 + 2] - 0.5) * 0.12 + (kind === 'foot' ? 0.05 : 0));
        colors.set([tmpColor.r, tmpColor.g, tmpColor.b], k * 3);
      }
      const io = iconOf.get(u.id)!;
      const v: View = {
        unit: u, kind, base: used[kind], cap, seeds, colors, color,
        frontColor: color.clone().offsetHSL(0, 0.1, 0.12), arrowColor: color.clone().offsetHSL(0, 0, 0.2),
        iconPart: io.icon, iconSlot: io.slot, symbolPart: io.symbol, symbolSlot: io.slot,
        sig: new Float64Array(SIG).fill(NaN), shownLast: -1, tintLast: -1,
      };
      this.arrow.color(u.id, v.arrowColor);
      this.flag.color(u.id, color);
      this.views.push(v);
      used[kind] += cap;
    }
  }

  private part(geo: BufferGeometry, mat: Material, count: number, colors: boolean, renderOrder = 0): Part {
    const p = new Part(geo, mat, count, colors, renderOrder);
    this.parts.push(p);
    this.root.add(p.mesh);
    return p;
  }

  private texture(canvas: HTMLCanvasElement): CanvasTexture {
    const t = new CanvasTexture(canvas);
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = 4;
    this.textures.push(t);
    return t;
  }

  setSelected(ids: Iterable<number>) {
    this.selected.clear();
    for (const id of ids) this.selected.add(id);
  }

  setHover(id: number | null) {
    this.hover = id;
  }

  /** Draw the interpolation between two frames. */
  update(a: UnitSnap[], b: UnitSnap[], alpha: number, time: number, cameraDistance: number) {
    if (this.markerMode && cameraDistance < 330) this.markerMode = false;
    else if (!this.markerMode && cameraDistance > 380) this.markerMode = true;
    for (let i = 0; i < this.views.length; i++) this.updateUnit(this.views[i], a[i], b[i], alpha, time, cameraDistance);
    for (const p of this.parts) p.flush();
    this.outline.flush();
    this.markerBorder.flush();
    for (const kind of KINDS) {
      const r = this.bodyDirty[kind];
      if (r[1] < 0) continue;
      const m = this.bodies[kind];
      m.instanceMatrix.clearUpdateRanges();
      m.instanceMatrix.addUpdateRange(r[0] * 16, (r[1] - r[0] + 1) * 16);
      m.instanceMatrix.needsUpdate = true;
      const c = m.instanceColor!;
      c.clearUpdateRanges();
      c.addUpdateRange(r[0] * 3, (r[1] - r[0] + 1) * 3);
      c.needsUpdate = true;
      r[0] = Infinity;
      r[1] = -1;
    }
  }

  private markBodies(v: View, from: number, to: number) {
    const r = this.bodyDirty[v.kind];
    r[0] = Math.min(r[0], v.base + from);
    r[1] = Math.max(r[1], v.base + to);
  }

  private hideUnit(v: View) {
    const id = v.unit.id;
    for (const p of [this.plate, this.front, this.arrow, this.pole, this.flag, this.markerBody, this.markerRout, this.unknownSymbol, this.chevron]) p.hide(id);
    v.iconPart.hide(v.iconSlot);
    v.symbolPart.hide(v.symbolSlot);
    this.outline.hide(id);
    this.markerBorder.hide(id);
  }

  private updateUnit(v: View, s0: UnitSnap, s1: UnitSnap, alpha: number, time: number, cameraDistance: number) {
    const id = v.unit.id;
    const gone = s1.status === 'shattered' || s1.status === 'deserted' || s1.status === 'destroyed' || s1.seen === 0;
    const x = s0.x + (s1.x - s0.x) * alpha;
    const z = s0.z + (s1.z - s0.z) * alpha;
    let d = s1.facing - s0.facing;
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    const facing = s0.facing + d * alpha;
    const known = s1.seen >= 3; // identified: real colours, soldiers and banner
    const routing = s1.status === 'routing';
    const recovering = s1.status === 'recovering';
    const fighting = s1.fighting && !routing;
    const sel = this.selected.has(id), hov = this.hover === id;
    const blocks = !this.markerMode;

    // Skip a unit whose drawn state is exactly what it was last frame (and isn't animating).
    const sig = v.sig;
    const animated = !gone && blocks && known && (fighting || recovering);
    const same = !animated && sig[0] === x && sig[1] === z && sig[2] === facing && sig[3] === s1.figures && sig[4] === statusCode(s1)
      && sig[5] === s1.frontage && sig[6] === s1.depth && sig[7] === s1.seen && sig[8] === (blocks ? 1 : 0) && sig[9] === (sel ? 1 : 0)
      && sig[10] === (hov ? 1 : 0) && sig[11] === s1.routTicks && sig[12] === (blocks ? 0 : cameraDistance) && sig[13] === (gone ? 1 : 0);
    if (same) return;
    sig[0] = x; sig[1] = z; sig[2] = facing; sig[3] = s1.figures; sig[4] = statusCode(s1); sig[5] = s1.frontage; sig[6] = s1.depth;
    sig[7] = s1.seen; sig[8] = blocks ? 1 : 0; sig[9] = sel ? 1 : 0; sig[10] = hov ? 1 : 0; sig[11] = s1.routTicks; sig[12] = blocks ? 0 : cameraDistance; sig[13] = gone ? 1 : 0;

    if (gone) {
      this.hideUnit(v);
      this.soldiers(v, 0, x, z, facing, s1, time, false, false, false);
      return;
    }
    // Group frame: rotation about Y by -facing.
    const cf = Math.cos(facing), sf = Math.sin(facing);
    const c = cf, s = -sf;
    const gy = this.heights.height(x, z);
    const frontage = s1.frontage, depth = s1.depth, height = v.unit.type.height;
    const fade = routing ? 0.45 : 1;

    if (blocks) {
      this.markerBody.hide(id);
      this.markerRout.hide(id);
      this.unknownSymbol.hide(id);
      v.symbolPart.hide(v.symbolSlot);
      this.chevron.hide(id);
      this.markerBorder.hide(id);
      writeTRS(this.plate.m, id, x, gy + 0.2, z, c, s, depth + 1, 0.3, frontage + 1);
      this.plate.dirty = true;
      const base = known ? v.color : GREY;
      this.outline.set(id, x, gy, z, c, s, depth + 0.8, height + 0.6, frontage + 0.8, (height + 0.6) / 2,
        sel ? WHITE : hov ? HOVER : base, (sel ? 1 : hov ? 0.95 : 0.6) * fade);
      const decor = known && !routing;
      if (decor) {
        const ff = depth / 2 + 0.6;
        writeTRS(this.front.m, id, x + ff * cf, gy + 0.25, z + ff * sf, c, s, 0.3, 0.22, frontage + 0.8);
        tmpColor.copy(v.color).offsetHSL(0, 0.1, recovering ? -0.1 : 0.12);
        this.front.color(id, tmpColor);
        this.front.dirty = true;
        const as = Math.max(0.8, Math.min(1.6, frontage / 30));
        const af = depth / 2 + 2.4;
        writeTRS(this.arrow.m, id, x + af * cf, gy + 0.3, z + af * sf, c, s, as, as, as);
        this.arrow.dirty = true;
        const bf = depth / 2 - 0.5;
        const bx = x + bf * cf, bz = z + bf * sf;
        writeTRS(this.pole.m, id, bx, gy, bz, c, s, 1, 1, 1);
        writeTRS(this.flag.m, id, bx, gy, bz, c, s, 1, 1, 1);
        this.pole.dirty = this.flag.dirty = true;
        const is = Math.max(3, Math.min(6.5, Math.min(frontage, depth) * 0.7));
        writeTRS(v.iconPart.m, v.iconSlot, x, gy + height + 1.6, z, c, s, is, 1, is);
        v.iconPart.dirty = true;
      } else {
        this.front.hide(id);
        this.arrow.hide(id);
        this.pole.hide(id);
        this.flag.hide(id);
        v.iconPart.hide(v.iconSlot);
      }
    } else {
      this.plate.hide(id);
      this.front.hide(id);
      this.arrow.hide(id);
      this.pole.hide(id);
      this.flag.hide(id);
      v.iconPart.hide(v.iconSlot);
      this.outline.hide(id);
      const ms = cameraDistance * 0.045;
      // Long along the real frontage (so battle lines read as lines), slim in depth.
      const along = Math.max(ms * 1.5, Math.min(ms * 5, frontage * 1.05));
      const deep = Math.max(ms * 0.42, Math.min(ms * 1.4, depth * 0.9));
      const my = gy + 3;
      const body = routing ? this.markerRout : this.markerBody;
      (routing ? this.markerBody : this.markerRout).hide(id);
      writeTRS(body.m, id, x, my, z, c, s, deep, 1, along);
      tmpColor.copy(known ? v.color : GREY);
      if (routing) tmpColor.lerp(ROUT_TINT, 0.45);
      else if (recovering) tmpColor.lerp(RECOVER_TINT, 0.35);
      body.color(id, tmpColor);
      body.dirty = true;
      this.markerBorder.set(id, x, my, z, c, s, deep, 1, along, 0, sel ? WHITE : hov ? HOVER : PARCH, sel ? 1 : hov ? 0.95 : 0.55);
      // The symbol canvas is 2:1 (width along the frontage, height across the bar's depth).
      const symH = deep * 0.95;
      const sym = known ? v.symbolPart : this.unknownSymbol;
      const symSlot = known ? v.symbolSlot : id;
      (known ? this.unknownSymbol : v.symbolPart).hide(known ? id : v.symbolSlot);
      writeTRS(sym.m, symSlot, x, my + 0.1, z, c, s, symH, 1, Math.min(symH * 2, along * 0.9));
      sym.dirty = true;
      if (known && !routing) {
        const cs = ms * 0.16, off = deep / 2 + ms * 0.08;
        writeTRS(this.chevron.m, id, x + off * cf, my + 0.1, z + off * sf, c, s, cs, cs, cs);
        this.chevron.dirty = true;
      } else this.chevron.hide(id);
    }
    this.soldiers(v, blocks && known ? s1.figures : 0, x, z, facing, s1, time, routing, recovering, fighting);
  }

  /** Soldiers: a grid sized to the formation footprint, thinned as HP falls. */
  private soldiers(v: View, shown: number, x: number, z: number, facing: number, s1: UnitSnap, time: number, routing: boolean, recovering: boolean, fighting: boolean) {
    const body = this.bodies[v.kind];
    const m = body.instanceMatrix.array as Float32Array;
    const col = body.instanceColor!.array as Float32Array;
    shown = Math.min(shown, v.cap);
    // Slots beyond the shown count are zeroed once, when the count drops.
    if (v.shownLast !== shown) {
      if (shown < v.shownLast || v.shownLast < 0) {
        m.fill(0, (v.base + shown) * 16, (v.base + v.cap) * 16);
        this.markBodies(v, shown, v.cap - 1);
      }
      v.tintLast = -1;
      v.shownLast = shown;
    }
    if (shown === 0) return;
    const frontage = s1.frontage, depth = s1.depth;
    const aspect = Math.max(0.2, frontage / Math.max(1, depth));
    const files = Math.max(1, Math.round(Math.sqrt(Math.max(1, shown) * aspect)));
    const ranks = Math.max(1, Math.ceil(shown / files));
    const sx = frontage / files, sz = depth / ranks;
    const loose = s1.formation === 'loose' ? 0.35 : 0.12;
    const scatter = routing ? Math.min(14, s1.routTicks * 0.9) : 0;
    const cos = Math.cos(facing), sin = Math.sin(facing);
    for (let k = 0; k < shown; k++) {
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
      writeTRS(m, v.base + k, wx, this.heights.height(wx, wz), wz, Math.cos(ang), -Math.sin(ang), 1, 1, 1);
    }
    // Colours only change with the tint (recovering pulses, routing greys out).
    const tint = recovering ? 0.25 + 0.15 * Math.sin(time * 9) : routing ? 0.45 : 0;
    if (tint !== v.tintLast) {
      v.tintLast = tint;
      const to = routing ? GREY : WHITE;
      for (let k = 0; k < shown; k++) {
        const o = (v.base + k) * 3, q = k * 3;
        col[o] = v.colors[q] + (to.r - v.colors[q]) * tint;
        col[o + 1] = v.colors[q + 1] + (to.g - v.colors[q + 1]) * tint;
        col[o + 2] = v.colors[q + 2] + (to.b - v.colors[q + 2]) * tint;
      }
    }
    this.markBodies(v, 0, shown - 1);
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

function statusCode(s: UnitSnap): number {
  switch (s.status) {
    case 'standing': return 0;
    case 'recovering': return 1;
    case 'routing': return 2;
    case 'shattered': return 3;
    case 'deserted': return 4;
    default: return 5;
  }
}
