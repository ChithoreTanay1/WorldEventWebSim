// Performance work must not change gameplay: full battles from fixed seeds and scripted orders must
// end in exactly the same state, bit for bit. The expected fingerprints were recorded before the
// 60 FPS refactor and re-recorded for the flanking, then the weight/dash/quirk rules changes; if a deliberate rules change
// moves them, re-record them in the same commit (RECORD=1 npx vitest run tests/determinism.test.ts).
import { describe, expect, it } from 'vitest';
import type { Battle } from '../src/sim/battle';
import { newBattle, playOut } from './helpers';
import { goodPlayer } from './players';

function fingerprint(b: Battle): string {
  let h = 2166136261;
  const mix = (x: number) => {
    const s = Object.is(x, -0) ? '0' : String(x);
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  };
  for (const u of b.units) [u.x, u.z, u.facing, u.hp, u.org, u.stamina, u.ammo, u.status.length].forEach(mix);
  mix(b.battleTurn());
  for (const s of b.sides.values()) mix(s.vp);
  return `${(h >>> 0).toString(16)}|${b.result?.winner ?? 'none'}|${b.log.length}`;
}

const EXPECTED: Record<number, string> = {
  1337: '6bfc55c7|gupta|88',
  7: '36a844ee|gupta|91',
  42: 'fce9ea02|gupta|94',
};

describe('determinism', () => {
  for (const seed of [1337, 7, 42]) {
    it(`seed ${seed} plays out identically`, () => {
      const b = newBattle(seed);
      playOut(b, goodPlayer);
      const fp = fingerprint(b);
      if (process.env.RECORD) console.log(`RECORD ${seed} ${fp}`);
      else expect(fp).toBe(EXPECTED[seed]);
    }, 60000);
  }
});
