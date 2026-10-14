import { describe, expect, it } from 'vitest';
import { angleDiff } from '../src/sim/geometry';
import { planCurve, turnRadius } from '../src/sim/pathing';
import type { XZ } from '../src/sim/types';
import { newBattle } from './helpers';

/** Largest turn per metre along a track, skipping deliberate pivots (turns past 100 degrees) and their stubs. */
function maxCurvature(start: XZ, track: XZ[]): number {
  const pts = [start, ...track];
  const turn = (i: number) => {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    return Math.abs(angleDiff(Math.atan2(b.z - a.z, b.x - a.x), Math.atan2(c.z - b.z, c.x - b.x)));
  };
  const pivot = (i: number) => i >= 1 && i < pts.length - 1 && turn(i) > (100 * Math.PI) / 180;
  let worst = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
    // Skip pivots and the short stub where the track halts for one.
    if (pivot(i) || pivot(i + 1) || len < 0.5) continue;
    worst = Math.max(worst, turn(i) / len);
  }
  return worst;
}

function distToPolyline(p: XZ, line: XZ[]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    const dx = b.x - a.x, dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.z - a.z - t * dz));
  }
  return best;
}

describe('smart curved paths', () => {
  const start = { x: 0, z: 0, facing: 0 };

  it('a gentle curve is followed closely and ends exactly at the drawn end', () => {
    const drawn: XZ[] = [];
    for (let i = 0; i <= 40; i++) drawn.push({ x: i * 5, z: 30 * Math.sin(i / 12) });
    const track = planCurve(start, drawn, 10);
    expect(track[track.length - 1]).toEqual(drawn[drawn.length - 1]);
    const off = Math.max(...track.map((p) => distToPolyline(p, [{ x: 0, z: 0 }, ...drawn])));
    expect(off).toBeLessThan(4);
  });

  it('never turns tighter than the turning radius allows', () => {
    // A zigzag drawn far tighter than a 25 m radius.
    const drawn: XZ[] = [];
    for (let i = 0; i <= 12; i++) drawn.push({ x: i * 15, z: i % 2 ? 12 : -12 });
    const r = 25;
    const track = planCurve(start, drawn, r);
    // 2 m track spacing makes the discrete estimate a little noisy: allow 25% slack.
    expect(maxCurvature(start, track)).toBeLessThan((1 / r) * 1.25);
  });

  it('a hairpin is taken as a halt and pivot, not an endless circle', () => {
    const drawn: XZ[] = [{ x: 60, z: 0 }, { x: 0, z: 4 }];
    const track = planCurve(start, drawn, 40);
    expect(track.length).toBeLessThan(120);
    expect(track[track.length - 1]).toEqual({ x: 0, z: 4 });
  });

  it('a unit facing away from its destination turns first, then goes straight', () => {
    const track = planCurve({ x: 0, z: 0, facing: Math.PI }, [{ x: 50, z: 0 }], 20);
    expect(Math.max(...track.map((p) => Math.abs(p.z)))).toBeLessThan(0.01);
  });

  it('radius grows with speed and shrinks with turn rate', () => {
    expect(turnRadius(60, Math.PI)).toBeCloseTo(60 / Math.PI);
    expect(turnRadius(120, Math.PI)).toBeGreaterThan(turnRadius(60, Math.PI));
    expect(turnRadius(60, 0)).toBeGreaterThan(1e5);
  });
});

describe('order preview matches the battle', () => {
  it('the ghost stands where the unit ends the turn', () => {
    const b = newBattle();
    b.endTurn(); // deployment over
    const u = b.units.find((x) => x.side === b.player && x.type.category === 'cavalry' && !x.general)!;
    // Swing out and back toward the rear, well away from the enemy and other units.
    const drawn = [{ x: u.x - 40, z: u.z + (u.z < 300 ? -10 : 10) }, { x: u.x - 90, z: u.z + (u.z < 300 ? -30 : 30) }];
    const path = planCurve(u, drawn, b.turnRadius(u, 'walk'));
    b.setOrder(u.id, { type: 'walk', path, facing: Math.PI });
    const pv = b.previewOrder(u, u.order!);
    b.resolveTurn();
    expect(Math.hypot(u.x - pv.end.x, u.z - pv.end.z)).toBeLessThan(1.5);
    expect(Math.abs(angleDiff(u.facing, pv.end.facing))).toBeLessThan(0.1);
  });

  it('units follow the planned curve without sliding sideways', () => {
    const b = newBattle();
    b.endTurn();
    const u = b.units.find((x) => x.side === b.player && x.type.id === 'heavy-infantry')!;
    const path = planCurve(u, [{ x: u.x - 30, z: u.z + 25 }, { x: u.x - 70, z: u.z + 20 }], b.turnRadius(u, 'walk'));
    b.setOrder(u.id, { type: 'walk', path });
    let worst = 0;
    while (b.phase === 'resolving' || b.frames.length === 1) {
      const x0 = u.x, z0 = u.z;
      if (b.stepSub()) break;
      const dx = u.x - x0, dz = u.z - z0;
      if (Math.hypot(dx, dz) > 0.05) worst = Math.max(worst, Math.abs(angleDiff(u.facing, Math.atan2(dz, dx))));
    }
    // Facing keeps up with the direction of travel (within the steering law's full-speed band).
    expect(worst).toBeLessThan(0.35);
  });
});
