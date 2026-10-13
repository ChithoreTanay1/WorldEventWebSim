import { describe, expect, it } from 'vitest';
import { pathLength, planClickMove, planLine, smoothPath, type LineUnit } from '../src/input/formation';

const unit = (id: number, x: number, z: number, frontage = 30): LineUnit => ({
  id, x, z, facing: 0, frontage, spacing: 1.2, filesRange: [10, 70], speed: 2.5, turnRate: Math.PI / 4,
});

describe('draw-the-line planning', () => {
  it('smooths and keeps endpoints', () => {
    const p = smoothPath([{ x: 0, z: 0 }, { x: 10, z: 5 }, { x: 20, z: 0 }]);
    expect(p[0]).toEqual({ x: 0, z: 0 });
    expect(p[p.length - 1]).toEqual({ x: 20, z: 0 });
    expect(pathLength(p)).toBeGreaterThan(20);
  });

  it('assigns slots in order along the line so paths never cross', () => {
    // Units listed out of order; the line runs from high z to low z.
    const units = [unit(0, 100, 100), unit(1, 100, 300), unit(2, 100, 200)];
    const plans = planLine([{ x: 200, z: 350 }, { x: 200, z: 50 }], units, { x: 1, z: 0 });
    const zOf = (id: number) => plans.find((p) => p.id === id)!.slot.z;
    expect(zOf(1)).toBeGreaterThan(zOf(2));
    expect(zOf(2)).toBeGreaterThan(zOf(0));
  });

  it('faces along the forward hint and widens units to fill a long line', () => {
    const plans = planLine([{ x: 200, z: 0 }, { x: 200, z: 300 }], [unit(0, 100, 100), unit(1, 100, 200)], { x: 1, z: 0 });
    for (const p of plans) expect(Math.abs(p.slot.facing)).toBeLessThan(0.01);
    for (const p of plans) expect(p.slot.files).toBeGreaterThan(30 / 1.2);
    const flipped = planLine([{ x: 200, z: 0 }, { x: 200, z: 300 }], [unit(0, 100, 100)], { x: -1, z: 0 });
    expect(Math.abs(Math.abs(flipped[0].slot.facing) - Math.PI)).toBeLessThan(0.01);
  });

  it('respects formation limits on a very short line', () => {
    const plans = planLine([{ x: 200, z: 0 }, { x: 200, z: 5 }], [unit(0, 100, 0)], { x: 1, z: 0 });
    expect(plans[0].slot.files).toBe(10);
  });

  it('slows nearer units so the line arrives together', () => {
    const plans = planLine([{ x: 200, z: 0 }, { x: 200, z: 200 }], [unit(0, 190, 50), unit(1, 0, 150)], { x: 1, z: 0 });
    const near = plans.find((p) => p.id === 0)!, far = plans.find((p) => p.id === 1)!;
    expect(far.speedScale).toBe(1);
    expect(near.speedScale).toBeLessThan(0.5);
  });

  it('click-move keeps the group side by side, facing the direction of travel', () => {
    const plans = planClickMove([unit(0, 0, 0), unit(1, 0, 40)], { x: 100, z: 20 });
    expect(plans).toHaveLength(2);
    for (const p of plans) expect(Math.abs(p.slot.facing)).toBeLessThan(0.05);
    expect(Math.abs(plans[0].slot.z - plans[1].slot.z)).toBeGreaterThan(25);
  });
});
