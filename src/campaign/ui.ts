// Campaign HUD: top bar, selected-army card, faction summary and chronicle, map labels, dialogs and
// the fade used when the camera dives into a battle.
import { markerCanvas } from '../render/icons';
import { ARMY_CAP, RECRUIT_SLOTS, type Campaign, type Encounter } from './campaign';
import type { MapView } from './mapView';
import type { Army } from './types';

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  el.append(...kids);
  return el;
}

export interface CampaignHudHandlers {
  endTurn(): void;
  newCampaign(): void;
  select(id: number | null): void;
  recruit(town: string, type: string): void;
  cancelRecruit(town: string, slot?: number): void;
  split(army: number, units: number[]): void;
  merge(into: number, from: number): void;
}

export class CampaignHud {
  readonly root = h('div', 'campaign-root');
  private readonly season = h('div', 'title-era');
  private readonly turnLabel = h('div', 'turn-label');
  private readonly phaseLabel = h('div', 'phase-label');
  readonly endBtn = h('button', 'btn btn-primary end-turn', 'End turn');
  private readonly card = h('div', 'card camp-card');
  private readonly factions = h('div', 'strength');
  private readonly log = h('div', 'log');
  private readonly labels = h('div', 'camp-labels');
  private readonly townLabels = new Map<string, HTMLDivElement>();
  /** Label anchor height per town (fixed), and a reused projection result. */
  private readonly townY = new Map<string, number>();
  private readonly pt = { x: 0, y: 0, visible: false };
  private readonly armyLabels = new Map<number, HTMLDivElement>();
  readonly tooltip = h('div', 'tooltip');
  private readonly overlay = h('div', 'overlay');
  readonly fade = h('div', 'camp-fade');
  private readonly hint = h('div', 'context-hint camp-hint');
  private logCount = -1;
  private cardKey = '';
  private icons = new Map<string, string>();
  /** Unit indices of the selected army picked for a detachment. */
  private readonly picked = new Set<number>();
  private cardArmy: number | null = null;
  private planning = false;

  constructor(host: HTMLElement, private readonly c: Campaign, private readonly view: MapView, private readonly on: CampaignHudHandlers) {
    this.endBtn.addEventListener('click', () => on.endTurn());
    const newBtn = h('button', 'btn', 'New campaign');
    newBtn.addEventListener('click', () => this.confirmNew());
    const help = h('button', 'btn', '?');
    help.title = 'How the campaign works';
    help.addEventListener('click', () => this.showHelp());
    const top = h('header', 'topbar',
      h('div', 'title', h('div', 'title-name', c.data.name), this.season),
      h('div', 'turn-box', this.turnLabel, this.phaseLabel),
      h('div', 'time-controls', this.endBtn),
      h('div', 'top-right', newBtn, help),
    );
    const right = h('aside', 'side-panel',
      h('div', 'panel-title', 'The war'), this.factions,
      h('div', 'panel-title', 'Chronicle'), h('div', 'log-wrap', this.log),
    );
    this.hint.textContent = 'Click an army or town · Right-click a town to march · Space ends the turn';
    this.root.append(this.labels, top, right, this.card, this.hint, this.overlay, this.tooltip, this.fade);
    host.append(this.root);
    const capitals = new Set(Object.values(c.data.factions).map((f) => f.capital));
    for (const s of c.data.settlements) {
      const el = h('div', 'camp-town', h('span', 'camp-dot'), s.name);
      el.classList.toggle('capital', capitals.has(s.id));
      this.labels.append(el);
      this.townLabels.set(s.id, el);
      const p = c.pos[s.id];
      this.townY.set(s.id, c.geo.height(p.x, p.z) + 4);
    }
  }

  setVisible(v: boolean) {
    this.root.style.display = v ? '' : 'none';
  }

  private icon(icon: string, color: string): string {
    const key = `${icon}|${color}`;
    if (!this.icons.has(key)) this.icons.set(key, markerCanvas(icon, color, 64).toDataURL());
    return this.icons.get(key)!;
  }

  // ------------------------------------------------------------ per frame

  update(phase: string) {
    const c = this.c;
    this.season.textContent = `${c.data.era} · ${c.seasonLabel()}`;
    this.turnLabel.textContent = `Turn ${c.state.turn + 1}`;
    this.phaseLabel.textContent = phase;
    this.planning = phase === 'Your orders';
    this.endBtn.disabled = !this.planning;
    this.renderFactions();
    this.renderLog();
    this.renderCard();
    this.refreshLabels();
  }

  /**
   * Follow towns and armies with their HTML labels, every frame. Only positions move here, and a style
   * is written only when its value changes; colours, counts and classes refresh at the HUD rate.
   */
  updateLabels() {
    const c = this.c;
    const pt = this.pt;
    for (const [id, el] of this.townLabels) {
      const p = c.pos[id];
      this.view.project(p.x, this.townY.get(id)!, p.z + 14, pt);
      place(el, pt.visible, pt.x, pt.y, 0);
    }
    const scale = this.view.markerScale;
    for (const a of c.armies) {
      const el = this.armyLabels.get(a.id);
      const p = this.view.tokenPos(a.id);
      if (!el || !p) continue;
      this.view.project(p.x, p.y + 24 * scale, p.z, pt);
      place(el, pt.visible, pt.x, pt.y, -100);
    }
  }

  /** Label content: owner colours, recruit counts, army sizes and selection (HUD rate, not every frame). */
  private refreshLabels() {
    const c = this.c;
    const queued = new Map<string, number>();
    for (const r of c.state.recruits) if (r.faction === c.player) queued.set(r.town, (queued.get(r.town) ?? 0) + 1);
    for (const [id, el] of this.townLabels) {
      setStyle(el.firstChild as HTMLElement, 'background', c.data.factions[c.state.owners[id]]?.color ?? '#999');
      const q = queued.get(id) ?? 0;
      el.classList.toggle('recruiting', q > 0);
      if (el.dataset.rec !== `+${q}`) el.dataset.rec = `+${q}`;
    }
    for (const [id, el] of this.armyLabels) {
      if (c.army(id)) continue;
      el.remove();
      this.armyLabels.delete(id);
    }
    for (const a of c.armies) {
      let el = this.armyLabels.get(a.id);
      if (!el) {
        el = h('div', 'camp-army');
        el.style.display = 'none';
        this.labels.append(el);
        this.armyLabels.set(a.id, el);
      }
      setStyle(el, 'borderColor', c.data.factions[a.faction].color);
      const n = `${a.units.length}`;
      if (el.textContent !== n) el.textContent = n;
      if (el.title !== a.name) el.title = a.name;
      el.classList.toggle('sel', this.view.selected === a.id);
    }
  }

  showTooltip(text: string | null, x: number, y: number) {
    if (!text) {
      this.tooltip.style.display = 'none';
      return;
    }
    this.tooltip.style.display = 'block';
    this.tooltip.style.left = `${x + 16}px`;
    this.tooltip.style.top = `${y + 16}px`;
    this.tooltip.textContent = text;
  }

  private renderFactions() {
    const c = this.c;
    const rows = Object.entries(c.data.factions).map(([id, f]) => {
      const towns = Object.values(c.state.owners).filter((o) => o === id).length;
      const armies = c.armiesOf(id);
      const power = armies.reduce((s, a) => s + c.power(a), 0);
      return { f, towns, armies: armies.length, power };
    });
    const total = rows.reduce((s, r) => s + r.power, 0) || 1;
    const key = rows.map((r) => `${r.towns}/${r.armies}/${Math.round(r.power)}`).join('|');
    if (this.factions.dataset.key === key) return;
    this.factions.dataset.key = key;
    this.factions.replaceChildren(...rows.map((r) => {
      const fill = h('div', 'bar-fill');
      fill.style.width = `${(r.power / total) * 100}%`;
      fill.style.background = r.f.color;
      return h('div', 'army',
        h('div', 'army-row', h('span', '', r.f.name), h('span', 'army-num', `${r.towns} towns · ${r.armies} armies`)),
        h('div', 'bar', fill));
    }));
  }

  private renderLog() {
    const entries = this.c.state.log;
    if (entries.length === this.logCount) return;
    this.logCount = entries.length;
    const items: HTMLElement[] = [];
    let turn = -1;
    for (const e of entries.slice(-60).reverse()) {
      if (e.turn !== turn) {
        turn = e.turn;
        items.push(h('div', 'log-turn', this.c.seasonLabel(turn)));
      }
      items.push(h('div', `log-entry log-${e.kind}`, e.text));
    }
    this.log.replaceChildren(...items);
  }

  private renderCard() {
    const c = this.c;
    const id = this.view.selected;
    const a = id !== null ? c.army(id) : undefined;
    const town = !a ? this.view.selectedTown : null;
    // Everything the card shows, so it is rebuilt only when something changes.
    const rec = (t: string) => c.recruitsAt(t).map((r) => r.type).join(',');
    const key = a
      ? [
        'a', a.id, a.name, a.moveLeft, a.marching, a.from, a.to, a.route.join(), a.units.map((u) => u.name + u.strength.toFixed(2)).join(),
        [...this.picked].join(), this.planning, rec(a.from), c.armies.filter((b) => c.together(a, b)).map((b) => `${b.id}:${b.units.length}`).join(),
      ].join('|')
      : town ? ['t', town, c.state.owners[town], rec(town), this.planning, c.recruitBlock(c.player, town)].join('|') : '';
    if (key === this.cardKey) return;
    if (!a || this.cardArmy !== a.id) this.picked.clear();
    this.cardArmy = a?.id ?? null;
    this.cardKey = key;
    this.card.style.display = a || town ? '' : 'none';
    if (a) this.card.replaceChildren(...this.armyCard(a));
    else if (town) this.card.replaceChildren(...this.townCard(town));
  }

  private armyCard(a: Army): (Node | string)[] {
    const c = this.c;
    const f = c.data.factions[a.faction];
    const mine = a.faction === c.player;
    const dest = c.destination(a);
    const where = a.to ? `on the road to ${c.names[a.to]}` : `at ${c.names[a.from]}`;
    const canEdit = mine && this.planning;
    const rows = a.units.map((u, i) => {
      const t = c.types[u.type];
      const fill = h('div', 'bar-fill');
      fill.style.width = `${Math.round(u.strength * 100)}%`;
      fill.style.background = u.strength > 0.6 ? 'var(--good)' : u.strength > 0.3 ? 'var(--warn)' : 'var(--bad)';
      const img = h('img', 'camp-unit-icon');
      img.src = this.icon(t?.icon ?? 'infantry', f.color);
      const row = h('div', `camp-unit${this.picked.has(i) ? ' picked' : ''}${canEdit ? ' pickable' : ''}`, img, h('div', 'camp-unit-body',
        h('div', 'army-row', h('span', '', `${u.general ? '★ ' : ''}${u.name}`), h('span', 'army-num', `${Math.round(u.strength * 100)}%`)),
        h('div', 'bar', fill)));
      if (canEdit) {
        row.title = 'Click to pick this unit for a detachment';
        row.addEventListener('click', () => {
          if (this.picked.has(i)) this.picked.delete(i);
          else this.picked.add(i);
          this.renderCard();
        });
      }
      return row;
    });
    const out: (Node | string)[] = [
      h('div', 'card-name', a.name),
      h('div', 'card-sub', `${f.name} · ${where}`),
    ];
    const resting = !a.to && c.state.owners[a.from] === a.faction;
    if (mine) {
      out.push(
        h('div', 'card-line', h('span', '', 'Orders'), h('b', '', dest ? `march to ${c.names[dest]}` : 'hold')),
        h('div', 'card-line', h('span', '', 'March this turn'), h('b', '', `${Math.round(a.moveLeft)} of ${c.moveOf(a)}`)),
      );
      if (resting && !dest) out.push(h('div', 'card-line', h('span', '', 'Resting'), h('b', 'camp-good', `+10% a turn in ${c.names[a.from]}`)));
    }
    out.push(
      h('div', 'card-line', h('span', '', 'Strength'), h('b', '', `${a.units.length} of ${ARMY_CAP} units · power ${Math.round(c.power(a) / 1000)}k`)),
      h('div', 'camp-units', ...rows),
    );
    if (!mine) return out;
    if (canEdit) {
      const n = this.picked.size;
      const split = this.button2(n ? `Split off ${n} unit${n > 1 ? 's' : ''}` : 'Split: pick units above', () => {
        const idx = [...this.picked];
        this.picked.clear();
        this.on.split(a.id, idx);
      });
      split.disabled = n === 0 || n >= a.units.length;
      if (n >= a.units.length) split.title = 'Leave at least one unit behind';
      const merges = c.armiesOf(a.faction).filter((b) => c.together(a, b)).map((b) => {
        const why = c.canMerge(a, b);
        const btn = this.button2(`Merge in ${b.name} (${b.units.length})`, () => this.on.merge(a.id, b.id));
        btn.disabled = !!why;
        if (why) btn.title = `Can't merge: ${why}`;
        return btn;
      });
      out.push(h('div', 'camp-actions', split, ...merges));
    }
    if (resting) out.push(...this.recruitPanel(a.from));
    out.push(h('p', 'card-note', canEdit
      ? 'Right-click a town or army to march there. H halts. Click units to pick them, then split them off. To merge, march one army onto another.'
      : 'Orders can be changed when the next turn starts.'));
    return out;
  }

  private townCard(town: string): (Node | string)[] {
    const c = this.c;
    const s = c.data.settlements.find((x) => x.id === town)!;
    const owner = c.data.factions[c.state.owners[town]];
    const out: (Node | string)[] = [
      h('div', 'card-name', s.name),
      h('div', 'card-sub', `Held by ${owner?.name ?? 'nobody'}${s.note ? ` · ${s.note}` : ''}`),
    ];
    if (c.state.owners[town] === c.player) out.push(...this.recruitPanel(town));
    else out.push(h('p', 'card-note', 'March an army into an undefended enemy town to take it.'));
    return out;
  }

  /** Ten slots per town per turn; each unit is ready next turn and joins an army resting there or a new levy. */
  private recruitPanel(town: string): (Node | string)[] {
    const c = this.c;
    const f = c.data.factions[c.player];
    const queued = c.recruitsAt(town);
    const block = c.recruitBlock(c.player, town);
    const full = queued.length >= RECRUIT_SLOTS;
    const out: (Node | string)[] = [h('div', 'camp-sub-title', `Recruit at ${c.names[town]} · ${queued.length} of ${RECRUIT_SLOTS} slots`)];
    // The queue: one box per slot; click a filled one to free it.
    const slots = h('div', 'camp-slots');
    for (let i = 0; i < RECRUIT_SLOTS; i++) {
      const r = queued[i];
      const slot = h('button', `camp-slot${r ? ' filled' : ''}`);
      if (r) {
        const t = c.types[r.type];
        const img = h('img', 'camp-unit-icon');
        img.src = this.icon(t.icon, f.color);
        slot.append(img);
        slot.title = `${t.name}: ready next turn. Click to cancel.`;
        slot.disabled = !this.planning;
        slot.addEventListener('click', () => this.on.cancelRecruit(town, i));
      } else slot.disabled = true;
      slots.append(slot);
    }
    out.push(slots);
    if (queued.length) {
      const clear = this.button2('Clear all', () => this.on.cancelRecruit(town));
      clear.disabled = !this.planning;
      out.push(h('div', 'camp-queued', h('span', '', `${queued.length} unit${queued.length > 1 ? 's' : ''} ready next turn`), clear));
    }
    const grid = h('div', 'camp-recruit');
    for (const type of f.recruits) {
      const t = c.types[type];
      if (!t) continue;
      const img = h('img', 'camp-unit-icon');
      img.src = this.icon(t.icon, f.color);
      const n = queued.filter((r) => r.type === type).length;
      const b = h('button', `btn camp-recruit-btn${n ? ' on' : ''}`, img, h('span', '', `${t.name}${n ? ` ×${n}` : ''}`));
      b.title = `Add ${t.name} (${t.category})${t.note ? `: ${t.note}` : ''}`;
      b.disabled = !this.planning || !!block || full;
      b.addEventListener('click', () => this.on.recruit(town, type));
      grid.append(b);
    }
    out.push(grid);
    out.push(h('p', 'card-note', block
      ? `Cannot recruit: ${block}.`
      : `Up to ${RECRUIT_SLOTS} units a turn, each ready next turn whatever the type. They fill armies resting here (${ARMY_CAP} units each), then form a new levy.`));
    return out;
  }

  private button2(label: string, act: () => void): HTMLButtonElement {
    const b = h('button', 'btn', label);
    b.addEventListener('click', act);
    return b;
  }

  // ------------------------------------------------------------ dialogs

  private open(...kids: (Node | string)[]) {
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

  private button(label: string, primary: boolean, act: () => void): HTMLButtonElement {
    const b = h('button', primary ? 'btn btn-primary' : 'btn', label);
    b.addEventListener('click', () => {
      this.close();
      act();
    });
    return b;
  }

  showBriefing() {
    const go = this.button('To war', true, () => {});
    this.open(
      h('div', 'kicker', this.c.data.era),
      h('h1', '', this.c.data.name),
      h('p', 'disclaimer', this.c.data.disclaimer),
      h('p', '', this.c.data.briefing),
      helpList(),
      h('div', 'dialog-actions', go),
    );
    go.focus();
  }

  showHelp() {
    if (this.dialogOpen) return this.close();
    this.open(h('h2', '', 'The campaign'), helpList(), h('div', 'dialog-actions', this.button('Close', false, () => {})));
  }

  private confirmNew() {
    this.open(
      h('h2', '', 'Start a new campaign?'),
      h('p', '', 'The current campaign is lost.'),
      h('div', 'dialog-actions', this.button('Cancel', false, () => {}), this.button('New campaign', true, () => this.on.newCampaign())),
    );
  }

  /** Choose how to settle a battle. */
  askBattle(enc: Encounter): Promise<'fight' | 'auto'> {
    const c = this.c;
    const p = c.army(enc.player)!, e = c.army(enc.enemy)!;
    const pp = c.power(p), pe = c.power(e);
    const odds = pp / (pp + pe);
    const fill = h('div', 'bar-fill');
    fill.style.width = `${Math.round(odds * 100)}%`;
    fill.style.background = c.data.factions[p.faction].color;
    const bar = h('div', 'bar camp-odds', fill);
    bar.style.background = c.data.factions[e.faction].color;
    const attacking = enc.attacker === p.faction;
    return new Promise((done) => {
      const fight = this.button('Take command', true, () => done('fight'));
      this.open(
        h('div', 'kicker', `${c.seasonLabel()} · near ${c.names[enc.place]}`),
        h('h1', '', attacking ? 'Battle: you attack' : 'Battle: you are attacked'),
        h('p', '', `${p.name} (${p.units.length} units) meets ${e.name} (${e.units.length} units).`),
        armyLine(c, p), armyLine(c, e),
        h('div', 'army-row camp-odds-label', h('span', '', 'Balance of strength'), h('span', 'army-num', `${Math.round(odds * 100)} : ${Math.round((1 - odds) * 100)}`)),
        bar,
        h('p', 'card-note', 'Take command to fight it on the battlefield yourself, or auto-resolve it from army strength with some luck. Either way, losses stay with the armies.'),
        h('div', 'dialog-actions', this.button('Auto-resolve', false, () => done('auto')), fight),
      );
      fight.focus();
    });
  }

  /** Casualty report after a battle; resolves when dismissed. */
  showOutcome(title: string, winnerIsPlayer: boolean | null, lines: [string, string][]): Promise<void> {
    return new Promise((done) => {
      const ok = this.button('Continue', true, () => done());
      this.open(
        h('div', `kicker result-${winnerIsPlayer === null ? 'draw' : winnerIsPlayer ? 'win' : 'loss'}`, winnerIsPlayer === null ? 'Draw' : winnerIsPlayer ? 'Victory' : 'Defeat'),
        h('h1', '', title),
        h('table', 'result-table', h('tbody', '', ...lines.map(([a, b]) => h('tr', '', h('td', '', a), h('td', '', b))))),
        h('div', 'dialog-actions', ok),
      );
      ok.focus();
    });
  }

  showEnd(playerWon: boolean) {
    this.open(
      h('div', `kicker result-${playerWon ? 'win' : 'loss'}`, this.c.seasonLabel()),
      h('h1', '', playerWon ? 'The Huna are driven out' : 'The empire falls'),
      h('p', '', this.c.state.log[this.c.state.log.length - 1]?.text ?? ''),
      h('div', 'dialog-actions', this.button('View the map', false, () => {}), this.button('New campaign', true, () => this.on.newCampaign())),
    );
  }

  /** Fade the screen to dark (true) or back (false). */
  setFade(dark: boolean, seconds = 0.45): Promise<void> {
    this.fade.style.transition = `opacity ${seconds}s ease`;
    this.fade.style.opacity = dark ? '1' : '0';
    return new Promise((r) => setTimeout(r, seconds * 1000));
  }
}

function armyLine(c: Campaign, a: Army): HTMLElement {
  const f = c.data.factions[a.faction];
  const counts = new Map<string, number>();
  for (const u of a.units) {
    const n = c.types[u.type]?.name ?? u.type;
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const dot = h('span', 'camp-dot');
  dot.style.background = f.color;
  return h('div', 'camp-army-line', dot, h('b', '', a.name), h('span', 'army-num', [...counts].map(([n, k]) => `${k}× ${n}`).join(', ')));
}

function helpList(): HTMLElement {
  const items = [
    'Turns are simultaneous, like the battles: you give orders, the Huna plan at the same time, then every army marches at once.',
    'Click your army, then right-click a town to march there. Gold path: reached this turn. Pale path: later turns. H halts, Tab cycles your armies.',
    'Armies that meet on the road fight. Take command to fight on the battlefield yourself, or auto-resolve it.',
    'Casualties carry over. The loser falls back to its nearest town. Armies resting in their own towns recover 10% a turn.',
    'March into an undefended enemy town to take it. Fresh levies muster at Pataliputra every few turns, and new riders come through the passes.',
    'Win by taking Purushapura. Lose if Pataliputra falls or your last army is destroyed.',
    'Map: drag or WASD to pan, wheel to zoom.',
  ];
  return h('ul', 'rules', ...items.map((t) => h('li', '', t)));
}

/** Move a label, touching the DOM only when its rounded position or visibility changes. */
function place(el: HTMLElement, visible: boolean, x: number, y: number, shiftY: number) {
  const d = el.dataset;
  const vis = visible ? '1' : '0';
  if (d.vis !== vis) {
    d.vis = vis;
    el.style.display = visible ? '' : 'none';
  }
  if (!visible) return;
  const rx = Math.round(x), ry = Math.round(y);
  const key = rx * 65536 + ry;
  if (d.pos === String(key)) return;
  d.pos = String(key);
  el.style.transform = `translate(${rx}px, ${ry}px) translate(-50%, ${shiftY}%)`;
}

function setStyle(el: HTMLElement, prop: 'background' | 'borderColor', value: string) {
  const k = `s${prop}`;
  if (el.dataset[k] === value) return;
  el.dataset[k] = value;
  el.style[prop] = value;
}
