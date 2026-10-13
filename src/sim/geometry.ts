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
