// Smart curved movement (Lines of Battle setting): a freehand path becomes a curve the unit can
// actually trace at its turning radius. Corners tighter than the unit can turn are rounded off;
// a turn so sharp it would mean circling round is taken as a halt-and-pivot instead, the way a
// unit "stops and turns before it goes anywhere". The same steering law drives the battle and the
// order preview, so the ghost shows exactly where the unit ends its turn.
import { angleDiff, turnToward, wrapAngle } from './geometry';
import type { XZ } from './types';

export interface Pose {
  x: number;
  z: number;
  facing: number;
}

/** Waypoints closer than this are reached (the battle pops them). */
export const ARRIVE = 1.5;
/** Spacing of the planned track's points, metres. */
const TRACK_STEP = 2;
/** Beyond this much turn the unit pivots on the spot instead of swinging round an arc. */
const PIVOT = (100 * Math.PI) / 180;
/** At the start, a unit facing further off than this turns first, then sets off straight. */
const START_PIVOT = (60 * Math.PI) / 180;
/** A reversal sharper than this makes infantry and cavalry about-face (stand, then flip). */
export const ABOUT_FACE = (135 * Math.PI) / 180;

/** Turning radius at a given speed and turn rate (both per turn). */
export function turnRadius(speed: number, turn: number): number {
  return turn > 1e-6 ? Math.max(0.5, speed / turn) : 1e6;
}

/** Drop near-duplicate points and resample a polyline every `step` metres. */
export function resample(pts: XZ[], step: number): XZ[] {
  if (pts.length < 2) return pts.slice();
  const out: XZ[] = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const seg = Math.hypot(b.x - a.x, b.z - a.z);
    if (seg < 1e-6) continue;
    let t = step - carry;
    while (t <= seg) {
      out.push({ x: a.x + ((b.x - a.x) * t) / seg, z: a.z + ((b.z - a.z) * t) / seg });
      t += step;
    }
    carry = seg - (t - step);
  }
  const last = pts[pts.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last.x - tail.x, last.z - tail.z) > 0.3) out.push(last);
  else out[out.length - 1] = last;
  return out;
}

/**
 * Plan the curve a unit at `pose` traces to follow `drawn` (a path starting at or near the unit).
 * Pure pursuit with a curvature limit: the unit chases a point a little ahead on the drawn line and
 * may turn at most 1/radius per metre. `backwards` plans for a unit walking rear-first (Fallback).
 * Returns waypoints every ~2 m, ending exactly at the drawn end; the unit's own position is not included.
 */
export function planCurve(pose: Pose, drawn: XZ[], radius: number, backwards = false): XZ[] {
  const end = drawn[drawn.length - 1];
  const P = resample([{ x: pose.x, z: pose.z }, ...drawn], 1);
  if (P.length < 2) return [end];
  const cum = [0];
  for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i].x - P[i - 1].x, P[i].z - P[i - 1].z));
  const L = cum[cum.length - 1];
  const look = Math.max(3, Math.min(28, radius * 0.9));
  const at = (s: number): XZ => {
    if (s >= L) return end;
    let lo = 1, hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < s) lo = mid + 1;
      else hi = mid;
    }
    const i = lo;
    const t = (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
    return { x: P[i - 1].x + (P[i].x - P[i - 1].x) * t, z: P[i - 1].z + (P[i].z - P[i - 1].z) * t };
  };
  let x = pose.x, z = pose.z;
  let h = backwards ? wrapAngle(pose.facing + Math.PI) : pose.facing;
  const first = at(look);
  const want0 = Math.atan2(first.z - z, first.x - x);
  if (Math.abs(angleDiff(h, want0)) > START_PIVOT) h = want0;
  const ds = 1, maxTurn = ds / radius;
  const out: XZ[] = [];
  let s = 0, si = 0, since = 0;
  const limit = Math.ceil((L * 2 + Math.PI * 2 * radius) / ds) + 50;
  for (let k = 0; k < limit; k++) {
    if (Math.hypot(end.x - x, end.z - z) <= ds * 1.5) break;
    // Track progress along the drawn line: nearest point, searching forward from where we were.
    // (P is resampled every metre, so a window of indices is a window of distance.)
    let bi = si, bd = Infinity;
    for (let j = si; j < Math.min(P.length, si + Math.ceil(look) + 6); j++) {
      const d = (P[j].x - x) ** 2 + (P[j].z - z) ** 2;
      if (d < bd) (bd = d), (bi = j);
    }
    si = bi;
    s = cum[si];
    const target = s + look >= L ? end : at(s + look);
    const want = Math.atan2(target.z - z, target.x - x);
    const d = angleDiff(h, want);
    if (Math.abs(d) > PIVOT) {
      // Too sharp to swing round: halt here and pivot (the battle turns on the spot at a corner).
      if (out.length === 0 || out[out.length - 1].x !== x || out[out.length - 1].z !== z) out.push({ x, z });
      since = 0;
      h = want;
    } else h += Math.max(-maxTurn, Math.min(maxTurn, d));
    x += Math.cos(h) * ds;
    z += Math.sin(h) * ds;
    since += ds;
    if (since >= TRACK_STEP) {
      out.push({ x, z });
      since = 0;
    }
  }
  out.push(end);
  return out;
}

/**
 * One movement step toward `goal`, the law the battle uses: turn toward the direction of travel
 * (or away from it, walking backwards), and move in proportion to how well aligned the unit is.
 */
export function steerStep(pose: Pose, goal: XZ, backwards: boolean, turnStep: number, maxStep: number): { facing: number; step: number; heading: number } {
  const dx = goal.x - pose.x, dz = goal.z - pose.z;
  const dist = Math.hypot(dx, dz);
  const heading = Math.atan2(dz, dx);
  const want = backwards ? wrapAngle(heading + Math.PI) : heading;
  const facing = turnToward(pose.facing, want, turnStep);
  const rem = Math.abs(angleDiff(facing, want));
  const advance = rem < 0.3 ? 1 : rem < 0.9 ? Math.cos(rem) * 0.6 : 0;
  return { facing, step: Math.min(dist, maxStep * advance), heading };
}

export interface MovePreview {
  /** Where the unit walks this turn, starting at its position. */
  track: XZ[];
  end: Pose;
  /** Index into the path of the first waypoint not yet reached. */
  next: number;
  done: boolean;
}

/**
 * Dry-run a path order for one turn with the battle's steering law: the solid arrow and the ghost.
 * Ignores what the battle can't know in advance (collisions, fire, terrain speed changes).
 */
export function previewMove(
  pose: Pose, path: XZ[], speed: number, turn: number, steps: number, substeps: number,
  opts: { backwards?: boolean; aboutFace?: boolean; finalFacing?: number },
): MovePreview {
  const dt = 1 / steps;
  const p: Pose = { ...pose };
  const track: XZ[] = [{ x: p.x, z: p.z }];
  let i = 0, wait = 0;
  for (let k = 0; k < steps; k++) {
    if (wait > 0) {
      // About-face: the unit stands for the rest of two ticks, then has turned round.
      if ((k + 1) % substeps === 0 && --wait === 0) p.facing = wrapAngle(p.facing + Math.PI);
      continue;
    }
    while (i < path.length && Math.hypot(path[i].x - p.x, path[i].z - p.z) < ARRIVE) i++;
    if (i >= path.length) {
      if (opts.finalFacing !== undefined) p.facing = turnToward(p.facing, opts.finalFacing, turn * dt);
      continue;
    }
    const goal = path[i];
    const heading = Math.atan2(goal.z - p.z, goal.x - p.x);
    if (opts.aboutFace && !opts.backwards && Math.abs(angleDiff(p.facing, heading)) > ABOUT_FACE) {
      wait = 2;
      continue;
    }
    const st = steerStep(p, goal, !!opts.backwards, turn * dt, speed * dt);
    p.facing = st.facing;
    if (st.step > 0) {
      p.x += Math.cos(st.heading) * st.step;
      p.z += Math.sin(st.heading) * st.step;
      const last = track[track.length - 1];
      if (Math.hypot(p.x - last.x, p.z - last.z) > 0.8) track.push({ x: p.x, z: p.z });
    }
  }
  const last = track[track.length - 1];
  if (last.x !== p.x || last.z !== p.z) track.push({ x: p.x, z: p.z });
  while (i < path.length && Math.hypot(path[i].x - p.x, path[i].z - p.z) < ARRIVE) i++;
  return { track, end: p, next: i, done: i >= path.length };
}
