// The army roster: every unit of yours on the field, grouped by type with its symbol and count
// ("5 × Archers"), so you can pick a whole group or one unit at a glance. Click a group to select it
// (Shift adds), click a unit to select it, double-click to bring the camera there; ▸ expands a group.
// Built once per battle and updated in place at the HUD rate: no rebuilds while the battle runs.
import type { Battle } from '../sim/battle';
import type { Unit } from '../sim/unit';
import type { UnitStatus } from '../sim/types';

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  el.append(...kids);
  return el;
}

export interface RosterHandlers {
  select(ids: number[], add: boolean): void;
  focus(ids: number[]): void;
  icon(icon: string, color: string): string;
}

const ROLE_ORDER: Record<string, number> = { infantry: 0, missile: 1, skirmisher: 2, cavalry: 3, elephant: 4 };
const STATUS_COLOR: Record<UnitStatus, string> = {
  standing: '#7fa55a', recovering: '#d6973a', routing: '#c0443a', shattered: '#666', deserted: '#666', destroyed: '#666',
};

interface UnitRow {
  u: Unit;
  el: HTMLElement;
  hp: HTMLElement;
  org: HTMLElement;
  dot: HTMLElement;
  last: string;
}

interface GroupRow {
  ids: number[];
  units: UnitRow[];
  el: HTMLElement;
  head: HTMLElement;
  count: HTMLElement;
  bar: HTMLElement;
  list: HTMLElement;
  last: string;
}

export class Roster {
  readonly el = h('div', 'roster');
  private readonly body = h('div', 'roster-body');
  private groups: GroupRow[] = [];
  private readonly open = new Set<string>();
  private selected = new Set<number>();

  constructor(private battle: Battle, private readonly on: RosterHandlers) {
    const toggle = h('button', 'roster-title', 'Your army ▾');
    toggle.title = 'Your units by type: click to select a group, ▸ to list its units, double-click to look';
    toggle.addEventListener('click', () => {
      const hidden = this.body.classList.toggle('hidden');
      toggle.textContent = hidden ? 'Your army ▸' : 'Your army ▾';
    });
    this.el.append(toggle, this.body);
    this.build();
  }

  setBattle(b: Battle) {
    this.battle = b;
    this.build();
  }

  setSelection(ids: Iterable<number>) {
    this.selected = new Set(ids);
  }

  private build() {
    const b = this.battle;
    const color = b.sides.get(b.player)!.color;
    const byType = new Map<string, Unit[]>();
    for (const u of b.units) if (u.side === b.player) byType.set(u.type.id, [...(byType.get(u.type.id) ?? []), u]);
    const types = [...byType.keys()].sort((x, y) => {
      const a = byType.get(x)![0].type, c = byType.get(y)![0].type;
      return (ROLE_ORDER[a.category] ?? 9) - (ROLE_ORDER[c.category] ?? 9) || a.name.localeCompare(c.name);
    });
    this.groups = types.map((id) => {
      const units = byType.get(id)!;
      const t = units[0].type;
      const img = h('img', 'roster-icon');
      img.src = this.on.icon(t.icon, color);
      const caret = h('button', 'roster-caret', this.open.has(id) ? '▾' : '▸');
      const count = h('span', 'roster-count');
      const name = h('span', 'roster-name', `${t.traits ? '◆ ' : ''}${t.name}`);
      const fill = h('div', 'bar-fill');
      const head = h('div', 'roster-group', caret, img, h('div', 'roster-main', h('div', 'roster-line', count, name), h('div', 'bar roster-bar', fill)));
      head.title = `${t.name}: click to select all, Shift+click to add, double-click to look${t.traits ? `\n${t.traits.join(', ')}` : ''}`;
      const list = h('div', 'roster-units');
      list.classList.toggle('hidden', !this.open.has(id));
      const rows: UnitRow[] = units.map((u) => {
        const hp = h('div', 'bar-fill');
        const org = h('div', 'bar-fill roster-org');
        const dot = h('span', 'roster-dot');
        const el = h('div', 'roster-unit', dot, h('span', 'roster-uname', `${u.general ? '★ ' : ''}${u.name}`), h('div', 'roster-ubars', h('div', 'bar', hp), h('div', 'bar', org)));
        el.title = `${u.name}: click to select, Shift+click to add, double-click to look`;
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          if (u.alive) this.on.select([u.id], e.shiftKey);
        });
        el.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          if (u.alive) this.on.focus([u.id]);
        });
        list.append(el);
        return { u, el, hp, org, dot, last: '' };
      });
      const g: GroupRow = { ids: units.map((u) => u.id), units: rows, el: h('div', 'roster-type', head, list), head, count, bar: fill, list, last: '' };
      const alive = () => g.ids.filter((i) => this.battle.unit(i).alive);
      head.addEventListener('click', (e) => {
        if ((e.target as HTMLElement) === caret) return;
        const ids = alive();
        if (ids.length) this.on.select(ids, e.shiftKey);
      });
      head.addEventListener('dblclick', () => {
        const ids = alive();
        if (ids.length) this.on.focus(ids);
      });
      caret.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = !this.open.has(id);
        if (isOpen) this.open.add(id);
        else this.open.delete(id);
        caret.textContent = isOpen ? '▾' : '▸';
        list.classList.toggle('hidden', !isOpen);
      });
      return g;
    });
    this.body.replaceChildren(...this.groups.map((g) => g.el));
    this.update();
  }

  /** Counts, bars and highlights; touches the DOM only where something changed. */
  update() {
    for (const g of this.groups) {
      let alive = 0, routing = 0, hp = 0, sel = 0;
      for (const r of g.units) {
        const u = r.u;
        if (u.alive) alive++;
        if (u.routing) routing++;
        if (this.selected.has(u.id)) sel++;
        hp += Math.max(0, u.hp / u.type.hp);
        const pct = Math.round(Math.max(0, u.hp / u.maxHp) * 100), orgPct = Math.round(Math.max(0, Math.min(1, u.orgFrac)) * 100);
        const key = `${u.status}|${pct}|${orgPct}|${this.selected.has(u.id) ? 1 : 0}`;
        if (key === r.last) continue;
        r.last = key;
        r.hp.style.width = `${pct}%`;
        r.org.style.width = `${orgPct}%`;
        r.dot.style.background = STATUS_COLOR[u.status];
        r.el.classList.toggle('sel', this.selected.has(u.id));
        r.el.classList.toggle('gone', !u.alive);
        r.el.classList.toggle('routing', u.routing);
      }
      const total = g.units.length;
      const avg = Math.round((hp / total) * 100);
      const key = `${alive}|${routing}|${avg}|${sel}`;
      if (key === g.last) continue;
      g.last = key;
      g.count.textContent = `${alive}${alive < total ? `/${total}` : ''} ×`;
      g.bar.style.width = `${avg}%`;
      g.bar.style.background = routing ? 'var(--bad)' : avg > 60 ? 'var(--good)' : avg > 30 ? 'var(--warn)' : 'var(--bad)';
      g.head.classList.toggle('sel', sel > 0 && sel === alive);
      g.head.classList.toggle('part', sel > 0 && sel < alive);
      g.head.classList.toggle('gone', alive === 0);
      g.head.dataset.routing = routing ? `${routing} routing` : '';
    }
  }
}
