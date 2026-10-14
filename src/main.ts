import './style.css';
import { BattleSession } from './battleSession';
import { CampaignMode } from './campaign/mode';
import { perf } from './perf';
import { adaptiveResolution } from './render/renderer';
import type { CampaignData } from './campaign/types';
import type { FormationDef, Scenario, UnitType } from './sim/types';

// Data is discovered by folder: new unit types, formations, scenarios and campaigns need no code change.
const unitFiles = import.meta.glob<UnitType>('/data/units/*.json', { eager: true, import: 'default' });
const formFiles = import.meta.glob<FormationDef>('/data/formations/*.json', { eager: true, import: 'default' });
const scenarioFiles = import.meta.glob<Scenario>('/data/scenarios/*.json', { eager: true, import: 'default' });
const campaignFiles = import.meta.glob<CampaignData>('/data/campaign/*.json', { eager: true, import: 'default' });
const types: Record<string, UnitType> = Object.fromEntries(Object.values(unitFiles).map((t) => [t.id, t]));
const forms: Record<string, FormationDef> = Object.fromEntries(Object.values(formFiles).map((f) => [f.id, f]));
const scenarios = Object.values(scenarioFiles);
const campaigns = Object.values(campaignFiles);
const params = new URLSearchParams(location.search);

const app = document.getElementById('app')!;

// ?mode=battle (or ?scenario=<id>) opens a single battle; otherwise the campaign map.
const battleOnly = params.get('mode') === 'battle' || params.has('scenario') || campaigns.length === 0;

let frameFn: (dt: number, now: number) => void;
if (battleOnly) {
  const scenario = scenarios.find((s) => s.id === params.get('scenario')) ?? scenarios[0];
  const session = new BattleSession(app, scenario, types, forms, { showBriefing: params.get('brief') !== '0' });
  frameFn = (dt, now) => session.frame(dt, now);
  // Handle for automated browser tests and console debugging.
  (window as unknown as { __game: unknown }).__game = {
    get battle() { return session.battle; },
    view: session.view, controls: session.controls, hud: session.hud,
    setSpeed: (i: number) => (session.speed = i),
    endTurn: () => session.endTurn(),
    get replaying() { return session.replaying; },
  };
} else {
  const campaign = new CampaignMode(app, campaigns[0], types, forms, scenarios[0].rules);
  frameFn = (dt, now) => campaign.frame(dt, now);
  (window as unknown as { __campaign: unknown }).__campaign = campaign;
}

let last = performance.now();
let prevNow = last;
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  perf.beginFrame(now);
  frameFn(dt, now);
  perf.endFrame();
  // perf.renderer is whichever renderer is on screen (battle or campaign map).
  if (perf.renderer) adaptiveResolution.update((now - prevNow) / 1000, perf.renderer);
  prevNow = now;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
