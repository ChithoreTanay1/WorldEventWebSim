// Draw-the-line maths, kept free of DOM and Three.js so it can be unit tested.
// A dragged path is smoothed (Catmull-Rom), measured by arc length, and cut into one slot per
// unit. Each slot's width matches its unit's frontage (units widen or thin to fill the line).
// Units and slots are matched by sorting both along the line, so order lines never cross.
import type { Slot } from '../sim/types';

export interface XZ {
  x: number;
  z: number;
}

export interface LineUnit {
  id: number;
  x: number;
  z: number;
  facing: number;
  frontage: number;
  spacing: number;
  /** Allowed frontage in files: [min, max]. */
  filesRange: [number, number];
  speed: number;
  /** Radians per second. */
  turnRate: number;
}

export interface LinePlan {
  id: number;
  slot: Slot;
  /** Speed multiplier so the whole line arrives together. */
  speedScale: number;
}

const GAP = 3;

/** Centripetal-ish Catmull-Rom through the points, sampled every `step` metres or so. */
export function smoothPath(points: XZ[], step = 1): XZ[] {
  if (points.length < 3) return points.slice();
  const out: XZ[] = [];
  const p = [points[0], ...points, points[points.length - 1]];
  for (let i = 1; i < p.length - 2; i++) {
    const [p0, p1, p2, p3] = [p[i - 1], p[i], p[i + 1], p[i + 2]];
    const n = Math.max(1, Math.ceil(Math.hypot(p2.x - p1.x, p2.z - p1.z) / step));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), z: f(p0.z, p1.z, p2.z, p3.z) });
    }
  }
  out.push(points[points.length - 1]);
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
      return {
        p: { x: path[i - 1].x + (path[i].x - path[i - 1].x) * u, z: path[i - 1].z + (path[i].z - path[i - 1].z) * u },
        t: tangent(path[i - 1], path[i]),
      };
    }
    acc += seg;
  }
  const n = path.length;
  const t = tangent(path[n - 2], path[n - 1]);
  const extra = s - acc;
  return { p: { x: path[n - 1].x + t.x * extra, z: path[n - 1].z + t.z * extra }, t };
}

/**
 * Plan a battle line along `rawPath` for `units`. `forward` is a hint for which way the line
 * should face (the camera's view direction on the ground): drawing left-to-right faces away
 * from the viewer.
 */
export function planLine(rawPath: XZ[], units: LineUnit[], forward: XZ): LinePlan[] {
  if (units.length === 0 || rawPath.length < 2) return [];
  const path = smoothPath(rawPath);
  const L = pathLength(path);
  const start = path[0], end = path[path.length - 1];
  const dir = { x: end.x - start.x, z: end.z - start.z };

  // Match units to slots in order along the line so their paths never cross.
  const ordered = [...units].sort((a, b) => (a.x * dir.x + a.z * dir.z) - (b.x * dir.x + b.z * dir.z));

  // Widths: scale current frontages to fill the line, within each unit's formation limits.
  const totalFront = ordered.reduce((s, u) => s + u.frontage, 0);
  const avail = Math.max(1, L - GAP * (ordered.length - 1));
  const widths = ordered.map((u) => {
    const lo = u.filesRange[0] * u.spacing;
    const hi = u.filesRange[1] * u.spacing;
    return Math.max(lo, Math.min(hi, (u.frontage * avail) / totalFront));
  });
  const used = widths.reduce((s, w) => s + w, 0) + GAP * (ordered.length - 1);
  let s = (L - used) / 2;

  const raw = ordered.map((u, i) => {
    const mid = s + widths[i] / 2;
    s += widths[i] + GAP;
    const { p, t } = pointAt(path, mid);
    let nx = t.z, nz = -t.x;
    if (nx * forward.x + nz * forward.z < 0) (nx = -nx), (nz = -nz);
    return { u, slot: { x: p.x, z: p.z, facing: Math.atan2(nz, nx), files: Math.max(1, Math.round(widths[i] / u.spacing)) } };
  });
  return withArrivalTiming(raw);
}

/** Single-click move for a group: a straight line through `to`, perpendicular to the approach. */
export function planClickMove(units: LineUnit[], to: XZ): LinePlan[] {
  if (units.length === 0) return [];
  const cx = units.reduce((s, u) => s + u.x, 0) / units.length;
  const cz = units.reduce((s, u) => s + u.z, 0) / units.length;
  let fx = to.x - cx, fz = to.z - cz;
  const d = Math.hypot(fx, fz);
  if (d < 5) {
    // Too short to infer a direction: keep the group's average facing.
    fx = units.reduce((s, u) => s + Math.cos(u.facing), 0);
    fz = units.reduce((s, u) => s + Math.sin(u.facing), 0);
  }
  const l = Math.hypot(fx, fz) || 1;
  fx /= l;
  fz /= l;
  if (units.length === 1) {
    const u = units[0];
    return withArrivalTiming([{ u, slot: { x: to.x, z: to.z, facing: Math.atan2(fz, fx), files: Math.round(u.frontage / u.spacing) } }]);
  }
  const width = units.reduce((s, u) => s + u.frontage, 0) + GAP * (units.length - 1);
  const tx = -fz, tz = fx;
  const path = [
    { x: to.x - (tx * width) / 2, z: to.z - (tz * width) / 2 },
    { x: to.x + (tx * width) / 2, z: to.z + (tz * width) / 2 },
  ];
  return planLine(path, units, { x: fx, z: fz });
}

/** Slow the quicker units so the whole line arrives at once instead of raggedly. */
function withArrivalTiming(raw: { u: LineUnit; slot: Slot }[]): LinePlan[] {
  const timed = raw.map(({ u, slot }) => {
    const dist = Math.hypot(slot.x - u.x, slot.z - u.z);
    const heading = Math.atan2(slot.z - u.z, slot.x - u.x);
    const turn = (angle(u.facing, heading) + angle(heading, slot.facing)) / u.turnRate;
    return { u, slot, dist, turn, march: dist / u.speed };
  });
  const T = Math.max(...timed.map((t) => t.march + t.turn));
  return timed.map(({ u, slot, march, turn }) => ({
    id: u.id,
    slot,
    speedScale: march > 0 && T - turn > 0 ? Math.max(0.25, Math.min(1, march / (T - turn))) : 1,
  }));
}

function angle(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}
