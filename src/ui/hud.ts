// DOM panels over the canvas, refreshed a few times a second.
import type { Battle } from '../sim/battle';
import { maxRange, unitQuirks } from '../sim/combat';
import type { OrderType, Scenario, UnitStatus } from '../sim/types';
import type { Unit } from '../sim/unit';
import { markerCanvas } from '../render/icons';
import { ORDER_COLORS } from '../render/overlay';
import { FORMATION_KEYS, ORDER_KEYS, type Controls } from '../input/controls';
import { Roster } from './roster';

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  el.append(...kids);
  return el;
}

export const SPEEDS = [1, 2, 4];

const STATUS_LABEL: Record<UnitStatus, string> = {
  standing: 'Standing', recovering: 'Recovering', routing: 'Routing', shattered: 'Shattered', deserted: 'Deserted', destroyed: 'Destroyed',
};
const STATUS_COLOR: Record<UnitStatus, string> = {
  standing: '#7fa55a', recovering: '#d6973a', routing: '#c0443a', shattered: '#777', deserted: '#777', destroyed: '#777',
};
const ORDER_LABEL: Record<OrderType, string> = {
  fireAdvance: 'Fire & Advance', run: 'Run', shoot: 'Shoot', walk: 'Walk', fallback: 'Fallback', rotate: 'Rotate',
};

export interface HudHandlers {
  endTurn(): void;
  replay(): void;
  setSpeed(i: number): void;
  restart(): void;
  select(ids: number[], add?: boolean): void;
  /** Bring the camera to these units. */
  focus(ids: number[]): void;
  /** Campaign battles: leave the field and carry the result back to the map. */
  exit?(): void;
}

export class Hud {
  private readonly turnLabel = h('div', 'turn-label');
  private readonly phaseLabel = h('div', 'phase-label');
  private readonly vp = h('div', 'vp');
  private readonly endBtn = h('button', 'btn btn-primary end-turn');
  private readonly replayBtn = h('button', 'btn', '⟲ Replay turn');
  private readonly speedBtns: HTMLButtonElement[];
  private readonly groupsBar = h('div', 'groups');
  private readonly roster: Roster;
  private readonly armies = h('div', 'armies');
  private readonly objectives = h('div', 'objectives');
  private readonly log = h('div', 'log');
  private readonly card = h('div', 'card');
  private readonly orderBar = h('div', 'orders');
  private readonly overlay = h('div', 'overlay');
  readonly tooltip = h('div', 'tooltip');
  private readonly dragLabel = h('div', 'drag-hint');
  private readonly hint = h('div', 'context-hint');
  private logCount = -1;
  private selection: number[] = [];
  private iconCache = new Map<string, string>();
  mode: 'live' | 'replay' = 'live';

  constructor(root: HTMLElement, private battle: Battle, private readonly scenario: Scenario, private readonly controls: Controls, private readonly on: HudHandlers) {
    this.endBtn.addEventListener('click', () => on.endTurn());
    this.replayBtn.addEventListener('click', () => on.replay());
    this.replayBtn.title = 'Replay the last turn (P)';
    this.speedBtns = SPEEDS.map((s, i) => {
      const b = h('button', 'btn speed-btn', `${s}×`);
      b.title = 'Playback speed (+ / -)';
      b.addEventListener('click', () => on.setSpeed(i));
      return b;
    });
    const help = h('button', 'btn', '?');
    help.title = 'Controls and rules (F1)';
    help.addEventListener('click', () => this.toggleHelp());
    const badge = h('button', 'badge', 'Invented battle · estimated stats');
    badge.addEventListener('click', () => this.showAbout());
    const top = h('header', 'topbar',
      h('div', 'title', h('div', 'title-name', scenario.name), h('div', 'title-era', scenario.era)),
      h('div', 'turn-box', this.turnLabel, this.phaseLabel),
      this.vp,
      h('div', 'time-controls', this.replayBtn, ...this.speedBtns, this.endBtn),
      h('div', 'top-right', badge, help),
    );
    const right = h('aside', 'side-panel',
      h('div', 'panel-title', 'Armies'), this.armies,
      h('div', 'panel-title', 'Objectives'), this.objectives,
      h('div', 'panel-title', 'Battle log'), h('div', 'log-wrap', this.log),
    );
    this.buildOrderBar();
    this.roster = new Roster(battle, { select: (ids, add) => on.select(ids, add), focus: (ids) => on.focus(ids), icon: (i, c) => this.icon(i, c) });
    root.append(top, this.groupsBar, this.roster.el, right, this.card, this.hint, this.orderBar, this.overlay, this.tooltip, this.dragLabel);
    this.renderGroups();
  }

  setBattle(b: Battle) {
    this.battle = b;
    this.roster.setBattle(b);
    this.logCount = -1;
    this.selection = [];
    this.renderGroups();
  }

  private icon(icon: string, color: string): string {
    const key = `${icon}|${color}`;
    if (!this.iconCache.has(key)) this.iconCache.set(key, markerCanvas(icon, color, 96).toDataURL());
    return this.iconCache.get(key)!;
  }

  // ------------------------------------------------------------ order bar

  private orderButtons: HTMLButtonElement[] = [];
  private formationButtons: HTMLButtonElement[] = [];
  private autofireButtons: HTMLButtonElement[] = [];

  private buildOrderBar() {
    const group = (title: string, ...kids: Node[]) => h('div', 'order-group', h('div', 'order-group-title', title), h('div', 'order-group-row', ...kids));
    this.orderButtons = ORDER_KEYS.map(([type, key, label]) => {
      const b = h('button', 'order-btn', h('span', 'order-swatch'), h('span', 'order-label', label), h('span', 'order-key', key));
      (b.firstChild as HTMLElement).style.background = ORDER_COLORS[type];
      b.dataset.type = type;
      b.title = ORDER_HELP[type];
      b.addEventListener('click', () => this.controls.setOrderType(type));
      return b;
    });
    const clear = h('button', 'order-btn', h('span', 'order-label', 'Clear'), h('span', 'order-key', 'Y'));
    clear.title = 'Clear the selected units\' orders';
    clear.addEventListener('click', () => this.controls.clearOrders());
    this.formationButtons = FORMATION_KEYS.map((code, i) => {
      const b = h('button', 'order-btn', h('span', 'order-label', '—'), h('span', 'order-key', code.slice(3)));
      b.addEventListener('click', () => this.controls.formationSlot(i));
      return b;
    });
    this.autofireButtons = (['close', 'effective', 'max'] as const).map((r) => {
      const b = h('button', 'order-btn', h('span', 'order-label', r[0].toUpperCase() + r.slice(1)));
      b.dataset.range = r;
      b.title = 'Autofire range for the selected missile units';
      b.addEventListener('click', () => this.controls.setAutofire(r));
      return b;
    });
    this.orderBar.append(
      group('Order type', ...this.orderButtons, clear),
      group('Formation', ...this.formationButtons),
      group('Autofire', ...this.autofireButtons),
    );
  }

  setSelection(ids: number[]) {
    this.selection = ids;
    this.roster.setSelection(ids);
    this.roster.update();
  }

  // ------------------------------------------------------------ groups bar

  renderGroups() {
    const kids: Node[] = [];
    for (let n = 1; n <= 9; n++) {
      const ids = this.controls.groups[n].filter((id) => this.battle.unit(id).alive);
      if (!ids.length) continue;
      const b = h('button', 'group-btn', h('b', '', String(n)), ` ${ids.length}`);
      b.title = `Group ${n}: click to recall (Alt+${n}); Ctrl+click to overwrite with the selection (Ctrl+${n})`;
      b.addEventListener('click', (e) => {
        if (e.ctrlKey || e.metaKey) this.controls.assignGroup(n, 'set');
        else this.controls.recallGroup(n, e.shiftKey);
      });
      kids.push(b);
    }
    if (this.controls.groups.slice(1).some((g) => g.length === 0)) {
      const plus = h('button', 'group-btn', '+');
      plus.title = 'Save the selection to the next free group';
      plus.addEventListener('click', () => this.controls.saveToFreeGroup());
      kids.push(plus);
    }
    this.groupsBar.replaceChildren(...kids);
  }

  // ------------------------------------------------------------ refresh

  update(speed: number, resolvingReplay: boolean) {
    this.roster.update();
    const b = this.battle;
    const resolving = b.phase === 'resolving';
    this.turnLabel.textContent = b.phase === 'deployment' ? 'Deployment' : `Turn ${Math.min(b.battleTurn(), b.rules.turnLimit)} / ${b.rules.turnLimit}`;
    const tick = resolving ? ` · tick ${Math.min(16, b.tick + 1)}/16` : '';
    this.phaseLabel.textContent = this.mode === 'replay' ? 'Replaying last turn' : b.phase === 'ended' ? 'Battle over' : resolving ? `Resolving${tick}` : b.phase === 'deployment' ? 'Place your army' : 'Planning';
    this.endBtn.textContent = b.phase === 'deployment' ? 'Begin battle ▶' : 'End turn ▶';
    this.endBtn.disabled = resolving || b.phase === 'ended' || this.mode === 'replay';
    this.replayBtn.disabled = resolving || b.lastTurnFrames.length < 2 || resolvingReplay;
    this.speedBtns.forEach((x, i) => x.classList.toggle('on', i === speed));

    const sides = [...b.sides.values()];
    this.vp.replaceChildren(
      ...sides.flatMap((s, i) => {
        const el = h('span', 'vp-side', h('span', 'vp-name', s.name), h('b', 'vp-num', String(s.vp)));
        (el.lastChild as HTMLElement).style.color = s.color;
        const p = s.vpParts;
        el.title = `Victory points ${s.vp} = base ${p.base} ${p.casualties >= 0 ? '+' : '−'} casualties ${Math.abs(p.casualties)} + objectives ${p.objectives}${p.pressure ? ` − pressure ${-p.pressure}` : ''}`;
        return i === 0 ? [el, h('span', 'vp-sep', ':')] : [el];
      }),
    );

    this.armies.replaceChildren(
      ...sides.map((s) => {
        const units = b.units.filter((u) => u.side === s.id);
        const count = (st: UnitStatus[]) => units.filter((u) => st.includes(u.status)).length;
        const lost = b.powerLost(s.id);
        const bar = h('div', 'bar', h('div', 'bar-fill'));
        const fill = bar.firstChild as HTMLDivElement;
        fill.style.width = `${(1 - lost) * 100}%`;
        fill.style.background = s.color;
        return h('div', 'army',
          h('div', 'army-row', h('span', 'army-name', s.name), h('span', 'army-num', `${Math.round((1 - lost) * 100)}% power`)),
          bar,
          h('div', 'army-states', `${count(['standing'])} standing · ${count(['recovering'])} recovering · ${count(['routing'])} routing · ${count(['shattered', 'deserted', 'destroyed'])} gone`),
        );
      }),
    );

    this.objectives.replaceChildren(
      ...b.objectives.map((o) => {
        const owner = o.owner ? b.sides.get(o.owner)! : null;
        const chip = h('span', 'chip');
        chip.style.background = owner?.color ?? '#9a968c';
        const name = o.size === 'hill' ? 'Neutral hill' : `${o.size === 'big' ? 'Big' : 'Small'} objective`;
        const prog = o.capturer ? ` · ${b.sides.get(o.capturer)!.name} capturing ${Math.round((100 * o.progress) / b.rules.capturePoints)}%` : '';
        return h('div', 'obj-row', chip, h('span', '', `${name} (${o.vp} VP) · ${owner?.name ?? 'neutral'}${prog}`));
      }),
    );

    if (b.log.length !== this.logCount) {
      this.logCount = b.log.length;
      const byTurn = new Map<number, typeof b.log>();
      for (const l of b.log.slice(-120)) byTurn.set(l.turn, [...(byTurn.get(l.turn) ?? []), l]);
      const kids: Node[] = [];
      for (const [turn, entries] of [...byTurn].reverse()) {
        kids.push(h('div', 'log-turn', turn <= 1 ? 'Deployment' : `Turn ${turn}`));
        for (const l of [...entries].reverse()) kids.push(h('div', `log-entry log-${l.kind}`, l.text));
      }
      this.log.replaceChildren(...kids);
    }
    this.renderOrderBar();
    this.renderCard();
    this.renderHint();
  }

  /** One line explaining what the mouse does with the current selection and order type. */
  private renderHint() {
    const b = this.battle;
    const units = this.controls.commandable();
    let text = '';
    if (b.phase === 'resolving') text = 'The turn is playing out. Orders resume when it ends.';
    else if (this.mode === 'replay') text = 'Replaying the last turn.';
    else if (!units.length) text = b.phase === 'deployment' ? 'Select units (click or drag a box), then drag them into place inside the dashed zone.' : 'Select units: click, Shift+click, drag a box, or double-click for all of a type.';
    else {
      const type = ORDER_LABEL[this.controls.orderType];
      const many = units.length > 1;
      text = b.phase === 'deployment'
        ? `Right-click: place here · Right-drag: place ${many ? 'them along a line' : 'along a path'} · Drag from a unit: place at the route's end · R T F G: formation`
        : `Order: ${type} (1-5 to change) · Right-click: move · Drag from a selected unit: draw the route${many ? ' (lanes)' : ''} · Right-drag: ${many ? 'form a line along the curve' : 'path'}${many ? '' : ' (start on the unit to rotate)'} · Right-click enemy: ${this.controls.orderType === 'shoot' ? 'shoot it' : this.controls.orderType === 'fallback' ? 'back away from it' : 'attack it'}`;
    }
    this.hint.textContent = text;
  }

  showDragHint(text: string | null, x: number, y: number) {
    if (!text) {
      this.dragLabel.style.display = 'none';
      return;
    }
    this.dragLabel.style.display = 'block';
    this.dragLabel.style.left = `${x + 18}px`;
    this.dragLabel.style.top = `${y - 34}px`;
    this.dragLabel.textContent = text;
  }

  private renderOrderBar() {
    const units = this.controls.commandable();
    this.orderBar.classList.toggle('disabled', units.length === 0);
    for (const btn of this.orderButtons) btn.classList.toggle('on', btn.dataset.type === this.controls.orderType);
    // Formation slots: show the first selected unit's formations; highlight the current/planned one.
    const first = units[0];
    const slots = first ? first.formationSlots() : [];
    this.formationButtons.forEach((btn, i) => {
      const f = slots[i];
      (btn.firstChild as HTMLElement).textContent = f ? this.battle.forms[f].name : '—';
      btn.disabled = !f;
      const planned = first ? this.battle.plannedFormation.get(first.id) ?? first.pending?.to ?? first.formation : '';
      btn.classList.toggle('on', !!f && planned === f);
      btn.title = f ? this.battle.forms[f].note ?? '' : '';
    });
    const missiles = units.filter((u) => u.type.ranged);
    this.autofireButtons.forEach((btn) => {
      btn.disabled = missiles.length === 0;
      btn.classList.toggle('on', missiles.length > 0 && missiles.every((u) => u.autofire === btn.dataset.range));
    });
  }

  private bar(label: string, frac: number, color: string, text: string, marks: number[] = []): HTMLElement {
    const fill = h('div', 'bar-fill');
    fill.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
    fill.style.background = color;
    const bar = h('div', 'bar', fill);
    for (const m of marks) {
      const tick = h('div', 'bar-mark');
      tick.style.left = `${Math.max(0, Math.min(1, m)) * 100}%`;
      bar.append(tick);
    }
    return h('div', 'stat', h('div', 'stat-row', h('span', '', label), h('span', 'stat-val', text)), bar);
  }

  private renderCard() {
    const b = this.battle;
    const units = this.selection.map((id) => b.unit(id)).filter((u) => u.alive);
    if (units.length === 0) {
      this.card.style.display = 'none';
      return;
    }
    this.card.style.display = '';
    if (units.length > 1) return this.renderSelectionPanel(units);
    const u = units[0];
    const side = b.sides.get(u.side)!;
    const t = u.type;
    const seen = b.seen(b.player, u);
    const img = h('img', 'card-icon');
    img.src = this.icon(seen >= 3 ? t.icon : 'unknown', seen >= 3 ? side.color : '#7d7a72');
    if (seen < 3) {
      this.card.className = 'card';
      this.card.replaceChildren(h('div', 'card-head', img, h('div', '', h('div', 'card-name', 'Unidentified enemy'), h('div', 'card-sub', 'Too far away to make out'))));
      return;
    }
    const status = h('span', 'status', STATUS_LABEL[u.status]);
    status.style.background = STATUS_COLOR[u.status];
    const head = h('div', 'card-head', img, h('div', '', h('div', 'card-name', u.name), h('div', 'card-sub', `${t.name} · ${side.name}${u.general ? ' · General' : ''}`), status));
    if (seen < 4) {
      this.card.className = 'card';
      this.card.replaceChildren(head, h('p', 'card-note', 'Identified, but too far away to judge its condition (?)'));
      return;
    }
    const m = t.orgMarks;
    const mine = u.side === b.player;
    const o = u.order;
    const orderText = !o ? (u.status === 'standing' ? 'No order (stands)' : '—')
      : o.type === 'rotate' ? 'Rotate'
      : o.follow !== undefined ? `${ORDER_LABEL[o.type]}: follow ${b.unit(o.follow).name}`
      : o.target !== undefined ? `${ORDER_LABEL[o.type]}: ${b.unit(o.target).name}`
      : `${ORDER_LABEL[o.type]} along path${o.continued ? ' (continued)' : ''}`;
    const formName = b.forms[u.formation].name;
    const planned = b.plannedFormation.get(u.id);
    const formText = u.routing ? 'Dispersed' : u.pending ? `${formName} → ${b.forms[u.pending.to].name} (${u.pending.ticksLeft} ticks)` : planned ? `${formName} → ${b.forms[planned].name} next turn` : formName;
    const statuses: string[] = [];
    if (u.bim > 0) statuses.push(`Been in melee (${u.bim})`);
    if (u.takenFire > 0) statuses.push(`Taken fire (${u.takenFire})`);
    if (u.hasRan > 0) statuses.push(`Has ran`);
    if (u.startedRouting > 0) statuses.push(`Started routing (${u.startedRouting})`);
    if (u.rotated180 > 0) statuses.push('About-face');
    if (u.overlap > 0.1) statuses.push(`Ally overlap ${Math.round(u.overlap * 100)}%`);
    if (u.runRamp >= 1 && u.running) statuses.push('Charge ready');
    const r = u.orgReport;
    const showStamina = u.staminaFrac < 0.85;
    this.card.className = 'card';
    this.card.replaceChildren(
      head,
      this.bar('Men', u.hpFrac, side.color, `${b.men(u)} / ${b.men(u, u.maxHp)}  ·  HP ${Math.round(u.hp)}`),
      this.bar('Organization', Math.max(0, u.org) / u.baseMaxOrg, STATUS_COLOR[u.status], `${Math.round(u.org)} / ${Math.round(u.maxOrg)}`, [m.rally, m.recover, u.maxOrg / u.baseMaxOrg]),
      ...(showStamina ? [this.bar('Stamina', (u.staminaFrac - 0.4) / 0.45, '#9a8a6a', u.staminaFrac <= 0.4 ? 'Exhausted' : `${Math.round(u.staminaFrac * 100)}%`)] : []),
      ...(t.ranged ? [this.bar('Ammunition', u.ammo / t.ranged.ammo, '#c9b27a', `${u.ammo} volleys`)] : []),
      h('div', 'card-line', h('span', '', 'Formation'), h('b', '', formText)),
      ...(mine ? [h('div', 'card-line', h('span', '', 'Order'), h('b', '', orderText))] : []),
      ...(t.ranged ? [h('div', 'card-line', h('span', '', 'Autofire'), h('b', '', u.autofire))] : []),
      ...(statuses.length ? [h('div', 'chips', ...statuses.map((s) => h('span', 'chip-status', s)))] : []),
      h('div', 'org-breakdown', `Org / turn: recovery +${r.recovery.toFixed(0)} · nearby ${r.nearby >= 0 ? '+' : ''}${r.nearby.toFixed(0)} · suppressed −${r.suppression.toFixed(0)}`),
      h('div', 'card-stats', ...[
        ['MEL', `${t.melee.attack}/${t.melee.defense}`], ['CHG', t.melee.chargeBonus], ['C.RES', t.melee.chargeResistance],
        ['RNG', t.ranged ? `${t.ranged.attack} · ${maxRange(t.ranged.weapon)}m` : '—'], ['MOVE', `${t.walk}/${t.run}`], ['RAD', `${t.orgRadius}m +${t.orgRadiusBonus}`],
      ].map(([k, v]) => h('div', 'cs', h('span', '', String(k)), h('b', '', String(v))))),
      t.traits ? h('div', 'card-traits', ...t.traits.map((x) => h('span', `trait ${x.startsWith('-') ? 'debuff' : 'buff'}`, x))) : '',
      h('ul', 'card-quirks', ...unitQuirks(t).map((q) => h('li', '', q))),
      h('p', 'card-note', t.note ?? ''),
    );
  }

  /** Multi-select list (wiki): click = only that; Ctrl+click = keep matching type+formation; Shift+click = remove; Ctrl+Shift+click = remove matching. */
  private renderSelectionPanel(units: Unit[]) {
    const b = this.battle;
    this.card.className = 'card card-multi';
    this.card.replaceChildren(
      ...units.map((u) => {
        const img = h('img', 'mini-icon');
        img.src = this.icon(u.type.icon, b.sides.get(u.side)!.color);
        const mb = h('div', 'mini-bar', h('div', ''));
        const mf = mb.firstChild as HTMLDivElement;
        mf.style.width = `${Math.max(0, u.org / u.baseMaxOrg) * 100}%`;
        mf.style.background = STATUS_COLOR[u.status];
        const el = h('button', `mini mini-${u.status}`, img, h('div', 'mini-name', u.name.replace(/\s*\(.+\)/, '')), mb);
        el.title = `${u.name}: ${STATUS_LABEL[u.status]}. Click: only this · Ctrl: keep same type+formation · Shift: remove · Ctrl+Shift: remove same type+formation`;
        el.addEventListener('click', (e) => {
          const same = (o: Unit) => o.type.id === u.type.id && o.formation === u.formation;
          let ids = units.map((x) => x.id);
          if ((e.ctrlKey || e.metaKey) && e.shiftKey) ids = units.filter((x) => !same(x)).map((x) => x.id);
          else if (e.ctrlKey || e.metaKey) ids = units.filter(same).map((x) => x.id);
          else if (e.shiftKey) ids = ids.filter((id) => id !== u.id);
          else ids = [u.id];
          this.on.select(ids);
        });
        return el;
      }),
    );
  }

  showTooltip(u: Unit | null, x: number, y: number) {
    if (!u) {
      this.tooltip.style.display = 'none';
      return;
    }
    const seen = this.battle.seen(this.battle.player, u);
    this.tooltip.style.display = 'block';
    this.tooltip.style.left = `${x + 16}px`;
    this.tooltip.style.top = `${y + 16}px`;
    this.tooltip.textContent = seen < 3 ? 'Unidentified enemy' : seen < 4 ? `${u.name} · ?` : `${u.name} · ${STATUS_LABEL[u.status]} · org ${Math.round(u.org)}`;
  }

  // ------------------------------------------------------------ dialogs

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
    const go = h('button', 'btn btn-primary', 'Deploy the army');
    go.addEventListener('click', () => this.close());
    this.open(
      h('div', 'kicker', this.scenario.era),
      h('h1', '', this.scenario.name),
      h('p', 'disclaimer', this.scenario.disclaimer),
      h('p', '', this.scenario.briefing),
      rulesSummary(this.battle),
      h('div', 'dialog-actions', go),
    );
    go.focus();
  }

  toggleHelp() {
    if (this.dialogOpen) return this.close();
    const close = h('button', 'btn', 'Close');
    close.addEventListener('click', () => this.close());
    this.open(h('h2', '', 'Controls'), controlsList(), h('h2', 'h2-gap', 'How turns work'), rulesSummary(this.battle), h('div', 'dialog-actions', close));
  }

  private showAbout() {
    const close = h('button', 'btn', 'Close');
    close.addEventListener('click', () => this.close());
    this.open(
      h('h2', '', 'About this battle'),
      h('p', 'disclaimer', this.scenario.disclaimer),
      h('p', '', 'Rules follow the Lines of Battle wiki (v1.7): WEGO turns of 16 ticks, organization and routing, formations with flank angles, charges, stamina, stacking, objectives and victory points, and fog of war. The wiki is Napoleonic; formations and weapons are mapped onto this era, and numbers the wiki leaves out are our estimates.'),
      h('div', 'dialog-actions', close),
    );
  }

  showResult() {
    const b = this.battle;
    const r = b.result!;
    const won = r.winner === b.player;
    const title = r.winner === null ? 'Tie' : won ? 'Victory' : 'Defeat';
    const exit = this.on.exit;
    const again = h('button', 'btn btn-primary', exit ? 'Return to the campaign map' : 'Fight again');
    again.addEventListener('click', () => {
      this.close();
      if (exit) exit();
      else this.on.restart();
    });
    const look = h('button', 'btn', 'View the field');
    look.addEventListener('click', () => this.close());
    const rows = [...b.sides.values()].map((s) => {
      const units = b.units.filter((u) => u.side === s.id);
      const gone = units.filter((u) => !u.alive).length;
      const routing = units.filter((u) => u.routing).length;
      return h('tr', '', h('td', '', s.name), h('td', '', String(s.vp)), h('td', '', `${Math.round(b.powerLost(s.id) * 100)}%`), h('td', '', String(routing)), h('td', '', String(gone)));
    });
    this.open(
      h('div', `kicker result-${r.winner === null ? 'draw' : won ? 'win' : 'loss'}`, `After ${Math.min(b.battleTurn() - 1, b.rules.turnLimit)} turns`),
      h('h1', '', title),
      h('p', '', r.text),
      h('table', 'result-table', h('thead', '', h('tr', '', h('th', '', ''), h('th', '', 'VP'), h('th', '', 'Power lost'), h('th', '', 'Routing'), h('th', '', 'Gone'))), h('tbody', '', ...rows)),
      h('div', 'dialog-actions', look, again),
    );
  }
}

const ORDER_HELP: Record<OrderType, string> = {
  fireAdvance: 'Fire & Advance (1): walk the path firing at anything in reach, stopping at stand-off distance; or close on a locked enemy and hold. −20% fire while moving. Melee units just walk.',
  run: 'Run (2): the only way to charge. Builds up to sprint; contact at sprint with stamina above 40% is a charge. Drains stamina.',
  shoot: 'Shoot (3): stay put, turn to the locked enemy and fire at it all turn.',
  walk: 'Walk (4): march along the path; right-click a friend to follow it; right-click an enemy to chase it. Can melee but not charge.',
  fallback: 'Fallback (5): withdraw facing the enemy and still firing. −35% speed and fire, +15% org damage taken, −0.2 charge resistance.',
  rotate: 'Rotate: right-drag starting on a single selected unit to turn it on the spot.',
};

function rulesSummary(b: Battle): HTMLElement {
  const r = b.rules;
  const items = [
    'Both sides plan at once; End turn and the turn plays out: 16 ticks, attacks every 2 ticks. You can\'t interrupt it; Replay shows it again.',
    'Orders last one turn. A drawn path that runs longer carries on (faded arrow), but units without orders stand still.',
    'Organization decides battles. At 0 a unit breaks and routs; it can recover and rally, or shatter if pressed. Friends nearby steady it, enemies nearby wear it down; flank and rear attacks hit organization hardest.',
    'Formations change footprint, firepower, speed and flank exposure. Changes happen at the start of the turn and take a few ticks; melee cancels them.',
    'Running drains stamina; tired units fight, shoot and resist charges worse and cannot charge below 40%.',
    `Only infantry captures objectives (within ${r.captureRadius} m; ${r.capturePoints} points, 2 per tick per unit). Any enemy infantry in the circle stops it.`,
    `Victory points are recounted every turn: base ${r.vpBase} + objectives held ± casualty difference − pressure. A side at 0 VP is knocked out. After ${r.turnLimit} turns the leader wins unless within ${r.tieMargin} points.`,
    'Fog of war: you only see what your standing units can see. Distant enemies are silhouettes; ridges hide what is behind them; firing reveals a unit.',
  ];
  return h('ul', 'rules', ...items.map((t) => h('li', '', t)));
}

function controlsList(): HTMLElement {
  const rows: [string, string][] = [
    ['Left click / drag', 'Select / box-select. Shift adds. Double-click: on-screen units of the same type and formation.'],
    ['1 2 3 4 5 · Y', 'Order type: Fire & Advance, Run, Shoot, Walk, Fallback · clear orders'],
    ['Right click ground', 'Move there with the current order type (a group keeps side by side)'],
    ['Left-drag from a selected unit', 'Draw the route: the unit follows the curve exactly; a group follows it in parallel lanes'],
    ['Right-drag', 'One unit: draw its path · several: lay them along the line, stacked by role · starting on the unit: rotate it'],
    ['Right click enemy / friend', 'Lock on (Shoot, chase, close and fire, back away) / follow it in column'],
    ['R T F G', 'Formation slots for the selected units (applied when the turn starts)'],
    ['Ctrl / Alt / Shift + 1-9', 'Assign / recall / add to control group (Ctrl+Shift: assign exclusively)'],
    ['Space / Enter · P', 'End turn · replay last turn'],
    ['W A S D / arrows / edges · wheel · Q E', 'Pan · zoom · rotate'],
    ['Ctrl+Shift+left-drag / middle-drag', 'Tilt the camera up and down (and turn it)'],
    ['V / Z · + -', 'Top-down view / follow selected · playback speed'],
  ];
  return h('table', 'controls', h('tbody', '', ...rows.map(([k, v]) => h('tr', '', h('td', 'key', k), h('td', '', v)))));
}
