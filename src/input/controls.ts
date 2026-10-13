// Lines of Battle style controls (wiki "Orders", "Order Types", "Formations", "Control Groups").
// Left = select. Right-click ground = move with the current order type; right-drag = shape a path
// (one unit), rotate (drag starting on the unit) or lay a line (several units, stacked by role);
// right-click an enemy = lock on; right-click a friend = follow. 1-5 order type, Y clear orders,
// R T F G formations, Alt/Ctrl/Shift + 1-9 control groups. Camera: WASD/arrows/edges, wheel, Q/E,
// middle-drag. Orders are planned while time is stopped; Space/Enter ends the turn.
import type { Battle } from '../sim/battle';
import type { Order, OrderType, XZ } from '../sim/types';
import type { Unit } from '../sim/unit';
import type { View } from '../render/view';
import { ORDER_COLORS, type OrderVisual } from '../render/overlay';
import { planClickMove, planLine, roleRow, routeLanes, simplifyPath, type LineUnit, type Placement } from './formation';

export interface ControlHandlers {
  onSelection(ids: number[]): void;
  onGroups(): void;
  onOrderType(t: OrderType): void;
  endTurn(): void;
  replay(): void;
  changeSpeed(delta: number): void;
  toggleHelp(): void;
}

export const ORDER_KEYS: [OrderType, string, string][] = [
  ['fireAdvance', '1', 'Fire & Advance'],
  ['run', '2', 'Run'],
  ['shoot', '3', 'Shoot'],
  ['walk', '4', 'Walk'],
  ['fallback', '5', 'Fallback'],
];
export const FORMATION_KEYS = ['KeyR', 'KeyT', 'KeyF', 'KeyG'];

interface Drag {
  button: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
  points: XZ[];
  mode: 'rotate' | 'path' | 'line' | 'route' | 'camera' | null;
  unit: Unit | null;
}

const DRAG_PX = 6;
const MIN_LINE = 8;

export class Controls {
  selection = new Set<number>();
  /** Control groups 1-9 (index 0 unused). */
  groups: number[][] = Array.from({ length: 10 }, () => []);
  orderType: OrderType = 'fireAdvance';
  /** Retyping an order applies to the selection (wiki setting, on by default). */
  retypeSelection = true;
  hoverId: number | null = null;
  private keys = new Set<string>();
  private drag: Drag | null = null;
  private preview: { placements?: Placement[]; rotate?: { id: number; facing: number }; routes?: { id: number; path: XZ[] }[] } | null = null;
  private mouse = { x: -1, y: -1, inside: false };
  private readonly box: HTMLDivElement;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private battle: Battle,
    private readonly view: View,
    private readonly ui: ControlHandlers,
  ) {
    this.box = document.createElement('div');
    this.box.className = 'box-select';
    document.body.append(this.box);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    window.addEventListener('pointermove', (e) => this.move(e));
    window.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('dblclick', (e) => this.dblclick(e));
    canvas.addEventListener('pointerenter', () => (this.mouse.inside = true));
    canvas.addEventListener('pointerleave', () => (this.mouse.inside = false));
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.view.rig.zoom(Math.exp(e.deltaY * 0.0012));
    }, { passive: false });
    window.addEventListener('keydown', (e) => this.keydown(e));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    this.initialGroups();
  }

  setBattle(b: Battle) {
    this.battle = b;
    this.selection.clear();
    this.groups = Array.from({ length: 10 }, () => []);
    this.initialGroups();
    this.cancelDrag();
    this.ui.onSelection([]);
    this.ui.onGroups();
  }

  /** Initial groups by category (wiki: 1 infantry, 2 cavalry, 3 artillery -> elephants here, 4 skirmish/missile). */
  private initialGroups() {
    const mineAll = this.battle.units.filter((u) => u.side === this.battle.player);
    this.groups[1] = mineAll.filter((u) => u.type.category === 'infantry').map((u) => u.id);
    this.groups[2] = mineAll.filter((u) => u.type.category === 'cavalry').map((u) => u.id);
    this.groups[3] = mineAll.filter((u) => u.type.category === 'elephant').map((u) => u.id);
    this.groups[4] = mineAll.filter((u) => u.type.category === 'missile' || u.type.category === 'skirmisher').map((u) => u.id);
  }

  // ------------------------------------------------------------ helpers

  private get planning(): boolean {
    return this.battle.phase === 'planning' || this.battle.phase === 'deployment';
  }

  /** Selected units that can take orders now. */
  commandable(): Unit[] {
    return [...this.selection].map((id) => this.battle.unit(id)).filter((u) => u.side === this.battle.player && this.battle.canCommand(u.id));
  }

  private lineUnit(u: Unit): LineUnit {
    const shape = this.battle.plannedFormation.get(u.id) ?? u.shapeFormation;
    const [frontage, depth] = u.type.formations[shape] ?? u.footprint;
    return { id: u.id, x: u.x, z: u.z, facing: u.facing, frontage: frontage * Math.sqrt(u.strength), depth: depth * Math.sqrt(u.strength), row: roleRow(u.type.category, shape) };
  }

  /** Unit under the cursor (any side). Enemies must be visible. */
  unitAt(clientX: number, clientY: number): Unit | null {
    const live = this.battle.units.filter((u) => u.alive && this.battle.seen(this.battle.player, u) > 0);
    let best: Unit | null = null;
    let bd = Infinity;
    if (!this.view.units.markerMode) {
      const g = this.view.pickGround(clientX, clientY);
      if (g) {
        for (const u of live) {
          if (!u.contains(g.x, g.z, 2.5)) continue;
          const d = Math.hypot(u.x - g.x, u.z - g.z);
          if (d < bd) (bd = d), (best = u);
        }
        if (best) return best;
      }
    }
    bd = this.view.units.markerMode ? 28 : 16;
    for (const u of live) {
      const p = this.view.project(u.x, this.battle.terrain.height(u.x, u.z) + 2, u.z);
      const d = Math.hypot(p.x - clientX, p.y - clientY);
      if (p.visible && d < bd) (bd = d), (best = u);
    }
    return best;
  }

  select(ids: number[], add = false) {
    if (!add) this.selection.clear();
    for (const id of ids) this.selection.add(id);
    const enemy = [...this.selection].filter((id) => this.battle.unit(id).side !== this.battle.player);
    if (enemy.length && this.selection.size > 1) enemy.forEach((id) => this.selection.delete(id));
    this.ui.onSelection([...this.selection]);
  }

  private cancelDrag() {
    this.drag = null;
    this.preview = null;
    this.box.style.display = 'none';
    this.view.overlay.setTrail(null);
  }

  // ------------------------------------------------------------ pointer

  private down(e: PointerEvent) {
    if (this.drag) return;
    this.canvas.setPointerCapture(e.pointerId);
    const d: Drag = { button: e.button, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false, points: [], mode: null, unit: null };
    if (e.button === 0 && e.ctrlKey && e.shiftKey) {
      // Ctrl+Shift+left-drag: tilt the camera up and down (and turn it left and right).
      d.mode = 'camera';
    } else if (e.button === 0 && this.planning) {
      // Left-drag starting on a selected unit draws the route the selection will follow.
      const under = this.unitAt(e.clientX, e.clientY);
      const units = this.commandable();
      if (under && units.some((u) => u.id === under.id)) {
        d.mode = 'route';
        d.unit = under;
        d.points.push({ x: under.x, z: under.z });
      }
    }
    if (e.button === 2) {
      const g = this.view.pickGround(e.clientX, e.clientY);
      if (g) d.points.push(g);
      const units = this.commandable();
      const under = this.unitAt(e.clientX, e.clientY);
      // Hold the secondary button on a single selected unit and drag to set its facing (Rotate).
      if (units.length === 1 && under && under.id === units[0].id) d.mode = 'rotate';
      else if (units.length === 1) d.mode = 'path';
      else if (units.length > 1) d.mode = 'line';
      d.unit = units[0] ?? null;
    }
    this.drag = d;
    if (e.button === 1) e.preventDefault();
  }

  private move(e: PointerEvent) {
    this.mouse.x = e.clientX;
    this.mouse.y = e.clientY;
    const d = this.drag;
    if (!d) {
      if (e.target === this.canvas) {
        const u = this.unitAt(e.clientX, e.clientY);
        this.hoverId = u ? u.id : null;
      }
      return;
    }
    if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > DRAG_PX) d.moved = true;
    if (d.button === 1 || d.mode === 'camera') {
      this.view.rig.rotate((e.clientX - d.lastX) * 0.006, (e.clientY - d.lastY) * 0.004);
    } else if (d.button === 0 && d.mode === 'route') {
      const g = this.view.pickGround(e.clientX, e.clientY);
      const last = d.points[d.points.length - 1];
      if (g && (!last || Math.hypot(g.x - last.x, g.z - last.z) > 1.5)) d.points.push(g);
      this.updatePreview(d);
    } else if (d.button === 0 && d.moved) {
      const x = Math.min(d.startX, e.clientX), y = Math.min(d.startY, e.clientY);
      Object.assign(this.box.style, { display: 'block', left: `${x}px`, top: `${y}px`, width: `${Math.abs(e.clientX - d.startX)}px`, height: `${Math.abs(e.clientY - d.startY)}px` });
    } else if (d.button === 2 && d.mode && this.planning) {
      const g = this.view.pickGround(e.clientX, e.clientY);
      const last = d.points[d.points.length - 1];
      if (g && (!last || Math.hypot(g.x - last.x, g.z - last.z) > 1.5)) d.points.push(g);
      this.updatePreview(d);
    }
    d.lastX = e.clientX;
    d.lastY = e.clientY;
  }

  private dragLength(p: XZ[]): number {
    let L = 0;
    for (let i = 1; i < p.length; i++) L += Math.hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z);
    return L;
  }

  private updatePreview(d: Drag) {
    if (d.points.length < 2 || this.dragLength(d.points) < MIN_LINE || !d.unit) {
      this.preview = null;
      return;
    }
    const last = d.points[d.points.length - 1];
    if (d.mode === 'rotate') {
      this.preview = { rotate: { id: d.unit.id, facing: Math.atan2(last.z - d.unit.z, last.x - d.unit.x) } };
    } else if (d.mode === 'path') {
      this.preview = { routes: routeLanes(d.points, [d.unit]) };
    } else if (d.mode === 'route') {
      this.preview = { routes: routeLanes(d.points, this.commandable()) };
    } else {
      const { fx, fz } = this.view.rig.groundAxes();
      this.preview = { placements: planLine(d.points, this.commandable().map((u) => this.lineUnit(u)), { x: fx, z: fz }) };
    }
    // The drawn curve itself, in the colour of the order it will become.
    // Routes and paths are drawn by their (smoothed) order preview; a line-formation drag also shows
    // the de-jittered curve the units are being laid along.
    this.view.overlay.setTrail(d.mode === 'line' ? simplifyPath(d.points, 5) : null, '#f4ecd4');
  }

  /** What the drag in progress will do, for the cursor label. */
  dragHint(): string | null {
    const d = this.drag;
    if (!d || !d.mode || !this.preview) return d?.mode === 'camera' ? 'Camera: drag up/down to tilt, left/right to turn' : null;
    const deploy = this.battle.phase === 'deployment';
    const type = ORDER_KEYS.find(([t]) => t === this.orderType)![2];
    const n = this.commandable().length;
    const tail = ' · release to confirm · Esc cancels';
    switch (d.mode) {
      case 'rotate': return 'Rotate: unit turns on the spot to face the drag' + tail;
      case 'path': return (deploy ? 'Place at the end of the drawn path' : `${type} along the drawn path`) + tail;
      case 'route': return (deploy ? `Place ${n} unit${n > 1 ? 's' : ''} at the route's end` : `${type}: ${n} unit${n > 1 ? 's follow' : ' follows'} the drawn route${n > 1 ? ' in parallel lanes' : ''}`) + tail;
      case 'line': return `${deploy ? 'Place' : type} ${n} units in a line along the curve (rows by role)` + tail;
      default: return null;
    }
  }

  private up(e: PointerEvent) {
    const d = this.drag;
    if (!d || e.button !== d.button) return;
    if (d.button === 0) {
      if (d.mode === 'camera') {
        // camera tilt only
      } else if (d.mode === 'route' && this.preview) this.commitPreview();
      else if (d.moved && d.mode !== 'route') this.boxSelect(d, e.shiftKey);
      else this.click(e);
    } else if (d.button === 2 && this.planning) {
      if (this.preview) this.commitPreview();
      else if (!d.moved || this.dragLength(d.points) < MIN_LINE) this.rightClick(e);
    }
    this.cancelDrag();
  }

  private click(e: PointerEvent) {
    const u = this.unitAt(e.clientX, e.clientY);
    if (!u) {
      if (!e.shiftKey) this.select([]);
      return;
    }
    if (e.shiftKey && this.selection.has(u.id)) {
      this.selection.delete(u.id);
      this.ui.onSelection([...this.selection]);
    } else this.select([u.id], e.shiftKey && u.side === this.battle.player);
  }

  /** Double-click: all on-screen allied units with the same type and formation (wiki). */
  private dblclick(e: MouseEvent) {
    const u = this.unitAt(e.clientX, e.clientY);
    if (!u || u.side !== this.battle.player) return;
    const ids = this.battle.units
      .filter((o) => o.side === u.side && o.alive && o.type.id === u.type.id && o.formation === u.formation)
      .filter((o) => {
        const p = this.view.project(o.x, this.battle.terrain.height(o.x, o.z), o.z);
        return p.visible && p.x >= 0 && p.y >= 0 && p.x <= window.innerWidth && p.y <= window.innerHeight;
      })
      .map((o) => o.id);
    this.select(ids, e.shiftKey);
  }

  private boxSelect(d: Drag, add: boolean) {
    const x0 = Math.min(d.startX, d.lastX), x1 = Math.max(d.startX, d.lastX);
    const y0 = Math.min(d.startY, d.lastY), y1 = Math.max(d.startY, d.lastY);
    const ids = this.battle.units
      .filter((u) => u.side === this.battle.player && u.alive)
      .filter((u) => {
        const p = this.view.project(u.x, this.battle.terrain.height(u.x, u.z) + 1, u.z);
        return p.visible && p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
      })
      .map((u) => u.id);
    this.select(ids, add);
  }

  // ------------------------------------------------------------ orders

  /** The order type to give a unit: Fire and Advance falls back to Walk for melee-only units (wiki). */
  private typeFor(u: Unit, t: OrderType = this.orderType): OrderType {
    if ((t === 'shoot' || t === 'fireAdvance') && !u.type.ranged) return 'walk';
    return t;
  }

  private place(id: number, x: number, z: number, facing: number, path?: XZ[]) {
    const b = this.battle;
    if (b.phase === 'deployment') {
      b.deploy(id, x, z, facing);
      return;
    }
    const u = b.unit(id);
    const type = this.typeFor(u);
    // Shoot needs a target; a ground order with Shoot selected walks instead.
    b.setOrder(id, { type: type === 'shoot' ? 'walk' : type, path: path ?? [{ x, z }], facing });
  }

  private commitPreview() {
    const p = this.preview!;
    if (p.rotate) {
      if (this.battle.phase === 'deployment') {
        const u = this.battle.unit(p.rotate.id);
        this.battle.deploy(u.id, u.x, u.z, p.rotate.facing);
      } else this.battle.setOrder(p.rotate.id, { type: 'rotate', facing: p.rotate.facing });
    } else if (p.routes) {
      for (const r of p.routes) {
        const n = r.path.length;
        if (n < 2) continue;
        const facing = Math.atan2(r.path[n - 1].z - r.path[n - 2].z, r.path[n - 1].x - r.path[n - 2].x);
        const end = r.path[n - 1];
        this.place(r.id, end.x, end.z, this.typeFor(this.battle.unit(r.id)) === 'fallback' ? facing + Math.PI : facing, r.path.slice(1));
      }
    } else if (p.placements) {
      for (const pl of p.placements) this.place(pl.id, pl.x, pl.z, pl.facing);
    }
  }

  private rightClick(e: PointerEvent) {
    const units = this.commandable();
    if (!units.length) return;
    const b = this.battle;
    const target = this.unitAt(e.clientX, e.clientY);
    if (target && b.phase === 'planning') {
      if (target.side !== b.player) {
        // Lock on: Shoot fires at it, Fire & Advance closes while firing, Walk/Run chase, Fallback backs away.
        for (const u of units) {
          const type = this.typeFor(u);
          if (type === 'shoot' && !u.type.ranged) continue;
          b.setOrder(u.id, { type, target: target.id });
        }
        return;
      }
      if (!this.selection.has(target.id) && this.orderType !== 'shoot' && this.orderType !== 'fallback') {
        // Follow a friend; several units form a marching column, each following the one before.
        const chain = [...units].sort((a, c) => Math.hypot(a.x - target.x, a.z - target.z) - Math.hypot(c.x - target.x, c.z - target.z));
        let lead = target;
        for (const u of chain) {
          b.setOrder(u.id, { type: this.typeFor(u) === 'run' ? 'run' : 'walk', follow: lead.id });
          lead = u;
        }
        return;
      }
    }
    const g = this.view.pickGround(e.clientX, e.clientY);
    if (!g) return;
    for (const pl of planClickMove(units.map((u) => this.lineUnit(u)), g)) {
      const u = b.unit(pl.id);
      this.place(pl.id, pl.x, pl.z, this.typeFor(u) === 'fallback' ? pl.facing + Math.PI : pl.facing);
    }
  }

  setOrderType(t: OrderType) {
    this.orderType = t;
    // Re-stamp the selection's drawn path orders with the new type, keeping path and facing (wiki).
    if (this.retypeSelection && this.battle.phase === 'planning') {
      for (const u of this.commandable()) {
        const o = u.order;
        if (!o?.path) continue;
        if ((t === 'shoot' || t === 'fireAdvance') && !u.type.ranged && t === 'shoot') continue;
        const type = this.typeFor(u, t);
        if (type === 'shoot') continue;
        const flip = (o.type === 'fallback') !== (type === 'fallback');
        this.battle.setOrder(u.id, { ...o, type, continued: false, facing: o.facing !== undefined && flip ? o.facing + Math.PI : o.facing });
      }
    }
    this.ui.onOrderType(t);
  }

  clearOrders() {
    for (const u of this.commandable()) this.battle.setOrder(u.id, null);
  }

  formationSlot(i: number) {
    for (const u of this.commandable()) {
      const f = u.formationSlots()[i];
      if (f) this.battle.setFormation(u.id, f);
    }
  }

  setAutofire(r: Unit['autofire']) {
    for (const u of this.commandable()) this.battle.setAutofire(u.id, r);
  }

  followSelected() {
    const first = [...this.selection][0];
    this.view.rig.follow = this.view.rig.follow === null && first !== undefined ? first : null;
  }

  // ------------------------------------------------------------ groups

  recallGroup(n: number, add = false) {
    const ids = this.groups[n].filter((id) => this.battle.unit(id).alive); // destroyed units drop out on recall
    this.groups[n] = ids;
    this.select(ids, add);
    this.ui.onGroups();
  }

  assignGroup(n: number, mode: 'set' | 'add' | 'exclusive') {
    const ids = [...this.selection].filter((id) => this.battle.unit(id).side === this.battle.player);
    if (mode === 'add') this.groups[n] = [...new Set([...this.groups[n], ...ids])];
    else this.groups[n] = ids;
    if (mode === 'exclusive') for (let k = 1; k <= 9; k++) if (k !== n) this.groups[k] = this.groups[k].filter((id) => !ids.includes(id));
    this.ui.onGroups();
  }

  saveToFreeGroup() {
    for (let k = 1; k <= 9; k++) {
      if (this.groups[k].length === 0) {
        this.assignGroup(k, 'set');
        return;
      }
    }
  }

  // ------------------------------------------------------------ keyboard

  private keydown(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement) return;
    const code = e.code;
    const digit = /^Digit([1-9])$/.exec(code);
    if (digit) {
      const n = Number(digit[1]);
      if (e.ctrlKey && e.shiftKey) this.assignGroup(n, 'exclusive');
      else if (e.ctrlKey) this.assignGroup(n, 'set');
      else if (e.altKey) this.recallGroup(n, e.shiftKey);
      else if (e.shiftKey) this.assignGroup(n, 'add');
      else if (n <= 5) this.setOrderType(ORDER_KEYS[n - 1][0]);
      e.preventDefault();
      return;
    }
    const slot = FORMATION_KEYS.indexOf(code);
    if (slot >= 0 && !e.ctrlKey && !e.altKey) {
      this.formationSlot(slot);
      return;
    }
    switch (code) {
      case 'Space':
      case 'Enter':
      case 'NumpadEnter':
        e.preventDefault();
        this.ui.endTurn();
        return;
      case 'Escape':
        if (this.drag) this.cancelDrag();
        else this.select([]);
        return;
      case 'KeyY': this.clearOrders(); return;
      case 'KeyP': this.ui.replay(); return;
      case 'KeyV': this.view.rig.toggleTopDown(); return;
      case 'KeyZ': this.followSelected(); return;
      case 'Equal': case 'NumpadAdd': this.ui.changeSpeed(1); return;
      case 'Minus': case 'NumpadSubtract': this.ui.changeSpeed(-1); return;
      case 'F1': case 'Slash': e.preventDefault(); this.ui.toggleHelp(); return;
    }
    this.keys.add(code);
  }

  // ------------------------------------------------------------ per frame

  update(dt: number) {
    const k = (c: string) => this.keys.has(c);
    const speed = 420 * dt;
    let f = 0, r = 0;
    if (k('KeyW') || k('ArrowUp')) f += speed;
    if (k('KeyS') || k('ArrowDown')) f -= speed;
    if (k('KeyD') || k('ArrowRight')) r += speed;
    if (k('KeyA') || k('ArrowLeft')) r -= speed;
    const m = 10;
    if (this.mouse.inside && !this.drag) {
      if (this.mouse.x <= m) r -= speed;
      if (this.mouse.x >= window.innerWidth - m) r += speed;
      if (this.mouse.y <= m) f += speed;
      if (this.mouse.y >= window.innerHeight - m) f -= speed;
    }
    if (f || r) this.view.rig.pan(f, r);
    if (k('KeyQ')) this.view.rig.rotate(-1.6 * dt, 0);
    if (k('KeyE')) this.view.rig.rotate(1.6 * dt, 0);
    this.view.units.setSelected(this.selection);
    this.view.units.setHover(this.hoverId);
    this.view.overlay.show(this.planning || this.battle.phase === 'ended' ? this.orderVisuals() : []);
  }

  /** Order arrows for the selection (or preview): solid for this turn, faded beyond, ghost at turn's end. */
  orderVisuals(): OrderVisual[] {
    const b = this.battle;
    const out: OrderVisual[] = [];
    const ghostOf = (u: Unit, x: number, z: number, facing: number) => ({ x, z, facing, frontage: u.frontage, depth: u.depth });
    if (this.preview) {
      const color = b.phase === 'deployment' ? ORDER_COLORS.deploy : ORDER_COLORS[this.orderType];
      if (this.preview.rotate) {
        const u = b.unit(this.preview.rotate.id);
        out.push({ now: [], later: [], color: ORDER_COLORS.rotate, ghost: ghostOf(u, u.x, u.z, this.preview.rotate.facing), arrow: false });
      }
      for (const r of this.preview.routes ?? []) {
        const u = b.unit(r.id);
        if (b.phase === 'deployment') {
          const end = r.path[r.path.length - 1];
          out.push({ now: [], later: [], color, ghost: ghostOf(u, end.x, end.z, u.facing), arrow: false });
        } else out.push(this.projectPath(u, { type: this.typeFor(u), path: r.path }, color));
      }
      for (const pl of this.preview.placements ?? []) {
        const u = b.unit(pl.id);
        out.push({ now: [{ x: u.x, z: u.z }, { x: pl.x, z: pl.z }], later: [], color, ghost: ghostOf(u, pl.x, pl.z, pl.facing), arrow: false });
      }
      return out;
    }
    for (const id of this.selection) {
      const u = b.unit(id);
      if (!u.alive || u.side !== b.player || !u.order) continue;
      const o = u.order;
      const color = o.follow !== undefined ? ORDER_COLORS.follow : ORDER_COLORS[o.type];
      if (o.type === 'rotate') out.push({ now: [], later: [], color, ghost: ghostOf(u, u.x, u.z, o.facing ?? u.facing), arrow: false });
      else if (o.target !== undefined || o.follow !== undefined) {
        const t = b.unit((o.target ?? o.follow)!);
        out.push({ now: [{ x: u.x, z: u.z }, { x: t.x, z: t.z }], later: [], color, ghost: null, arrow: false });
      } else if (o.path) out.push(this.projectPath(u, o, color));
    }
    return out;
  }

  private projectPath(u: Unit, o: Order, color: string): OrderVisual {
    const pts = [{ x: u.x, z: u.z }, ...(o.path ?? [])];
    let budget = this.battle.reach(u, o.type);
    const now: XZ[] = [pts[0]];
    let i = 1;
    let heading = u.facing;
    for (; i < pts.length; i++) {
      const a = now[now.length - 1], bb = pts[i];
      const seg = Math.hypot(bb.x - a.x, bb.z - a.z);
      heading = Math.atan2(bb.z - a.z, bb.x - a.x);
      if (seg <= budget) {
        now.push(bb);
        budget -= seg;
      } else {
        now.push({ x: a.x + ((bb.x - a.x) * budget) / seg, z: a.z + ((bb.z - a.z) * budget) / seg });
        break;
      }
    }
    const done = i >= pts.length;
    const later = done ? [] : [now[now.length - 1], ...pts.slice(i)];
    const end = now[now.length - 1];
    const back = o.type === 'fallback';
    const facing = done && o.facing !== undefined ? o.facing : back ? heading + Math.PI : heading;
    return { now, later, color, ghost: { x: end.x, z: end.z, facing, frontage: u.frontage, depth: u.depth }, arrow: !back };
  }
}
