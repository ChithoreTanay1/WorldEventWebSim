import './style.css';
import { Controls } from './input/controls';
import { View } from './render/view';
import { Battle, DT } from './sim/battle';
import type { Scenario, UnitType } from './sim/types';
import { Hud, SPEEDS } from './ui/hud';

// Data is discovered by folder: adding a unit type or scenario needs no code change.
const unitFiles = import.meta.glob<UnitType>('/data/units/*.json', { eager: true, import: 'default' });
const scenarioFiles = import.meta.glob<Scenario>('/data/scenarios/*.json', { eager: true, import: 'default' });
const types: Record<string, UnitType> = Object.fromEntries(Object.values(unitFiles).map((t) => [t.id, t]));
const scenarios = Object.values(scenarioFiles);
const wanted = new URLSearchParams(location.search).get('scenario');
const scenario = scenarios.find((s) => s.id === wanted) ?? scenarios[0];

const app = document.getElementById('app')!;
const canvas = document.createElement('canvas');
canvas.className = 'scene';
app.append(canvas);

let battle = new Battle(scenario, types);
const view = new View(canvas, battle);
let paused = true;
let speed = 0;
let resultShown = false;

const resetCamera = () => view.rig.setView(330, 300, 330, Math.PI + 0.12, (46 * Math.PI) / 180);
resetCamera();

const hud: Hud = new Hud(app, battle, scenario, {
  togglePause: () => togglePause(),
  setSpeed: (i) => (speed = i),
  stance: (s) => controls.stance(s),
  toggleFire: () => controls.toggleFire(),
  halt: () => controls.halt(),
  topDown: () => view.rig.toggleTopDown(),
  follow: () => controls.followSelected(),
  select: (id) => {
    controls.selection = new Set([id]);
    hud.setSelection([id]);
  },
  restart: () => restart(),
  begin: () => {},
});

const controls: Controls = new Controls(canvas, battle, view, {
  onSelection: (ids) => hud.setSelection(ids),
  togglePause: () => togglePause(),
  changeSpeed: (d) => (speed = Math.max(0, Math.min(SPEEDS.length - 1, speed + d))),
  toggleHelp: () => hud.toggleHelp(),
});

function togglePause() {
  if (hud.dialogOpen || battle.result) return;
  paused = !paused;
}

function restart() {
  battle = new Battle(scenario, types);
  view.setBattle(battle);
  controls.setBattle(battle);
  hud.setBattle(battle);
  resultShown = false;
  paused = true;
  resetCamera();
}

window.addEventListener('resize', () => view.resize());

let acc = 0;
let last = performance.now();
let hudTimer = 0;
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!paused && !battle.result && !hud.dialogOpen) {
    acc += dt * SPEEDS[speed];
    let steps = 0;
    while (acc >= DT && steps < 12) {
      battle.step();
      acc -= DT;
      steps++;
    }
    if (steps === 12) acc = 0;
  }
  controls.update(dt);
  view.frame(paused ? 1 : Math.min(1, acc / DT), dt, now / 1000);
  hudTimer -= dt;
  if (hudTimer <= 0) {
    hudTimer = 0.12;
    hud.update(paused, speed);
  }
  const hover = controls.hoverId !== null ? battle.unit(controls.hoverId) : null;
  hud.showTooltip(hover && hover.alive ? hover : null, lastMouse.x, lastMouse.y);
  if (battle.result && !resultShown) {
    resultShown = true;
    hud.update(paused, speed);
    hud.showResult();
  }
  requestAnimationFrame(frame);
}
const lastMouse = { x: 0, y: 0 };
window.addEventListener('pointermove', (e) => {
  lastMouse.x = e.clientX;
  lastMouse.y = e.clientY;
});

if (new URLSearchParams(location.search).get('brief') !== '0') hud.showBriefing();
requestAnimationFrame(frame);

// Handle for automated browser tests and debugging in the console.
(window as unknown as { __game: unknown }).__game = {
  get battle() { return battle; },
  view, controls, hud,
  get paused() { return paused; },
  setPaused: (p: boolean) => (paused = p),
  setSpeed: (i: number) => (speed = i),
};
