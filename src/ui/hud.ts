// DOM panels over the canvas. Refreshed a few times a second, not every frame.
import type { Battle } from '../sim/battle';
import type { Scenario, Stance } from '../sim/types';
import type { Unit } from '../sim/unit';
import { markerCanvas } from '../render/icons';

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  el.append(...kids);
  return el;
}

const fmtTime = (t: number) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

const STATE_LABEL: Record<string, string> = {
  steady: 'Steady', wavering: 'Wavering', retreating: 'Falling back', routing: 'Routing', rallying: 'Rallying', gone: 'Gone',
};

export interface HudHandlers {
  togglePause(): void;
  setSpeed(i: number): void;
  stance(s: Stance): void;
  toggleFire(): void;
  halt(): void;
  topDown(): void;
  follow(): void;
  select(id: number): void;
  restart(): void;
  begin(): void;
}

export const SPEEDS = [1, 2, 4];

export class Hud {
  private readonly clock = h('div', 'clock');
  private readonly pauseBtn = h('button', 'btn pause-btn');
  private readonly speedBtns: HTMLButtonElement[];
  private readonly pausedBanner = h('div', 'paused-banner', 'Paused: set your lines, then press Space');
  private readonly strength = h('div', 'strength');
  private readonly log = h('ol', 'log');
  private readonly card = h('div', 'card');
  private readonly orders = h('div', 'orders');
  private readonly overlay = h('div', 'overlay');
  readonly tooltip = h('div', 'tooltip');
  private logCount = -1;
  private selection: number[] = [];
  private iconCache = new Map<string, string>();

  constructor(root: HTMLElement, private battle: Battle, private readonly scenario: Scenario, private readonly on: HudHandlers) {
    this.pauseBtn.addEventListener('click', () => on.togglePause());
    this.speedBtns = SPEEDS.map((s, i) => {
      const b = h('button', 'btn speed-btn', `${s}×`);
      b.addEventListener('click', () => on.setSpeed(i));
      return b;
    });
    const help = h('button', 'btn', '?');
    help.title = 'Controls (F1)';
    help.addEventListener('click', () => this.toggleHelp());
    const badge = h('button', 'badge', 'Invented battle · estimated stats');
    badge.addEventListener('click', () => this.showAbout());
    const top = h('header', 'topbar',
      h('div', 'title', h('div', 'title-name', scenario.name), h('div', 'title-era', scenario.era)),
      h('div', 'time-controls', this.clock, this.pauseBtn, ...this.speedBtns),
      h('div', 'top-right', badge, help),
    );
    const right = h('aside', 'side-panel', h('div', 'panel-title', 'Armies'), this.strength, h('div', 'panel-title', 'Battle log'), h('div', 'log-wrap', this.log));
    this.buildOrders();
    root.append(top, right, this.card, this.orders, this.pausedBanner, this.overlay, this.tooltip);
  }

  setBattle(b: Battle) {
    this.battle = b;
    this.logCount = -1;
    this.selection = [];
  }

  private icon(icon: string, color: string): string {
    const key = `${icon}|${color}`;
    if (!this.iconCache.has(key)) this.iconCache.set(key, markerCanvas(icon, color, 96).toDataURL());
    return this.iconCache.get(key)!;
  }

  private buildOrders() {
    const btn = (label: string, key: string, title: string, fn: () => void, data?: string) => {
      const b = h('button', 'order-btn', h('span', 'order-label', label), h('span', 'order-key', key));
      b.title = title;
      if (data) b.dataset.stance = data;
      b.addEventListener('click', fn);
      return b;
    };
    this.orders.append(
      btn('Hold', 'H', 'Hold position and fight whatever comes', () => this.on.stance('hold'), 'hold'),
      btn('Advance', 'G', 'Walk toward the nearest enemy and engage', () => this.on.stance('advance'), 'advance'),
      btn('Charge', 'C', 'Run at the nearest enemy (cavalry and elephants hit hardest)', () => this.on.stance('charge'), 'charge'),
      btn('Withdraw', 'X', 'Step back facing the enemy, out of contact', () => this.on.stance('withdraw'), 'withdraw'),
      btn('Fire at will', 'F', 'Toggle automatic shooting for missile units', () => this.on.toggleFire(), 'fire'),
      btn('Halt', '⌫', 'Cancel orders', () => this.on.halt()),
      h('span', 'order-sep'),
      btn('Top-down', 'T', 'Toggle top-down camera', () => this.on.topDown()),
      btn('Follow', 'Y', 'Camera follows the selected unit', () => this.on.follow()),
    );
  }

  setSelection(ids: number[]) {
    this.selection = ids;
  }

  /** Refresh dynamic panels. */
  update(paused: boolean, speed: number) {
    const b = this.battle;
    this.clock.textContent = fmtTime(b.time);
    this.pauseBtn.textContent = paused ? '▶' : '❚❚';
    this.pauseBtn.title = paused ? 'Resume (Space)' : 'Pause (Space)';
    this.speedBtns.forEach((x, i) => x.classList.toggle('on', i === speed));
    this.pausedBanner.style.display = paused && !this.overlay.classList.contains('open') && !b.result ? '' : 'none';

    this.strength.replaceChildren(
      ...[...b.sides.values()].map((s) => {
        const st = b.sideStrength(s.id);
        const bar = h('div', 'bar', h('div', 'bar-fill'));
        const fill = bar.firstChild as HTMLDivElement;
        fill.style.width = `${(st.activeMen / st.initial) * 100}%`;
        fill.style.background = s.color;
        return h('div', 'army', h('div', 'army-row', h('span', 'army-name', s.name), h('span', 'army-num', `${st.activeMen} / ${st.initial}`)), bar);
      }),
    );

    if (b.log.length !== this.logCount) {
      this.logCount = b.log.length;
      const items = b.log.slice(-80).reverse().map((l) => {
        const li = h('li', `log-${l.kind}`, h('span', 'log-t', fmtTime(l.t)), ` ${l.text}`);
        return li;
      });
      this.log.replaceChildren(...items);
    }

    this.renderCard();
    this.renderOrders();
  }

  private renderOrders() {
    const units = this.selection.map((id) => this.battle.unit(id)).filter((u) => u.side === this.battle.player && u.controllable);
    this.orders.classList.toggle('disabled', units.length === 0);
    const stances = new Set(units.map((u) => u.stance));
    const anyMissile = units.some((u) => u.type.range);
    for (const el of this.orders.querySelectorAll<HTMLButtonElement>('[data-stance]')) {
      const s = el.dataset.stance!;
      if (s === 'fire') {
        el.disabled = !anyMissile;
        el.classList.toggle('on', anyMissile && units.filter((u) => u.type.range).every((u) => u.fireAtWill));
      } else {
        el.disabled = units.length === 0;
        el.classList.toggle('on', stances.size === 1 && stances.has(s as Stance));
      }
    }
  }

  private bar(label: string, frac: number, color: string, text: string): HTMLElement {
    const fill = h('div', 'bar-fill');
    fill.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
    fill.style.background = color;
    return h('div', 'stat', h('div', 'stat-row', h('span', '', label), h('span', 'stat-val', text)), h('div', 'bar', fill));
  }

  private renderCard() {
    const units = this.selection.map((id) => this.battle.unit(id)).filter((u) => u.alive);
    if (units.length === 0) {
      this.card.style.display = 'none';
      return;
    }
    this.card.style.display = '';
    if (units.length > 1) {
      this.card.className = 'card card-multi';
      this.card.replaceChildren(
        ...units.map((u) => {
          const img = h('img', 'mini-icon');
          img.src = this.icon(u.type.icon, this.battle.sides.get(u.side)!.color);
          const m = h('div', 'mini-bar', h('div', ''));
          const mf = m.firstChild as HTMLDivElement;
          mf.style.width = `${u.morale}%`;
          mf.style.background = moraleColor(u);
          const el = h('button', `mini mini-${u.state}`, img, h('div', 'mini-men', String(u.men)), m);
          el.title = `${u.name}: ${STATE_LABEL[u.state]}`;
          el.addEventListener('click', () => this.on.select(u.id));
          return el;
        }),
      );
      return;
    }
    const u = units[0];
    const side = this.battle.sides.get(u.side)!;
    const t = u.type;
    const img = h('img', 'card-icon');
    img.src = this.icon(t.icon, side.color);
    const order = u.order ? (u.order.kind === 'move' ? 'Moving to position' : `Attacking ${this.battle.unit(u.order.target).name}`) : u.contacts.length ? 'In melee' : '—';
    this.card.className = 'card';
    this.card.replaceChildren(
      h('div', 'card-head', img, h('div', '', h('div', 'card-name', u.name), h('div', 'card-sub', `${t.name} · ${side.name}${u.general ? ' · General' : ''}`))),
      this.bar('Men', u.men / u.maxMen, side.color, `${u.men} / ${u.maxMen}`),
      this.bar('Morale', u.morale / 100, moraleColor(u), STATE_LABEL[u.state]),
      this.bar('Fatigue', u.fatigue, '#9a8a6a', `${Math.round(u.fatigue * 100)}%`),
      ...(t.range ? [this.bar('Ammunition', u.ammo / (t.ammo ?? 1), '#c9b27a', `${u.ammo} volleys`)] : []),
      h('div', 'card-line', h('span', '', 'Stance'), h('b', '', u.stance + (t.range ? (u.fireAtWill ? ' · fire at will' : ' · holding fire') : ''))),
      h('div', 'card-line', h('span', '', 'Order'), h('b', '', order)),
      h('div', 'card-stats', ...[['ATK', t.attack], ['CHG', t.charge], ['ARM', t.armor], ['SPD', t.speed], ['MOR', t.morale], ...(t.range ? [['RNG', t.range]] : [])].map(([k, v]) => h('div', 'cs', h('span', '', String(k)), h('b', '', String(v))))),
      h('p', 'card-note', t.note ?? ''),
    );
  }

  showTooltip(u: Unit | null, x: number, y: number) {
    if (!u) {
      this.tooltip.style.display = 'none';
      return;
    }
    this.tooltip.style.display = 'block';
    this.tooltip.style.left = `${x + 16}px`;
    this.tooltip.style.top = `${y + 16}px`;
    this.tooltip.textContent = `${u.name} · ${u.men} men · ${STATE_LABEL[u.state]}`;
  }

  // ------------------------------------------------------------ overlays

  private open(...kids: Node[]) {
    this.overlay.replaceChildren(h('div', 'dialog', ...kids));
    this.overlay.classList.add('open');
  }

  close() {
    this.overlay.classList.remove('open');
    this.overlay.replaceChildren();
  }

  get dialogOpen(): boolean {
    return this.overlay.classList.contains('open');
  }

  showBriefing() {
    const go = h('button', 'btn btn-primary', 'Take command');
    go.addEventListener('click', () => {
      this.close();
      this.on.begin();
    });
    this.open(
      h('div', 'kicker', this.scenario.era),
      h('h1', '', this.scenario.name),
      h('p', 'disclaimer', this.scenario.disclaimer),
      h('p', '', this.scenario.briefing),
      controlsList(),
      h('div', 'dialog-actions', go),
    );
    go.focus();
  }

  toggleHelp() {
    if (this.dialogOpen) return this.close();
    const close = h('button', 'btn', 'Close');
    close.addEventListener('click', () => this.close());
    this.open(h('h2', '', 'Controls'), controlsList(), h('div', 'dialog-actions', close));
  }

  private showAbout() {
    const close = h('button', 'btn', 'Close');
    close.addEventListener('click', () => this.close());
    this.open(
      h('h2', '', 'About this battle'),
      h('p', 'disclaimer', this.scenario.disclaimer),
      h('p', '', 'Unit strengths, weapon and armour values, speeds, morale and the combat formulas are design estimates tuned for play, not historical data. Each unit represents a formation at reduced scale: one figure stands for many men.'),
      h('div', 'dialog-actions', close),
    );
  }

  showResult() {
    const r = this.battle.result!;
    const won = r.winner === this.battle.player;
    const title = r.winner === null ? 'Indecisive' : won ? 'Victory' : 'Defeat';
    const again = h('button', 'btn btn-primary', 'Fight again');
    again.addEventListener('click', () => {
      this.close();
      this.on.restart();
    });
    const look = h('button', 'btn', 'View the field');
    look.addEventListener('click', () => this.close());
    const rows = [...this.battle.sides.values()].map((s) => {
      const units = this.battle.units.filter((u) => u.side === s.id);
      const lost = units.reduce((a, u) => a + (u.maxMen - u.men), 0);
      const fled = units.filter((u) => u.state === 'gone' && u.men > 0).length;
      const broken = units.filter((u) => u.state === 'routing').length;
      return h('tr', '', h('td', '', s.name), h('td', '', String(lost)), h('td', '', String(fled)), h('td', '', String(broken)));
    });
    this.open(
      h('div', `kicker result-${r.winner === null ? 'draw' : won ? 'win' : 'loss'}`, fmtTime(this.battle.time)),
      h('h1', '', title),
      h('p', '', r.text),
      h('table', 'result-table', h('thead', '', h('tr', '', h('th', '', ''), h('th', '', 'Casualties'), h('th', '', 'Units fled'), h('th', '', 'Routing'))), h('tbody', '', ...rows)),
      h('div', 'dialog-actions', look, again),
    );
  }
}

function moraleColor(u: Unit): string {
  if (u.state === 'routing') return '#c0443a';
  if (u.state === 'retreating' || u.state === 'wavering') return '#d6973a';
  return '#7fa55a';
}

function controlsList(): HTMLElement {
  const rows: [string, string][] = [
    ['Left click / drag', 'Select a unit / box-select. Shift adds. Double-click selects all of that type.'],
    ['Right-drag', 'Draw a battle line. Units spread along it, facing away from the camera. Esc cancels.'],
    ['Right click', 'Move there (keeps the group\'s frontage), or attack an enemy. Hold Alt to run.'],
    ['W A S D / arrows / screen edge', 'Pan the camera'],
    ['Mouse wheel', 'Zoom (zoomed out, units become map markers)'],
    ['Q / E, middle-drag', 'Rotate and tilt'],
    ['T / Y', 'Top-down view / follow selected unit'],
    ['H G C X', 'Stance: Hold, Advance, Charge, Withdraw'],
    ['F / Backspace', 'Toggle fire at will / halt'],
    ['Alt+1-9, 1-9', 'Assign / select control group'],
    ['Space, + / -', 'Pause (orders still work), speed'],
  ];
  return h('table', 'controls', h('tbody', '', ...rows.map(([k, v]) => h('tr', '', h('td', 'key', k), h('td', '', v)))));
}
