// Mouse and keyboard. Buttons never overlap: left = select, right = orders, middle = rotate,
// wheel = zoom, WASD/arrows = pan, Q/E = rotate. Orders are allowed while paused.
import type { Battle } from '../sim/battle';
import { deg } from '../sim/geometry';
import type { Stance } from '../sim/types';
import type { Unit } from '../sim/unit';
import type { View } from '../render/view';
import type { OrderVisual } from '../render/overlay';
import { planClickMove, planLine, type LinePlan, type LineUnit, type XZ } from './formation';

export interface ControlHandlers {
  onSelection(ids: number[]): void;
  togglePause(): void;
  changeSpeed(delta: number): void;
  toggleHelp(): void;
}

interface Drag {
  button: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
  points: XZ[];
}

const DRAG_PX = 6;
const MIN_LINE = 4;

export class Controls {
  selection = new Set<number>();
  readonly groups: number[][] = Array.from({ length: 10 }, () => []);
  hoverId: number | null = null;
  private keys = new Set<string>();
  private drag: Drag | null = null;
  private preview: LinePlan[] | null = null;
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
    // Native dblclick uses OS input timing, so it still works when frames are slow.
    canvas.addEventListener('dblclick', (e) => {
      const u = this.unitAt(e.clientX, e.clientY);
      if (u && u.side === this.battle.player) {
        this.select(this.battle.units.filter((o) => o.side === u.side && o.alive && o.type.id === u.type.id).map((o) => o.id), e.shiftKey);
      }
    });
    canvas.addEventListener('pointerenter', () => (this.mouse.inside = true));
    canvas.addEventListener('pointerleave', () => (this.mouse.inside = false));
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.view.rig.zoom(Math.exp(e.deltaY * 0.0012));
    }, { passive: false });
    window.addEventListener('keydown', (e) => this.keydown(e));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  setBattle(b: Battle) {
    this.battle = b;
    this.selection.clear();
    this.groups.forEach((g) => (g.length = 0));
    this.cancelDrag();
    this.ui.onSelection([]);
  }

  // ------------------------------------------------------------ helpers

  private mine(): Unit[] {
    return [...this.selection].map((id) => this.battle.unit(id)).filter((u) => u.side === this.battle.player && u.controllable);
  }

  private lineUnit(u: Unit): LineUnit {
    return {
      id: u.id, x: u.x, z: u.z, facing: u.facing, frontage: u.frontage, spacing: u.type.spacing[0],
      filesRange: u.filesRange(), speed: u.type.speed, turnRate: deg(u.type.turnRate),
    };
  }

  /** Unit under the cursor: footprint test on the ground, or nearest marker when zoomed out. */
  unitAt(clientX: number, clientY: number): Unit | null {
    const live = this.battle.units.filter((u) => u.alive);
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
    const radius = this.view.units.markerMode ? 28 : 16;
    bd = radius;
    for (const u of live) {
      const p = this.view.project(u.x, this.battle.terrain.height(u.x, u.z) + 2, u.z);
      const d = Math.hypot(p.x - clientX, p.y - clientY);
      if (p.visible && d < bd) (bd = d), (best = u);
    }
    return best;
  }

  private select(ids: number[], add: boolean) {
    if (!add) this.selection.clear();
    for (const id of ids) this.selection.add(id);
    // Enemy units can be inspected, but only alone.
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
    this.drag = { button: e.button, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false, points: [] };
    if (e.button === 2) {
      const g = this.view.pickGround(e.clientX, e.clientY);
      if (g) this.drag.points.push(g);
    }
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
    if (d.button === 1) {
      this.view.rig.rotate((e.clientX - d.lastX) * 0.006, (e.clientY - d.lastY) * 0.004);
    } else if (d.button === 0 && d.moved) {
      const x = Math.min(d.startX, e.clientX), y = Math.min(d.startY, e.clientY);
      Object.assign(this.box.style, { display: 'block', left: `${x}px`, top: `${y}px`, width: `${Math.abs(e.clientX - d.startX)}px`, height: `${Math.abs(e.clientY - d.startY)}px` });
    } else if (d.button === 2) {
      const g = this.view.pickGround(e.clientX, e.clientY);
      const last = d.points[d.points.length - 1];
      if (g && (!last || Math.hypot(g.x - last.x, g.z - last.z) > 1.5)) d.points.push(g);
      const units = this.mine();
      if (units.length && d.points.length >= 2 && this.trailLength(d.points) >= MIN_LINE) {
        const { fx, fz } = this.view.rig.groundAxes();
        this.preview = planLine(d.points, units.map((u) => this.lineUnit(u)), { x: fx, z: fz });
        this.view.overlay.setTrail(d.points);
      }
    }
    d.lastX = e.clientX;
    d.lastY = e.clientY;
  }

  private trailLength(p: XZ[]): number {
    let L = 0;
    for (let i = 1; i < p.length; i++) L += Math.hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z);
    return L;
  }

  private up(e: PointerEvent) {
    const d = this.drag;
    if (!d || e.button !== d.button) return;
    if (d.button === 0) {
      if (d.moved) this.boxSelect(d, e.shiftKey);
      else this.click(e);
    } else if (d.button === 2) {
      if (this.preview && this.preview.length) this.commit(this.preview, e.altKey);
      else if (!d.moved) this.rightClick(e);
    }
    this.cancelDrag();
  }

  private click(e: PointerEvent) {
    const u = this.unitAt(e.clientX, e.clientY);
    if (!u) {
      if (!e.shiftKey) this.select([], false);
      return;
    }
    if (e.shiftKey && this.selection.has(u.id)) {
      this.selection.delete(u.id);
      this.ui.onSelection([...this.selection]);
    } else {
      this.select([u.id], e.shiftKey && u.side === this.battle.player);
    }
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

  private rightClick(e: PointerEvent) {
    const units = this.mine();
    if (!units.length) return;
    const target = this.unitAt(e.clientX, e.clientY);
    if (target && target.side !== this.battle.player) {
      for (const u of units) this.battle.orderAttack(u.id, target.id, e.altKey || u.stance === 'charge');
      return;
    }
    const g = this.view.pickGround(e.clientX, e.clientY);
    if (!g) return;
    this.commit(planClickMove(units.map((u) => this.lineUnit(u)), g), e.altKey);
  }

  private commit(plans: LinePlan[], run: boolean) {
    for (const p of plans) {
      const u = this.battle.unit(p.id);
      if (u.stance === 'advance' || u.stance === 'charge') this.battle.setStance(u.id, 'hold');
      this.battle.orderMove(p.id, p.slot, p.speedScale, run);
    }
  }

  // ------------------------------------------------------------ keyboard

  stance(s: Stance) {
    for (const u of this.mine()) this.battle.setStance(u.id, s);
  }

  toggleFire() {
    const units = this.mine().filter((u) => u.type.range);
    const on = !units.every((u) => u.fireAtWill);
    for (const u of units) this.battle.setFireAtWill(u.id, on);
  }

  halt() {
    for (const u of this.mine()) this.battle.halt(u.id);
  }

  followSelected() {
    const first = [...this.selection][0];
    this.view.rig.follow = this.view.rig.follow === null && first !== undefined ? first : null;
  }

  private keydown(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement) return;
    const code = e.code;
    const digit = /^Digit([1-9])$/.exec(code);
    if (digit) {
      const n = Number(digit[1]);
      if (e.altKey || e.ctrlKey) {
        e.preventDefault();
        this.groups[n] = this.mine().map((u) => u.id);
      } else {
        this.select(this.groups[n].filter((id) => this.battle.unit(id).alive), e.shiftKey);
      }
      return;
    }
    switch (code) {
      case 'Space': e.preventDefault(); this.ui.togglePause(); return;
      case 'Escape':
        if (this.drag) this.cancelDrag();
        else this.select([], false);
        return;
      case 'KeyH': this.stance('hold'); return;
      case 'KeyG': this.stance('advance'); return;
      case 'KeyC': this.stance('charge'); return;
      case 'KeyX': this.stance('withdraw'); return;
      case 'KeyF': this.toggleFire(); return;
      case 'Backspace': case 'Delete': e.preventDefault(); this.halt(); return;
      case 'KeyT': this.view.rig.toggleTopDown(); return;
      case 'KeyY': this.followSelected(); return;
      case 'Equal': case 'NumpadAdd': this.ui.changeSpeed(1); return;
      case 'Minus': case 'NumpadSubtract': this.ui.changeSpeed(-1); return;
      case 'F1': case 'Slash': e.preventDefault(); this.ui.toggleHelp(); return;
      case 'KeyA':
        if (e.ctrlKey) {
          e.preventDefault();
          this.select(this.battle.units.filter((u) => u.side === this.battle.player && u.alive).map((u) => u.id), false);
          return;
        }
    }
    this.keys.add(code);
  }

  /** Per-frame: camera keys, edge scroll, and the order-line overlay. */
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
    this.view.overlay.show(this.orderVisuals());
  }

  private orderVisuals(): OrderVisual[] {
    const out: OrderVisual[] = [];
    if (this.preview) {
      for (const p of this.preview) {
        const u = this.battle.unit(p.id);
        out.push({
          fromX: u.x, fromZ: u.z, toX: p.slot.x, toZ: p.slot.z, facing: p.slot.facing,
          frontage: p.slot.files * u.type.spacing[0], depth: Math.ceil(u.men / p.slot.files) * u.type.spacing[1], kind: 'preview',
        });
      }
      return out;
    }
    for (const id of this.selection) {
      const u = this.battle.unit(id);
      if (!u.alive || u.side !== this.battle.player) continue;
      const o = u.order;
      if (o?.kind === 'move') {
        out.push({ fromX: u.x, fromZ: u.z, toX: o.x, toZ: o.z, facing: o.facing, frontage: o.files * u.type.spacing[0], depth: u.depth, kind: 'move' });
      } else if (o?.kind === 'attack') {
        const t = this.battle.unit(o.target);
        out.push({ fromX: u.x, fromZ: u.z, toX: t.x, toZ: t.z, facing: null, frontage: 0, depth: 0, kind: 'attack' });
      }
    }
    return out;
  }
}
