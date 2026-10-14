import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Campaign } from '../src/campaign/campaign';
import { AUTOSAVE, MAX_SAVES, QUICKSAVE, SaveStore } from '../src/campaign/saves';
import type { CampaignData } from '../src/campaign/types';
import { loadTypes } from './helpers';

class MemoryStorage {
  map = new Map<string, string>();
  full = false;
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { if (this.full) throw new Error('QuotaExceeded'); this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

const data: CampaignData = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'campaign', 'rise-of-the-guptas.json'), 'utf8'));
const meta = { turn: 0, season: 'Spring 319 CE', summary: '5 towns · 2 armies' };
let mem: MemoryStorage;

beforeEach(() => {
  mem = new MemoryStorage();
  (globalThis as unknown as { localStorage: MemoryStorage }).localStorage = mem;
});

describe('campaign saves', () => {
  it('saves, lists, loads and deletes', () => {
    const s = new SaveStore(data.id);
    const st = Campaign.fresh(data);
    expect(s.save(AUTOSAVE, 'Autosave', st, meta)).toBeNull();
    expect(s.save(QUICKSAVE, 'Quick save', st, meta)).toBeNull();
    const id = s.newId();
    expect(s.save(id, 'Before Prayaga', st, meta)).toBeNull();
    expect(s.list().map((m) => m.id)).toEqual([AUTOSAVE, QUICKSAVE, id]);
    expect(s.load(id)!.owners.pataliputra).toBe('gupta');
    s.remove(id);
    expect(s.list().map((m) => m.id)).toEqual([AUTOSAVE, QUICKSAVE]);
    expect(s.load(id)).toBeNull();
  });

  it('a loaded save restores the campaign exactly', () => {
    const c = new Campaign(data, loadTypes(), Campaign.fresh(data));
    c.prepareTurn();
    for (let t = 0; t < 3; t++) {
      c.beginMovement();
      for (let i = 0; i < 3000 && c.stepMovement(3); i++);
      for (const e of c.encounters) if (c.army(e.player) && c.army(e.enemy)) c.applyOutcome(e, c.autoResolve(e));
      c.finishTurn();
    }
    const s = new SaveStore(data.id);
    s.save(AUTOSAVE, 'Autosave', c.state, meta);
    expect(JSON.stringify(s.load(AUTOSAVE))).toBe(JSON.stringify(c.state));
  });

  it('caps named saves but always allows the autosave and overwrites', () => {
    const s = new SaveStore(data.id);
    const st = Campaign.fresh(data);
    const ids: string[] = [];
    for (let i = 0; i < MAX_SAVES; i++) {
      const id = `n${i}`;
      ids.push(id);
      expect(s.save(id, `Save ${i}`, st, meta)).toBeNull();
    }
    expect(s.save('extra', 'One too many', st, meta)).toMatch(/delete or overwrite/);
    expect(s.save(ids[0], 'Overwritten', st, meta)).toBeNull();
    expect(s.save(AUTOSAVE, 'Autosave', st, meta)).toBeNull();
    expect(s.named().length).toBe(MAX_SAVES);
  });

  it('brings an old single autosave into the autosave slot', () => {
    const st = Campaign.fresh(data);
    st.turn = 7;
    mem.setItem(`gupta-campaign-v1:${data.id}`, JSON.stringify(st));
    const s = new SaveStore(data.id);
    expect(s.load(AUTOSAVE)!.turn).toBe(7);
    expect(mem.getItem(`gupta-campaign-v1:${data.id}`)).toBeNull();
  });

  it('reports a full or blocked storage instead of throwing', () => {
    const s = new SaveStore(data.id);
    mem.full = true;
    expect(s.save('x', 'X', Campaign.fresh(data), meta)).toMatch(/refused/);
  });

  it('keeps saves of different campaigns apart', () => {
    const a = new SaveStore(data.id), b = new SaveStore('north-india-455');
    a.save(AUTOSAVE, 'Autosave', Campaign.fresh(data), meta);
    expect(b.list().length).toBe(0);
    expect(b.load(AUTOSAVE)).toBeNull();
  });
});
