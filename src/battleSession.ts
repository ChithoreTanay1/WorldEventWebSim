// One battle on screen: canvas, view, controls and HUD around a Battle, plus the per-frame loop that
// resolves turns and plays replays. Created when a battle starts and disposed when it ends, so the
// campaign map can open as many battles as it likes.
import { Controls } from './input/controls';
import { View } from './render/view';
import { Battle, type Frame } from './sim/battle';
import type { FormationDef, Scenario, UnitType } from './sim/types';
import { Hud, SPEEDS } from './ui/hud';
import { perf } from './perf';

/** Real seconds per movement sub-step at 1x: a 16-tick turn plays in about 7.7 s. */
const SUB_DT = 0.12;

export interface SessionOptions {
  showBriefing: boolean;
  /** Campaign battles: called when the player leaves the finished battle. */
  exit?: (battle: Battle) => void;
  /** Start with the camera high above the field and let it settle (the zoom-in from the campaign map). */
  descend?: boolean;
}

export class BattleSession {
  battle: Battle;
  readonly root: HTMLDivElement;
  readonly view: View;
  readonly controls: Controls;
  readonly hud: Hud;
  speed = 0;
  private resultShown = false;
  private acc = 0;
  /** Replay of the last turn: index into lastTurnFrames, or null when live. */
  private replayAt: number | null = null;
  private hudTimer = 0;
  private readonly lastMouse = { x: 0, y: 0 };
  private readonly abort = new AbortController();

  constructor(
    host: HTMLElement,
    private readonly scenario: Scenario,
    private readonly types: Record<string, UnitType>,
    private readonly forms: Record<string, FormationDef>,
    opts: SessionOptions,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'battle-root';
    host.append(this.root);
    const canvas = document.createElement('canvas');
    canvas.className = 'scene';
    this.root.append(canvas);

    this.battle = new Battle(scenario, types, forms);
    this.view = new View(canvas, this.battle);
    this.controls = new Controls(canvas, this.battle, this.view, {
      onSelection: (ids) => this.hud.setSelection(ids),
      onGroups: () => this.hud.renderGroups(),
      onOrderType: () => {},
      endTurn: () => this.endTurn(),
      replay: () => this.startReplay(),
      changeSpeed: (d) => (this.speed = Math.max(0, Math.min(SPEEDS.length - 1, this.speed + d))),
      toggleHelp: () => this.hud.toggleHelp(),
    });
    const exit = opts.exit;
    this.hud = new Hud(this.root, this.battle, scenario, this.controls, {
      endTurn: () => this.endTurn(),
      replay: () => this.startReplay(),
      setSpeed: (i) => (this.speed = i),
      restart: () => this.restart(),
      select: (ids) => this.controls.select(ids),
      exit: exit ? () => exit(this.battle) : undefined,
    });
    this.resetCamera();
    perf.renderer = this.view.renderer;
    if (opts.descend) {
      // Snap high above the field, then let the rig's smoothing carry the camera down.
      const { x, z } = this.homeView();
      this.view.rig.setView(x, z, 720, Math.PI + 0.12, (80 * Math.PI) / 180);
      this.view.rig.distance = 360;
      this.view.rig.pitch = (50 * Math.PI) / 180;
    }
    const { signal } = this.abort;
    window.addEventListener('resize', () => this.view.resize(), { signal });
    window.addEventListener('pointermove', (e) => {
      this.lastMouse.x = e.clientX;
      this.lastMouse.y = e.clientY;
    }, { signal });
    if (opts.showBriefing) this.hud.showBriefing();
  }

  /** Look at the middle of the player's deployment zone. */
  private homeView(): { x: number; z: number } {
    const zone = this.battle.sides.get(this.battle.player)!.zone;
    return { x: (zone[0] + zone[2]) / 2 + 150, z: (zone[1] + zone[3]) / 2 };
  }

  private resetCamera() {
    const { x, z } = this.homeView();
    this.view.rig.setView(x, z, 360, Math.PI + 0.12, (50 * Math.PI) / 180);
  }

  get replaying(): boolean {
    return this.replayAt !== null;
  }

  endTurn() {
    if (this.hud.dialogOpen || this.replayAt !== null || this.battle.phase === 'resolving' || this.battle.result) return;
    this.battle.endTurn();
    this.acc = 0;
  }

  private startReplay() {
    if (this.battle.phase === 'resolving' || this.battle.lastTurnFrames.length < 2) return;
    this.replayAt = 0;
    this.hud.mode = 'replay';
  }

  private restart() {
    this.battle = new Battle(this.scenario, this.types, this.forms);
    this.view.setBattle(this.battle);
    this.controls.setBattle(this.battle);
    this.hud.setBattle(this.battle);
    this.resultShown = false;
    this.replayAt = null;
    this.hud.mode = 'live';
    this.resetCamera();
  }

  frame(dt: number, now: number) {
    const { battle, view, hud, controls } = this;
    let a: Frame, b: Frame, alpha = 1;
    let t = performance.now();
    if (this.replayAt !== null) {
      const frames = battle.lastTurnFrames;
      const before = Math.floor(this.replayAt);
      if (!hud.dialogOpen) this.replayAt += (dt * SPEEDS[this.speed]) / SUB_DT;
      const i = Math.min(frames.length - 2, Math.floor(this.replayAt));
      for (let k = before + 1; k <= Math.min(i + 1, frames.length - 1); k++) view.spawnVolleys(frames[k].volleys);
      a = frames[i];
      b = frames[i + 1];
      alpha = Math.min(1, this.replayAt - i);
      if (this.replayAt >= frames.length - 1) {
        this.replayAt = null;
        hud.mode = 'live';
      }
    } else if (battle.phase === 'resolving') {
      if (!hud.dialogOpen) this.acc += dt * SPEEDS[this.speed];
      let steps = 0;
      while (this.acc >= SUB_DT && steps < 10 && battle.phase === 'resolving') {
        battle.stepSub();
        const f = battle.frames[battle.frames.length - 1];
        view.spawnVolleys(f.volleys);
        this.acc -= SUB_DT;
        steps++;
      }
      if (battle.phase === 'resolving') {
        const n = battle.frames.length;
        a = battle.frames[Math.max(0, n - 2)];
        b = battle.frames[n - 1];
        alpha = Math.min(1, this.acc / SUB_DT);
      } else {
        a = b = battle.snapshot();
      }
    } else {
      a = b = battle.snapshot();
    }
    perf.add('sim', performance.now() - t);
    t = performance.now();
    controls.update(dt);
    perf.add('controls', performance.now() - t);
    const selected = [...controls.selection].map((id) => battle.unit(id));
    view.frame(a.units, b.units, alpha, dt, now / 1000, selected);
    t = performance.now();
    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.12;
      hud.update(this.speed, this.replayAt !== null);
    }
    const hover = controls.hoverId !== null ? battle.unit(controls.hoverId) : null;
    const dragHint = controls.dragHint();
    hud.showDragHint(dragHint, this.lastMouse.x, this.lastMouse.y);
    hud.showTooltip(hover && hover.alive && !dragHint ? hover : null, this.lastMouse.x, this.lastMouse.y);
    perf.add('hud', performance.now() - t);
    if (battle.result && !this.resultShown && battle.phase === 'ended') {
      this.resultShown = true;
      hud.update(this.speed, false);
      hud.showResult();
    }
  }

  dispose() {
    this.abort.abort();
    this.controls.dispose();
    this.view.dispose();
    this.root.remove();
  }
}
