export const TAU = Math.PI * 2;
export const deg = (d: number) => (d * Math.PI) / 180;

/** Signed smallest difference b - a, in (-PI, PI]. */
export function angleDiff(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

export function wrapAngle(a: number): number {
  return angleDiff(0, a);
}

/** Rotate `current` toward `target` by at most `maxStep` radians. */
export function turnToward(current: number, target: number, maxStep: number): number {
  const d = angleDiff(current, target);
  if (Math.abs(d) <= maxStep) return wrapAngle(target);
  return wrapAngle(current + Math.sign(d) * maxStep);
}

export interface Frame {
  x: number;
  z: number;
  facing: number;
}

/** Point in a unit's local frame: f = forward distance, l = lateral (positive = left of facing, toward +z when facing +x). */
export function toLocal(u: Frame, px: number, pz: number): { f: number; l: number } {
  const dx = px - u.x;
  const dz = pz - u.z;
  const c = Math.cos(u.facing);
  const s = Math.sin(u.facing);
  return { f: dx * c + dz * s, l: -dx * s + dz * c };
}

export function toWorld(u: Frame, f: number, l: number): { x: number; z: number } {
  const c = Math.cos(u.facing);
  const s = Math.sin(u.facing);
  return { x: u.x + f * c - l * s, z: u.z + f * s + l * c };
}

/** Which side of `u` the point lies on, judged from u's facing. */
export function sideOf(u: Frame, px: number, pz: number): 'front' | 'flank' | 'rear' {
  const { f, l } = toLocal(u, px, pz);
  const a = Math.abs(Math.atan2(l, f));
  if (a < deg(55)) return 'front';
  if (a > deg(125)) return 'rear';
  return 'flank';
}

/** Angle in degrees (0..180) between u's facing and the direction from u to the point. */
export function bearingFrom(u: Frame, px: number, pz: number): number {
  const { f, l } = toLocal(u, px, pz);
  return (Math.abs(Math.atan2(l, f)) * 180) / Math.PI;
}

/** Flank percentage per the wiki: (angle - front limit) / (full-flank limit - front limit), clamped 0..1. */
export function flankPercent(limits: [number, number] | null, angle: number): number {
  if (!limits) return 0;
  const [front, full] = limits;
  return Math.max(0, Math.min(1, (angle - front) / (full - front)));
}

export interface Box extends Frame {
  frontage: number;
  depth: number;
}

function axes(b: Box): [number, number][] {
  const c = Math.cos(b.facing), s = Math.sin(b.facing);
  return [[c, s], [-s, c]];
}

function project(b: Box, ax: number, az: number): [number, number] {
  const c = Math.cos(b.facing), s = Math.sin(b.facing);
  const center = b.x * ax + b.z * az;
  const r = (Math.abs(c * ax + s * az) * b.depth) / 2 + (Math.abs(-s * ax + c * az) * b.frontage) / 2;
  return [center - r, center + r];
}

/**
 * Separating-axis test between two oriented rectangles. Returns the minimum translation that moves
 * `a` out of `b` (unit normal and depth), or null if they don't overlap (allowing `margin`).
 */
export function obbOverlap(a: Box, b: Box, margin = 0): { nx: number; nz: number; depth: number } | null {
  let best = { nx: 0, nz: 0, depth: Infinity };
  for (const [ax, az] of [...axes(a), ...axes(b)]) {
    const [a0, a1] = project(a, ax, az);
    const [b0, b1] = project(b, ax, az);
    const o = Math.min(a1, b1) - Math.max(a0, b0) + margin;
    if (o <= 0) return null;
    if (o < best.depth) {
      const sign = (a0 + a1) / 2 < (b0 + b1) / 2 ? -1 : 1;
      best = { nx: ax * sign, nz: az * sign, depth: o - margin };
    }
  }
  return best;
}

/** Shared area as a fraction of the smaller footprint (wiki stacking rule), by sampling. */
export function overlapFraction(a: Box, b: Box): number {
  const [small, big] = a.frontage * a.depth <= b.frontage * b.depth ? [a, b] : [b, a];
  const N = 5;
  let inside = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const p = toWorld(small, ((i + 0.5) / N - 0.5) * small.depth, ((j + 0.5) / N - 0.5) * small.frontage);
      const { f, l } = toLocal(big, p.x, p.z);
      if (Math.abs(f) <= big.depth / 2 && Math.abs(l) <= big.frontage / 2) inside++;
    }
  }
  return inside / (N * N);
}

/** Closest point on the rectangle to (px, pz). */
export function nearestPoint(b: Box, px: number, pz: number): { x: number; z: number } {
  const { f, l } = toLocal(b, px, pz);
  return toWorld(b, Math.max(-b.depth / 2, Math.min(b.depth / 2, f)), Math.max(-b.frontage / 2, Math.min(b.frontage / 2, l)));
}

/** Does the segment p->q cross the rectangle? */
export function segmentHitsBox(b: Box, px: number, pz: number, qx: number, qz: number): boolean {
  const p = toLocal(b, px, pz), q = toLocal(b, qx, qz);
  const hx = b.depth / 2, hz = b.frontage / 2;
  let t0 = 0, t1 = 1;
  const df = q.f - p.f, dl = q.l - p.l;
  for (const [pd, d, lo, hi] of [[p.f, df, -hx, hx], [p.l, dl, -hz, hz]] as [number, number, number, number][]) {
    if (Math.abs(d) < 1e-9) {
      if (pd < lo || pd > hi) return false;
    } else {
      let a = (lo - pd) / d, c = (hi - pd) / d;
      if (a > c) [a, c] = [c, a];
      t0 = Math.max(t0, a);
      t1 = Math.min(t1, c);
      if (t0 > t1) return false;
    }
  }
  return true;
}
