// Draw-the-line maths (pure, unit tested). Following the Lines of Battle wiki: dragging with several
// units lays the selection along the line, stacked front to back by role (skirmishers, then lines,
// then other infantry, then cavalry); facing comes from the line's angle.
import type { XZ } from '../sim/types';

export type { XZ };

export interface LineUnit {
  id: number;
  x: number;
  z: number;
  facing: number;
  frontage: number;
  depth: number;
  /** 0 front row .. 3 back row */
  row: number;
}

export interface Placement {
  id: number;
  x: number;
  z: number;
  facing: number;
}

const GAP = 4;
const ROW_GAP = 10;

/** Catmull-Rom through the points, sampled every `step` metres or so. */
export function smoothPath(points: XZ[], step = 2): XZ[] {
  if (points.length < 3) return points.slice();
  const out: XZ[] = [];
  const p = [points[0], ...points, points[points.length - 1]];
  for (let i = 1; i < p.length - 2; i++) {
    const [p0, p1, p2, p3] = [p[i - 1], p[i], p[i + 1], p[i + 2]];
    const n = Math.max(1, Math.ceil(Math.hypot(p2.x - p1.x, p2.z - p1.z) / step));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), z: f(p0.z, p1.z, p2.z, p3.z) });
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

/** Reduce a dense freehand path to waypoints roughly `spacing` metres apart. */
export function simplifyPath(points: XZ[], spacing = 20): XZ[] {
  if (points.length < 2) return points.slice();
  const out = [points[0]];
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    acc += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
    if (acc >= spacing) {
      out.push(points[i]);
      acc = 0;
    }
  }
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

export function pathLength(path: XZ[]): number {
  let L = 0;
  for (let i = 1; i < path.length; i++) L += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
  return L;
}

/** Point and unit tangent at arc length s; extrapolates straight past either end. */
export function pointAt(path: XZ[], s: number): { p: XZ; t: XZ } {
  const tangent = (a: XZ, b: XZ) => {
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
  };
  if (s <= 0) {
    const t = tangent(path[0], path[1]);
    return { p: { x: path[0].x + t.x * s, z: path[0].z + t.z * s }, t };
  }
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const seg = Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
    if (acc + seg >= s && seg > 0) {
      const u = (s - acc) / seg;
      return { p: { x: path[i - 1].x + (path[i].x - path[i - 1].x) * u, z: path[i - 1].z + (path[i].z - path[i - 1].z) * u }, t: tangent(path[i - 1], path[i]) };
    }
    acc += seg;
  }
  const n = path.length;
  const t = tangent(path[n - 2], path[n - 1]);
  return { p: { x: path[n - 1].x + t.x * (s - acc), z: path[n - 1].z + t.z * (s - acc) }, t };
}

/**
 * Lay `units` along `rawPath` in rows by role. `forward` picks which side of the line is the front
 * (we use the camera's view direction: drawing left-to-right faces away from the viewer).
 * Units are matched to places by sorting both along the line, so their paths don't cross.
 */
export function planLine(rawPath: XZ[], units: LineUnit[], forward: XZ): Placement[] {
  if (units.length === 0 || rawPath.length < 2) return [];
  const path = smoothPath(rawPath);
  const L = pathLength(path);
  const start = path[0], end = path[path.length - 1];
  const dir = { x: end.x - start.x, z: end.z - start.z };
  const rows = [...new Set(units.map((u) => u.row))].sort((a, b) => a - b);
  const out: Placement[] = [];
  let back = 0;
  for (const row of rows) {
    const inRow = units.filter((u) => u.row === row).sort((a, b) => a.x * dir.x + a.z * dir.z - (b.x * dir.x + b.z * dir.z));
    const width = inRow.reduce((s, u) => s + u.frontage, 0) + GAP * (inRow.length - 1);
    // Spread a row over the whole line if it is long enough, otherwise centre it.
    const spare = Math.max(0, L - width);
    const gap = inRow.length > 1 ? GAP + spare / (inRow.length - 1) : 0;
    let s = inRow.length > 1 ? Math.min(0, (L - width) / 2) : L / 2 - inRow[0].frontage / 2;
    const depth = Math.max(...inRow.map((u) => u.depth));
    for (const u of inRow) {
      const { p, t } = pointAt(path, s + u.frontage / 2);
      let nx = t.z, nz = -t.x;
      if (nx * forward.x + nz * forward.z < 0) (nx = -nx), (nz = -nz);
      const off = back + depth / 2;
      out.push({ id: u.id, x: p.x - nx * off, z: p.z - nz * off, facing: Math.atan2(nz, nx) });
      s += u.frontage + gap;
    }
    back += depth + ROW_GAP;
  }
  return out;
}

/** Single right-click with several units: keep them side by side, centred on the click, facing the way they travel. */
export function planClickMove(units: LineUnit[], to: XZ): Placement[] {
  if (units.length === 0) return [];
  const cx = units.reduce((s, u) => s + u.x, 0) / units.length;
  const cz = units.reduce((s, u) => s + u.z, 0) / units.length;
  let fx = to.x - cx, fz = to.z - cz;
  if (Math.hypot(fx, fz) < 5) {
    fx = units.reduce((s, u) => s + Math.cos(u.facing), 0);
    fz = units.reduce((s, u) => s + Math.sin(u.facing), 0);
  }
  const l = Math.hypot(fx, fz) || 1;
  fx /= l;
  fz /= l;
  if (units.length === 1) return [{ id: units[0].id, x: to.x, z: to.z, facing: Math.atan2(fz, fx) }];
  const width = Math.max(...[0, 1, 2, 3].map((r) => units.filter((u) => u.row === r).reduce((s, u) => s + u.frontage + GAP, 0)));
  const tx = -fz, tz = fx;
  return planLine([{ x: to.x - (tx * width) / 2, z: to.z - (tz * width) / 2 }, { x: to.x + (tx * width) / 2, z: to.z + (tz * width) / 2 }], units, { x: fx, z: fz });
}

/** Role row for draw-line stacking (wiki): skirmishers, lines, other infantry, cavalry. */
export function roleRow(category: string, formation: string): number {
  if (category === 'skirmisher' || formation === 'loose') return 0;
  if (formation === 'line') return 1;
  if (category === 'cavalry') return 3;
  return 2;
}

/**
 * Give each unit of a group its own copy of a drawn route, shifted sideways by the unit's offset from
 * the route's start, so a group follows a curve in parallel lanes instead of piling onto one line.
 */
export function routeLanes(rawPath: XZ[], units: { id: number; x: number; z: number }[]): { id: number; path: XZ[] }[] {
  // Drop mouse jitter first (keep a point every ~5 m), then round the curve through what's left.
  const path = smoothPath(simplifyPath(rawPath, 5), 3);
  if (path.length < 2) return units.map((u) => ({ id: u.id, path }));
  const normalAt = (i: number) => {
    const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return { x: -(b.z - a.z) / l, z: (b.x - a.x) / l };
  };
  const n0 = normalAt(0);
  const cx = units.reduce((s, u) => s + u.x, 0) / units.length;
  const cz = units.reduce((s, u) => s + u.z, 0) / units.length;
  return units.map((u) => {
    const off = units.length === 1 ? 0 : (u.x - cx) * n0.x + (u.z - cz) * n0.z;
    const lane = path.map((p, i) => ({ x: p.x + normalAt(i).x * off, z: p.z + normalAt(i).z * off }));
    // Join each lane where its own unit stands: drop leading points it has already passed, so the
    // route doesn't double back to the drag's starting line.
    let k = 0;
    while (k < lane.length - 2) {
      const a = lane[k], b = lane[k + 1];
      if ((b.x - a.x) * (b.x - u.x) + (b.z - a.z) * (b.z - u.z) > 0) break;
      k++;
    }
    return { id: u.id, path: [{ x: u.x, z: u.z }, ...lane.slice(k + 1)] };
  });
}
