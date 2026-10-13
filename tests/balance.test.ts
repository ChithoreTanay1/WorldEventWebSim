// Balance regression guard with scripted players (not a guarantee about human play).
import { describe, expect, it } from 'vitest';
import type { Battle } from '../src/sim/battle';
import { newBattle, playOut } from './helpers';
import { goodPlayer } from './players';

const seeds = [1337, 7, 42];
const outcomes = (p?: (b: Battle) => void) =>
  seeds.map((s) => {
    const b = newBattle(s);
    playOut(b, p);
    return b;
  });

describe('scenario balance', () => {
  it('the intended pattern (advance on the objectives, counter-charge their horse) wins', () => {
    expect(outcomes(goodPlayer).filter((b) => b.result?.winner === 'gupta').length).toBeGreaterThanOrEqual(2);
  }, 60000);

  it('doing nothing does not win', () => {
    expect(outcomes().filter((b) => b.result?.winner === 'gupta').length).toBe(0);
  }, 60000);

  it('every battle ends by the turn limit with consistent state', () => {
    for (const b of outcomes(goodPlayer)) {
      expect(b.result).not.toBeNull();
      for (const u of b.units) {
        expect(Number.isFinite(u.x) && Number.isFinite(u.z) && Number.isFinite(u.org)).toBe(true);
        expect(u.hp).toBeGreaterThanOrEqual(0);
      }
    }
  }, 60000);
});
