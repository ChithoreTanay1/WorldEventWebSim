// Campaign mode: map input, the turn cycle (plan, march, battles) and the hand-off to the battle
// engine. Taking command of a battle dives the camera into the spot where the armies met, fades,
// and opens a BattleSession; leaving it fades back to the same spot and pulls out again.
import { BattleSession } from '../battleSession';
import { perf } from '../perf';
import type { Battle } from '../sim/battle';
import type { FormationDef, Rules, UnitType } from '../sim/types';
import { Campaign, type BattleOutcome, type Encounter } from './campaign';
import { MapView } from './mapView';
import { battleOutcome, buildScenario } from './toScenario';
import type { CampaignData, CampaignState } from './types';
import { CampaignHud } from './ui';

const SAVE_KEY = 'gupta-campaign-v1';
/** Map units per second while armies march. */
const MARCH_SPEED = 240;
const STEP = 3;

type Phase = 'planning' | 'moving' | 'battles' | 'battle' | 'over';
const PHASE_LABEL: Record<Phase, string> = {
  planning: 'Your orders', moving: 'Armies on the march', battles: 'Battles', battle: 'In battle', over: 'The war is over',
};

export class CampaignMode {
  readonly c: Campaign;
  readonly view: MapView;
  readonly hud: CampaignHud;
  readonly canvas: HTMLCanvasElement;
  phase: Phase = 'planning';
  session: BattleSession | null = null;
  private keys = new Set<string>();
  private drag: { x: number; y: number; moved: boolean; button: number } | null = null;
  private mouse = { x: -1, y: -1 };
  private hudTimer = 0;
  private marchBudget = 0;
  /** Reused projection result for per-frame hover picking. */
  private readonly pt = { x: 0, y: 0, visible: false };

  constructor(
    private readonly host: HTMLElement,
    data: CampaignData,
    private readonly types: Record<string, UnitType>,
    private readonly forms: Record<string, FormationDef>,
    private readonly rules: Rules,
  ) {
    const saved = load(data);
    this.c = new Campaign(data, types, saved ?? Campaign.fresh(data));
    this.c.prepareTurn();
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'scene';
    host.append(this.canvas);
    this.view = new MapView(this.canvas, this.c);
    perf.renderer = this.view.renderer;
    this.hud = new CampaignHud(host, this.c, this.view, {
      endTurn: () => this.endTurn(),
      newCampaign: () => this.newCampaign(),
      select: (id) => this.select(id),
      recruit: (town, type) => this.phase === 'planning' && this.c.queueRecruit(this.c.player, town, type),
      cancelRecruit: (town, slot) => this.phase === 'planning' && this.c.cancelRecruit(town, slot),
      split: (id, units) => {
        const a = this.c.army(id);
        if (this.phase !== 'planning' || !a || a.faction !== this.c.player) return;
        const b = this.c.split(a, units);
        if (b) this.select(b.id);
      },
      merge: (into, from) => {
        const a = this.c.army(into), b = this.c.army(from);
        if (this.phase !== 'planning' || !a || !b || a.faction !== this.c.player) return;
        this.c.merge(a, b);
      },
    });
    this.bindInput();
    const mine = this.c.armiesOf(this.c.player)[0];
    if (mine) {
      const p = this.c.armyPos(mine);
      this.view.cam.set(p.x, p.z + 60, 620);
      this.select(mine.id);
    }
    if (this.c.state.winner) this.phase = 'over';
    if (!saved) this.hud.showBriefing();
  }

  // ---------------------------------------------------------------- input

  private bindInput() {
    const cv = this.canvas;
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', (e) => {
      if (this.session) return;
      this.drag = { x: e.clientX, y: e.clientY, moved: false, button: e.button };
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', (e) => {
      this.mouse = { x: e.clientX, y: e.clientY };
      const d = this.drag;
      if (!d) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 5) return;
      d.moved = true;
      // Grab-and-drag panning, scaled so the ground follows the cursor.
      const k = this.view.cam.zoomDistance / (this.canvas.clientHeight || 800) * 1.1;
      this.view.cam.pan(-dx * k, -dy * k * 1.3);
      d.x = e.clientX;
      d.y = e.clientY;
    });
    cv.addEventListener('pointerup', (e) => {
      const d = this.drag;
      this.drag = null;
      if (!d || d.moved || this.session) return;
      if (d.button === 0) this.leftClick(e.clientX, e.clientY);
      else if (d.button === 2) this.rightClick(e.clientX, e.clientY);
    });
    cv.addEventListener('pointerleave', () => (this.mouse = { x: -1, y: -1 }));
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.session) return;
      this.view.cam.zoom(Math.exp(e.deltaY * 0.0012), this.view.pickGround(e.clientX, e.clientY) ?? undefined);
    }, { passive: false });
    window.addEventListener('keydown', (e) => {
      if (this.session) return;
      if (e.target instanceof HTMLInputElement) return;
      this.keys.add(e.code);
      if (this.hud.dialogOpen) {
        if (e.code === 'Escape' || e.code === 'F1') this.hud.close();
        return;
      }
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        this.endTurn();
      } else if (e.code === 'Escape') this.select(null);
      else if (e.code === 'KeyH') this.halt();
      else if (e.code === 'Tab') {
        e.preventDefault();
        this.cycle();
      } else if (e.code === 'F1') {
        e.preventDefault();
        this.hud.showHelp();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('resize', () => this.view.resize());
  }

  /** Army under the cursor (its standard, in screen space), else null. */
  private armyAt(x: number, y: number): number | null {
    let best: number | null = null, bd = 26;
    const s = this.view.markerScale;
    for (const a of this.c.armies) {
      const p = this.view.tokenPos(a.id);
      if (!p) continue;
      // Test the base and the banner, the two parts people aim at.
      for (let part = 0; part < 2; part++) {
        const yo = part === 0 ? 2 : 14 * s;
        const q = this.view.project(p.x, p.y + yo, p.z, this.pt);
        const d = Math.hypot(q.x - x, q.y - y);
        if (q.visible && d < bd) (bd = d), (best = a.id);
      }
    }
    return best;
  }

  private townAt(x: number, y: number): string | null {
    let best: string | null = null, bd = 30;
    for (const [id, p] of Object.entries(this.c.pos)) {
      const q = this.view.project(p.x, this.c.geo.height(p.x, p.z) + 4, p.z, this.pt);
      const d = Math.hypot(q.x - x, q.y - y);
      if (q.visible && d < bd) (bd = d), (best = id);
    }
    if (best) return best;
    const g = this.view.pickGround(x, y);
    if (!g) return null;
    const n = this.c.nearestSettlement(g.x, g.z);
    return Math.hypot(this.c.pos[n].x - g.x, this.c.pos[n].z - g.z) < 40 ? n : null;
  }

  private leftClick(x: number, y: number) {
    if (this.hud.dialogOpen) return;
    const army = this.armyAt(x, y);
    if (army !== null) return this.select(army);
    this.select(null);
    this.view.selectedTown = this.townAt(x, y);
  }

  private rightClick(x: number, y: number) {
    if (this.phase !== 'planning' || this.hud.dialogOpen) return;
    const a = this.view.selected !== null ? this.c.army(this.view.selected) : undefined;
    if (!a || a.faction !== this.c.player) return;
    const target = this.armyAt(x, y);
    const t = target !== null ? this.c.army(target) : undefined;
    let dest: string | null = null;
    if (t && t !== a) {
      // March on another army (to fight it, or to join it): head for the town it is nearest along its road.
      dest = t.to && t.progress > this.c.roadLen(t.from, t.to) / 2 ? t.to : t.from;
    } else dest = this.townAt(x, y);
    if (dest) this.c.setDestination(a, dest);
  }

  private select(id: number | null) {
    this.view.selected = id;
    this.view.selectedTown = null;
  }

  private halt() {
    const a = this.view.selected !== null ? this.c.army(this.view.selected) : undefined;
    if (a && a.faction === this.c.player && this.phase === 'planning') this.c.stop(a);
  }

  private cycle() {
    const mine = this.c.armiesOf(this.c.player);
    if (!mine.length) return;
    const i = mine.findIndex((a) => a.id === this.view.selected);
    const a = mine[(i + 1) % mine.length];
    this.select(a.id);
    const p = this.c.armyPos(a);
    this.view.cam.target = { x: p.x, z: p.z + 40 };
  }

  // ---------------------------------------------------------------- turn cycle

  private endTurn() {
    if (this.phase !== 'planning' || this.hud.dialogOpen) return;
    this.c.beginMovement();
    this.phase = 'moving';
    this.marchBudget = 0;
  }

  private async runBattles() {
    this.phase = 'battles';
    for (const enc of this.c.encounters) {
      if (!this.c.army(enc.player) || !this.c.army(enc.enemy)) continue;
      this.view.cam.flyTo(enc.x, enc.z + 30, 380, 0.8);
      const choice = await this.hud.askBattle(enc);
      const p = this.c.army(enc.player)!, e = this.c.army(enc.enemy)!;
      const before = new Map([p, e].map((a) => [a.id, { name: a.name, units: a.units.length, power: this.c.power(a) }]));
      const out = choice === 'fight' ? await this.fight(enc) : this.c.autoResolve(enc);
      this.c.applyOutcome(enc, out);
      this.view.refreshOwners();
      const lines: [string, string][] = [...before].map(([id, b]) => {
        const a = this.c.army(id);
        if (!a) return [b.name, 'destroyed'];
        const lost = b.units - a.units.length;
        return [b.name, `${Math.round((1 - this.c.power(a) / b.power) * 100)}% strength lost${lost ? `, ${lost} unit${lost > 1 ? 's' : ''} gone` : ''}`];
      });
      await this.hud.showOutcome(`Battle near ${this.c.names[enc.place]}`, out.winner === null ? null : out.winner === this.c.player, lines);
    }
    this.c.finishTurn();
    this.view.refreshOwners();
    save(this.c.state);
    if (this.c.state.winner) {
      this.phase = 'over';
      this.hud.showEnd(this.c.state.winner === this.c.player);
    } else this.phase = 'planning';
  }

  /** Dive into the battlefield, play the battle, come back up with the result. */
  private async fight(enc: Encounter): Promise<BattleOutcome> {
    const cb = buildScenario(this.c, enc, this.rules);
    this.phase = 'battle';
    this.hud.tooltip.style.display = 'none';
    await this.view.cam.flyTo(enc.x, enc.z, 75, 1.3);
    await this.hud.setFade(true, 0.35);
    this.canvas.style.display = 'none';
    this.hud.setVisible(false);
    const battle = await new Promise<Battle>((done) => {
      this.session = new BattleSession(this.host, cb.scenario, this.types, this.forms, {
        showBriefing: true,
        descend: true,
        exit: (b) => done(b),
      });
      this.hud.fade.style.opacity = '0';
      this.host.append(this.hud.fade);
      void this.hud.setFade(false, 0.6);
    });
    const out = battleOutcome(cb, battle);
    await this.hud.setFade(true, 0.35);
    this.session!.dispose();
    this.session = null;
    perf.renderer = this.view.renderer;
    this.canvas.style.display = '';
    this.hud.setVisible(true);
    this.hud.root.append(this.hud.fade);
    this.view.resize();
    this.view.cam.set(enc.x, enc.z, 75);
    void this.hud.setFade(false, 0.5);
    await this.view.cam.flyTo(enc.x, enc.z + 30, 420, 1.4);
    this.phase = 'battles';
    return out;
  }

  private newCampaign() {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {
      /* storage may be blocked */
    }
    this.c.state = Campaign.fresh(this.c.data);
    this.c.prepareTurn();
    this.c.encounters = [];
    this.view.reset();
    this.phase = 'planning';
    const mine = this.c.armiesOf(this.c.player)[0];
    if (mine) {
      const p = this.c.armyPos(mine);
      this.view.cam.set(p.x, p.z + 60, 620);
      this.select(mine.id);
    }
    this.hud.showBriefing();
  }

  // ---------------------------------------------------------------- frame

  frame(dt: number, now: number) {
    if (this.session) {
      this.session.frame(dt, now);
      return;
    }
    if (this.phase === 'moving') {
      const t0 = performance.now();
      this.marchBudget += dt * MARCH_SPEED;
      let moving = true;
      while (this.marchBudget >= STEP && moving) {
        moving = this.c.stepMovement(STEP);
        this.marchBudget -= STEP;
      }
      if (!moving) {
        this.view.refreshOwners();
        void this.runBattles();
      }
      perf.add('march', performance.now() - t0);
    }
    this.panWithKeys(dt);
    let t = performance.now();
    const hover = this.mouse.x >= 0 && !this.hud.dialogOpen && !this.drag ? this.armyAt(this.mouse.x, this.mouse.y) : null;
    this.view.hovered = hover;
    perf.add('input', performance.now() - t);
    this.view.frame(dt, now / 1000);
    t = performance.now();
    this.hud.updateLabels();
    perf.add('labels', performance.now() - t);
    t = performance.now();
    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.1;
      this.hud.update(PHASE_LABEL[this.phase]);
    }
    this.hud.showTooltip(this.tooltipText(hover), this.mouse.x, this.mouse.y);
    perf.add('hud', performance.now() - t);
  }

  private tooltipText(hover: number | null): string | null {
    if (this.mouse.x < 0 || this.hud.dialogOpen || this.drag) return null;
    if (hover !== null) {
      const a = this.c.army(hover)!;
      return `${a.name} · ${this.c.data.factions[a.faction].name} · ${a.units.length} units`;
    }
    const t = this.townAt(this.mouse.x, this.mouse.y);
    if (!t) return null;
    const s = this.c.data.settlements.find((x) => x.id === t)!;
    const owner = this.c.data.factions[this.c.state.owners[t]];
    const q = this.c.recruitsAt(t).filter((r) => r.faction === this.c.player).length;
    const raising = q ? ` · raising ${q} unit${q > 1 ? 's' : ''}` : '';
    return `${s.name} · held by ${owner?.name ?? 'nobody'}${raising}${s.note ? ` · ${s.note}` : ''}`;
  }

  private panWithKeys(dt: number) {
    let fx = 0, fz = 0;
    const k = this.keys;
    if (k.has('KeyW') || k.has('ArrowUp')) fz -= 1;
    if (k.has('KeyS') || k.has('ArrowDown')) fz += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) fx -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) fx += 1;
    if (!fx && !fz) return;
    const speed = this.view.cam.zoomDistance * 1.1 * dt;
    this.view.cam.pan(fx * speed, fz * speed);
  }
}

function load(data: CampaignData): CampaignState | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const st = JSON.parse(raw) as CampaignState;
    return st.version === 1 && st.dataId === data.id ? st : null;
  } catch {
    return null;
  }
}

function save(st: CampaignState) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(st));
  } catch {
    /* storage may be blocked or full: the campaign still plays, it just won't survive a reload */
  }
}
