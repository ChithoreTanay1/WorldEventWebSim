// Campaign saves in the browser's localStorage: one autosave slot (written every turn), one quick-save
// slot (Ctrl+S) and up to MAX_SAVES named saves, per campaign. A small index lists them without
// reading every save. Storage can be blocked or full: every call fails soft and says so.
import type { CampaignState } from './types';

export const MAX_SAVES = 12;
export const AUTOSAVE = 'auto';
export const QUICKSAVE = 'quick';

export interface SaveMeta {
  id: string;
  name: string;
  turn: number;
  season: string;
  savedAt: number;
  /** A line describing the realm at the time: "5 towns · 2 armies". */
  summary: string;
}

const VERSION = 1;

export class SaveStore {
  private readonly indexKey: string;

  constructor(private readonly dataId: string) {
    this.indexKey = `gupta-saves-v${VERSION}:${dataId}`;
    this.migrate();
  }

  private key(id: string): string {
    return `gupta-save-v${VERSION}:${this.dataId}:${id}`;
  }

  private readIndex(): SaveMeta[] {
    try {
      const raw = localStorage.getItem(this.indexKey);
      return raw ? (JSON.parse(raw) as SaveMeta[]) : [];
    } catch {
      return [];
    }
  }

  private writeIndex(list: SaveMeta[]) {
    localStorage.setItem(this.indexKey, JSON.stringify(list));
  }

  /** Autosave and quick save first, then named saves, newest first. */
  list(): SaveMeta[] {
    const rank = (m: SaveMeta) => (m.id === AUTOSAVE ? 0 : m.id === QUICKSAVE ? 1 : 2);
    return this.readIndex().sort((a, b) => rank(a) - rank(b) || b.savedAt - a.savedAt);
  }

  named(): SaveMeta[] {
    return this.list().filter((m) => m.id !== AUTOSAVE && m.id !== QUICKSAVE);
  }

  load(id: string): CampaignState | null {
    try {
      const raw = localStorage.getItem(this.key(id));
      if (!raw) return null;
      const st = JSON.parse(raw) as CampaignState;
      return st.version === 1 && st.dataId === this.dataId ? st : null;
    } catch {
      return null;
    }
  }

  /** Write a save (a new id for a new named save). Returns an error message, or null on success. */
  save(id: string, name: string, state: CampaignState, meta: Omit<SaveMeta, 'id' | 'name' | 'savedAt'>): string | null {
    const list = this.readIndex().filter((m) => m.id !== id);
    const isNamed = id !== AUTOSAVE && id !== QUICKSAVE;
    if (isNamed && list.filter((m) => m.id !== AUTOSAVE && m.id !== QUICKSAVE).length >= MAX_SAVES) {
      return `There are already ${MAX_SAVES} saves: delete or overwrite one.`;
    }
    try {
      localStorage.setItem(this.key(id), JSON.stringify(state));
      list.push({ id, name, savedAt: Date.now(), ...meta });
      this.writeIndex(list);
      return null;
    } catch {
      return 'The browser refused to store the save (storage blocked or full).';
    }
  }

  remove(id: string) {
    try {
      localStorage.removeItem(this.key(id));
      this.writeIndex(this.readIndex().filter((m) => m.id !== id));
    } catch {
      /* storage blocked: nothing to remove */
    }
  }

  newId(): string {
    return `s${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  }

  /** Earlier versions kept one autosave under another key: bring it into the autosave slot once. */
  private migrate() {
    try {
      const old = `gupta-campaign-v1:${this.dataId}`;
      const raw = localStorage.getItem(old);
      if (!raw) return;
      if (!localStorage.getItem(this.key(AUTOSAVE))) {
        const st = JSON.parse(raw) as CampaignState;
        localStorage.setItem(this.key(AUTOSAVE), raw);
        const list = this.readIndex().filter((m) => m.id !== AUTOSAVE);
        list.push({ id: AUTOSAVE, name: 'Autosave', turn: st.turn, season: '', savedAt: Date.now(), summary: '' });
        this.writeIndex(list);
      }
      localStorage.removeItem(old);
    } catch {
      /* storage blocked */
    }
  }
}
