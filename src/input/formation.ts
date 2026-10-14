// Draw-the-line maths (pure, unit tested). Dragging with several units lays them along the line exactly
// as drawn, one row from end to end; facing comes from the line's angle at each unit.
import { planCurve } from '../sim/pathing';
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

/**
 * Tidy a freehand stroke: drop the hook a mouse makes on release (a short tail that turns sharply away
 * from where the stroke was heading) and, if asked, snap a nearly straight stroke perfectly straight.
 */
export function cleanStroke(raw: XZ[], straighten: boolean): XZ[] {
  const pts = simplifyPath(raw, 2);
  if (pts.length < 3) return pts;
  const L = pathLength(pts);
  const a = pointAt(pts, L * 0.2).p, b = pointAt(pts, L * 0.85).p;
  const dl = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const dx = (b.x - a.x) / dl, dz = (b.z - a.z) / dl;
  const maxTrim = Math.max(6, L * 0.12);
  let trimmed = 0;
  while (pts.length > 2) {
    const n = pts.length, p = pts[n - 2], q = pts[n - 1];
    const seg = Math.hypot(q.x - p.x, q.z - p.z) || 1;
    if (((q.x - p.x) * dx + (q.z - p.z) * dz) / seg > Math.cos((50 * Math.PI) / 180)) break;
    if (trimmed + seg > maxTrim) break;
    pts.pop();
    trimmed += seg;
  }
  if (!straighten) return pts;
  const s = pts[0], e = pts[pts.length - 1];
  const cl = Math.hypot(e.x - s.x, e.z - s.z) || 1;
  let dev = 0;
  for (const p of pts) dev = Math.max(dev, Math.abs((p.x - s.x) * (e.z - s.z) - (p.z - s.z) * (e.x - s.x)) / cl);
  return dev < Math.max(2.5, cl * 0.05) ? [s, e] : pts;
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
 * Lay `units` along the line exactly as it was drawn: one row from the start of the stroke to its end,
 * spread evenly over its whole length (a single unit stands at its middle), each unit facing out from
 * the line at its own point of the curve. `forward` picks which side is the front (the camera's view
 * direction: drawing left to right faces away from the viewer). Units take places in the order that
 * keeps their paths from crossing. Only if the stroke is too short for everyone do the rest form a
 * second row behind, packed where those units already stand.
 */
export function planLine(rawPath: XZ[], units: LineUnit[], forward: XZ): Placement[] {
  if (units.length === 0 || rawPath.length < 2) return [];
  const path = smoothPath(rawPath);
  const L = pathLength(path);
  const start = path[0], end = path[path.length - 1];
  const dir = { x: end.x - start.x, z: end.z - start.z };
  // Units in their order across the line, then cut into rows that fit the drawn length.
  const ordered = [...units].sort((a, b) => a.x * dir.x + a.z * dir.z - (b.x * dir.x + b.z * dir.z));
  const rows: LineUnit[][] = [[]];
  let used = 0;
  for (const u of ordered) {
    const need = (rows[rows.length - 1].length ? GAP : 0) + u.frontage;
    if (rows[rows.length - 1].length && used + need > L + 1) {
      rows.push([]);
      used = 0;
    }
    rows[rows.length - 1].push(u);
    used += rows[rows.length - 1].length > 1 ? need : u.frontage;
  }
  const out: Placement[] = [];
  let back = 0;
  rows.forEach((row, ri) => {
    const place = (order: LineUnit[]): Placement[] => {
      const width = order.reduce((s, u) => s + u.frontage, 0) + GAP * (order.length - 1);
      let gap: number, s: number;
      if (ri === 0) {
        // The front row spans the stroke: first unit at its start, last at its end.
        gap = order.length > 1 ? Math.max(GAP, (L - order.reduce((a, u) => a + u.frontage, 0)) / (order.length - 1)) : 0;
        s = order.length > 1 ? Math.min(0, (L - width) / 2) : L / 2 - order[0].frontage / 2;
      } else {
        gap = GAP;
        const centre = arcPosition(path, order.reduce((a, u) => a + u.x, 0) / order.length, order.reduce((a, u) => a + u.z, 0) / order.length);
        s = width >= L ? (L - width) / 2 : Math.max(0, Math.min(L - width, centre - width / 2));
      }
      const depth = Math.max(...order.map((u) => u.depth));
      return order.map((u) => {
        const { p, t } = pointAt(path, s + u.frontage / 2);
        let nx = t.z, nz = -t.x;
        if (nx * forward.x + nz * forward.z < 0) (nx = -nx), (nz = -nz);
        const off = back + depth / 2;
        s += u.frontage + gap;
        return { id: u.id, x: p.x - nx * off, z: p.z - nz * off, facing: Math.atan2(nz, nx) };
      });
    };
    // Order within the row: start from the order across the line, then swap any two units while it
    // shortens their combined march (two crossing paths are always longer than uncrossed ones).
    let order = row;
    let best = place(order);
    const cost = (pl: Placement[]) => pl.reduce((a, p, i) => a + Math.hypot(order[i].x - p.x, order[i].z - p.z), 0);
    let bestCost = cost(best);
    for (let pass = 0, improved = true; improved && pass < 6; pass++) {
      improved = false;
      for (let i = 0; i < order.length; i++) {
        for (let j = i + 1; j < order.length; j++) {
          const trial = [...order];
          [trial[i], trial[j]] = [trial[j], trial[i]];
          const prev = order;
          order = trial;
          const pl = place(trial);
          const c = cost(pl);
          if (c < bestCost - 1e-6) {
            best = pl;
            bestCost = c;
            improved = true;
          } else order = prev;
        }
      }
    }
    out.push(...best);
    back += Math.max(...row.map((u) => u.depth)) + ROW_GAP;
  });
  return out;
}

/** Arc length along `path` of the point on it nearest to (x, z). */
function arcPosition(path: XZ[], x: number, z: number): number {
  let best = 0, bd = Infinity, acc = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    const t = len ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (len * len))) : 0;
    const d = Math.hypot(a.x + dx * t - x, a.z + dz * t - z);
    if (d < bd) (bd = d), (best = acc + t * len);
    acc += len;
  }
  return best;
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
 * where the drag started, so a group follows a curve in parallel lanes instead of piling onto one line.
 * The shared route is first rounded to at least the group's half-width: a wide group wheels round a
 * corner, and no lane can fold back on itself.
 */
export function routeLanes(rawPath: XZ[], units: { id: number; x: number; z: number }[]): { id: number; path: XZ[] }[] {
  // Drop mouse jitter first (keep a point every ~5 m), then round the curve through what's left.
  let path = smoothPath(simplifyPath(rawPath, 5), 3);
  if (path.length < 2) return units.map((u) => ({ id: u.id, path }));
  const origin = path[0];
  const t0 = { x: path[1].x - origin.x, z: path[1].z - origin.z };
  const l0 = Math.hypot(t0.x, t0.z) || 1;
  const n0 = { x: -t0.z / l0, z: t0.x / l0 };
  const offs = units.map((u) => (units.length === 1 ? 0 : (u.x - origin.x) * n0.x + (u.z - origin.z) * n0.z));
  const wide = Math.max(0, ...offs.map(Math.abs));
  if (wide > 0) {
    const curve = planCurve({ x: origin.x, z: origin.z, facing: Math.atan2(t0.z, t0.x) }, path, wide + 8);
    path = [origin, ...curve];
  }
  const normalAt = (i: number) => {
    const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return { x: -(b.z - a.z) / l, z: (b.x - a.x) / l };
  };
  return units.map((u, ui) => {
    const off = offs[ui];
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
