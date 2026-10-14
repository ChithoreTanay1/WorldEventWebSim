import { describe, expect, it } from 'vitest';
import { cleanStroke, planClickMove, planLine, roleRow, routeLanes, simplifyPath, smoothPath, type LineUnit } from '../src/input/formation';

const unit = (id: number, x: number, z: number, row = 1, frontage = 50, depth = 10): LineUnit => ({ id, x, z, facing: 0, frontage, depth, row });

describe('draw-the-line placement', () => {
  it('smooths paths and keeps endpoints', () => {
    const p = smoothPath([{ x: 0, z: 0 }, { x: 10, z: 5 }, { x: 20, z: 0 }]);
    expect(p[0]).toEqual({ x: 0, z: 0 });
    expect(p[p.length - 1]).toEqual({ x: 20, z: 0 });
    expect(simplifyPath(p, 5).length).toBeLessThan(p.length);
  });

  it('matches units to places in order along the line, so paths never cross', () => {
    const units = [unit(0, 100, 100), unit(1, 100, 300), unit(2, 100, 200)];
    const out = planLine([{ x: 200, z: 350 }, { x: 200, z: 50 }], units, { x: 1, z: 0 });
    const zOf = (id: number) => out.find((p) => p.id === id)!.z;
    expect(zOf(1)).toBeGreaterThan(zOf(2));
    expect(zOf(2)).toBeGreaterThan(zOf(0));
  });

  it('faces along the line normal on the forward side', () => {
    const out = planLine([{ x: 200, z: 0 }, { x: 200, z: 300 }], [unit(0, 100, 100), unit(1, 100, 200)], { x: 1, z: 0 });
    for (const p of out) expect(Math.abs(p.facing)).toBeLessThan(0.01);
    const flipped = planLine([{ x: 200, z: 0 }, { x: 200, z: 300 }], [unit(0, 100, 100)], { x: -1, z: 0 });
    expect(Math.abs(Math.abs(flipped[0].facing) - Math.PI)).toBeLessThan(0.01);
  });

  it('stacks mixed selections front to back by role (skirmishers, lines, other infantry, cavalry)', () => {
    const units = [unit(0, 100, 100, roleRow('cavalry', 'cavalry')), unit(1, 100, 150, roleRow('skirmisher', 'loose')), unit(2, 100, 200, roleRow('infantry', 'line'))];
    const out = planLine([{ x: 200, z: 0 }, { x: 200, z: 300 }], units, { x: 1, z: 0 });
    const xOf = (id: number) => out.find((p) => p.id === id)!.x;
    // Facing +x, so "front" is larger x.
    expect(xOf(1)).toBeGreaterThan(xOf(2));
    expect(xOf(2)).toBeGreaterThan(xOf(0));
  });

  it('click-move keeps a group side by side, facing the direction of travel', () => {
    const out = planClickMove([unit(0, 0, 0), unit(1, 0, 60)], { x: 200, z: 30 });
    expect(out).toHaveLength(2);
    for (const p of out) expect(Math.abs(p.facing)).toBeLessThan(0.1);
    expect(Math.abs(out[0].z - out[1].z)).toBeGreaterThan(45);
  });

  it('route lanes give a group parallel copies of a curve', () => {
    const curve = Array.from({ length: 40 }, (_, i) => ({ x: i * 5, z: Math.sin(i / 6) * 40 }));
    const lanes = routeLanes(curve, [{ id: 0, x: 0, z: -30 }, { id: 1, x: 0, z: 30 }]);
    const a = lanes[0].path.slice(3, -3), b = lanes[1].path.slice(1);
    // Parallel: every point of one lane stays the same distance from the other lane.
    const gapAt = (p: { x: number; z: number }) => Math.min(...b.map((q) => Math.hypot(p.x - q.x, p.z - q.z)));
    const gap0 = gapAt(a[0]);
    expect(gap0).toBeGreaterThan(20);
    for (const p of a) expect(Math.abs(gapAt(p) - gap0)).toBeLessThan(3.5);
    // Each lane starts where its own unit stands.
    expect(lanes[0].path[0]).toEqual({ x: 0, z: -30 });
    // A single unit's lane is the drawn curve itself.
    const solo = routeLanes(curve, [{ id: 0, x: 0, z: 0 }])[0].path;
    expect(Math.abs(solo[Math.floor(solo.length / 2)].z - Math.sin(solo[Math.floor(solo.length / 2)].x / 30) * 40)).toBeLessThan(3);
  });
});

describe('stroke clean-up', () => {
  it('drops the hook a mouse makes on release', () => {
    const raw = [];
    for (let i = 0; i <= 60; i++) raw.push({ x: i * 2, z: 0 });
    raw.push({ x: 121, z: 3 }, { x: 119, z: 6 }, { x: 116, z: 7 });
    const s = cleanStroke(raw, false);
    const end = s[s.length - 1];
    expect(end.x).toBeGreaterThan(115);
    expect(Math.abs(end.z)).toBeLessThan(1);
  });

  it('lays a nearly straight stroke perfectly straight for a formation line', () => {
    const raw = [];
    for (let i = 0; i <= 50; i++) raw.push({ x: i * 3, z: Math.sin(i) * 1.2 });
    expect(cleanStroke(raw, true).length).toBe(2);
  });

  it('keeps a real curve', () => {
    const raw = [];
    for (let i = 0; i <= 50; i++) raw.push({ x: i * 3, z: 40 * Math.sin(i / 16) });
    expect(cleanStroke(raw, true).length).toBeGreaterThan(5);
  });
});

describe('formation lines without crossing', () => {
  it('units of a row reach their places without their straight paths crossing', () => {
    // Jumbled start: two rows of four, ordered against the line's direction.
    const units: LineUnit[] = [];
    for (let i = 0; i < 8; i++) units.push({ id: i, x: (i % 4) * 30 + (i < 4 ? 0 : 15), z: 120 - Math.floor(i / 4) * 40 + (i % 2) * 25, facing: 0, frontage: 24, depth: 6, row: 1 });
    const out = planLine([{ x: 200, z: 0 }, { x: 200, z: 300 }], units, { x: 1, z: 0 });
    const seg = (id: number) => { const u = units[id], p = out.find((q) => q.id === id)!; return [u.x, u.z, p.x, p.z]; };
    const cross = (a: number[], b: number[]) => {
      const d = (p: number[], q: number[], r: number[]) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
      const p1 = [a[0], a[1]], p2 = [a[2], a[3]], q1 = [b[0], b[1]], q2 = [b[2], b[3]];
      return d(p1, p2, q1) * d(p1, p2, q2) < 0 && d(q1, q2, p1) * d(q1, q2, p2) < 0;
    };
    for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) expect(cross(seg(i), seg(j)), `${i}-${j}`).toBe(false);
  });

  it('a small rear row packs behind the line instead of spreading to its ends', () => {
    const units: LineUnit[] = [
      ...[0, 1, 2, 3, 4, 5].map((i) => ({ id: i, x: 0, z: i * 40, facing: 0, frontage: 30, depth: 6, row: 1 })),
      { id: 10, x: -30, z: 90, facing: 0, frontage: 40, depth: 18, row: 2 },
      { id: 11, x: -30, z: 140, facing: 0, frontage: 40, depth: 18, row: 2 },
    ];
    const out = planLine([{ x: 100, z: -50 }, { x: 100, z: 300 }], units, { x: 1, z: 0 });
    const a = out.find((p) => p.id === 10)!, b = out.find((p) => p.id === 11)!;
    expect(Math.abs(a.z - b.z)).toBeLessThan(60);
  });
});
