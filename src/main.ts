import './style.css';
import { Controls } from './input/controls';
import { View } from './render/view';
import { Battle, type Frame } from './sim/battle';
import type { FormationDef, Scenario, UnitType } from './sim/types';
import { Hud, SPEEDS } from './ui/hud';

// Data is discovered by folder: new unit types, formations and scenarios need no code change.
const unitFiles = import.meta.glob<UnitType>('/data/units/*.json', { eager: true, import: 'default' });
const formFiles = import.meta.glob<FormationDef>('/data/formations/*.json', { eager: true, import: 'default' });
const scenarioFiles = import.meta.glob<Scenario>('/data/scenarios/*.json', { eager: true, import: 'default' });
const types: Record<string, UnitType> = Object.fromEntries(Object.values(unitFiles).map((t) => [t.id, t]));
const forms: Record<string, FormationDef> = Object.fromEntries(Object.values(formFiles).map((f) => [f.id, f]));
const scenarios = Object.values(scenarioFiles);
const params = new URLSearchParams(location.search);
const scenario = scenarios.find((s) => s.id === params.get('scenario')) ?? scenarios[0];

/** Real seconds per movement sub-step at 1x: a 16-tick turn plays in about 7.7 s. */
const SUB_DT = 0.12;

const app = document.getElementById('app')!;
const canvas = document.createElement('canvas');
canvas.className = 'scene';
app.append(canvas);

let battle = new Battle(scenario, types, forms);
const view = new View(canvas, battle);
let speed = 0;
let resultShown = false;
let acc = 0;
/** Replay of the last turn: index into lastTurnFrames, or null when live. */
let replayAt: number | null = null;

const resetCamera = () => view.rig.setView(320, 300, 360, Math.PI + 0.12, (50 * Math.PI) / 180);
resetCamera();

const controls: Controls = new Controls(canvas, battle, view, {
  onSelection: (ids) => hud.setSelection(ids),
  onGroups: () => hud.renderGroups(),
  onOrderType: () => {},
  endTurn: () => endTurn(),
  replay: () => startReplay(),
  changeSpeed: (d) => (speed = Math.max(0, Math.min(SPEEDS.length - 1, speed + d))),
  toggleHelp: () => hud.toggleHelp(),
});

const hud: Hud = new Hud(app, battle, scenario, controls, {
  endTurn: () => endTurn(),
  replay: () => startReplay(),
  setSpeed: (i) => (speed = i),
  restart: () => restart(),
  select: (ids) => controls.select(ids),
});

function endTurn() {
  if (hud.dialogOpen || replayAt !== null || battle.phase === 'resolving' || battle.result) return;
  battle.endTurn();
  acc = 0;
}

function startReplay() {
  if (battle.phase === 'resolving' || battle.lastTurnFrames.length < 2) return;
  replayAt = 0;
  hud.mode = 'replay';
}

function restart() {
  battle = new Battle(scenario, types, forms);
  view.setBattle(battle);
  controls.setBattle(battle);
  hud.setBattle(battle);
  resultShown = false;
  replayAt = null;
  hud.mode = 'live';
  resetCamera();
}

window.addEventListener('resize', () => view.resize());
const lastMouse = { x: 0, y: 0 };
window.addEventListener('pointermove', (e) => {
  lastMouse.x = e.clientX;
  lastMouse.y = e.clientY;
});

let last = performance.now();
let hudTimer = 0;
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  let a: Frame, b: Frame, alpha = 1;
  if (replayAt !== null) {
    const frames = battle.lastTurnFrames;
    const before = Math.floor(replayAt);
    if (!hud.dialogOpen) replayAt += (dt * SPEEDS[speed]) / SUB_DT;
    const i = Math.min(frames.length - 2, Math.floor(replayAt));
    for (let k = before + 1; k <= Math.min(i + 1, frames.length - 1); k++) view.spawnVolleys(frames[k].volleys);
    a = frames[i];
    b = frames[i + 1];
    alpha = Math.min(1, replayAt - i);
    if (replayAt >= frames.length - 1) {
      replayAt = null;
      hud.mode = 'live';
    }
  } else if (battle.phase === 'resolving') {
    if (!hud.dialogOpen) acc += dt * SPEEDS[speed];
    let steps = 0;
    while (acc >= SUB_DT && steps < 10 && battle.phase === 'resolving') {
      battle.stepSub();
      const f = battle.frames[battle.frames.length - 1];
      view.spawnVolleys(f.volleys);
      acc -= SUB_DT;
      steps++;
    }
    if (battle.phase === 'resolving') {
      const n = battle.frames.length;
      a = battle.frames[Math.max(0, n - 2)];
      b = battle.frames[n - 1];
      alpha = Math.min(1, acc / SUB_DT);
    } else {
      a = b = battle.snapshot();
    }
  } else {
    a = b = battle.snapshot();
  }
  controls.update(dt);
  const selected = [...controls.selection].map((id) => battle.unit(id));
  view.frame(a.units, b.units, alpha, dt, now / 1000, selected);
  hudTimer -= dt;
  if (hudTimer <= 0) {
    hudTimer = 0.12;
    hud.update(speed, replayAt !== null);
  }
  const hover = controls.hoverId !== null ? battle.unit(controls.hoverId) : null;
  const dragHint = controls.dragHint();
  hud.showDragHint(dragHint, lastMouse.x, lastMouse.y);
  hud.showTooltip(hover && hover.alive && !dragHint ? hover : null, lastMouse.x, lastMouse.y);
  if (battle.result && !resultShown && battle.phase === 'ended') {
    resultShown = true;
    hud.update(speed, false);
    hud.showResult();
  }
  requestAnimationFrame(frame);
}

if (params.get('brief') !== '0') hud.showBriefing();
requestAnimationFrame(frame);

// Handle for automated browser tests and console debugging.
(window as unknown as { __game: unknown }).__game = {
  get battle() { return battle; },
  view, controls, hud,
  setSpeed: (i: number) => (speed = i),
  endTurn,
  get replaying() { return replayAt !== null; },
};
