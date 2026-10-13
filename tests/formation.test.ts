import { describe, expect, it } from 'vitest';
import { planClickMove, planLine, roleRow, simplifyPath, smoothPath, type LineUnit } from '../src/input/formation';

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
});
