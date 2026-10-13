// RTS camera rig: orbits a ground target. Pan, zoom, yaw and pitch are clamped so the camera stays
// over the map and above the terrain.
import { PerspectiveCamera, Vector3 } from 'three';
import type { Terrain } from '../sim/terrain';

const MIN_DIST = 35;
const MAX_DIST = 720;
const MIN_PITCH = (18 * Math.PI) / 180;
const MAX_PITCH = (88 * Math.PI) / 180;

export class CameraRig {
  readonly camera: PerspectiveCamera;
  target = new Vector3();
  distance = 300;
  yaw = Math.PI; // camera sits at target + (cos yaw, sin yaw) * horizontal distance
  pitch = (48 * Math.PI) / 180;
  topDown = false;
  private savedPitch = this.pitch;
  /** Unit id to follow, or null. */
  follow: number | null = null;
  // Smoothed values actually used for rendering.
  private s = { x: 0, z: 0, distance: 300, yaw: Math.PI, pitch: this.pitch };

  constructor(private readonly terrain: Terrain, aspect: number) {
    this.camera = new PerspectiveCamera(38, aspect, 1, 5000);
  }

  setView(x: number, z: number, distance: number, yaw: number, pitch: number) {
    this.target.set(x, 0, z);
    this.distance = distance;
    this.yaw = yaw;
    this.pitch = pitch;
    this.s = { x, z, distance, yaw, pitch };
    this.apply();
  }

  /** Ground-plane forward (from camera toward target) and right vectors. */
  groundAxes(): { fx: number; fz: number; rx: number; rz: number } {
    const fx = -Math.cos(this.s.yaw), fz = -Math.sin(this.s.yaw);
    return { fx, fz, rx: -fz, rz: fx };
  }

  pan(forward: number, right: number) {
    const { fx, fz, rx, rz } = this.groundAxes();
    const k = this.distance / 300;
    this.target.x += (fx * forward + rx * right) * k;
    this.target.z += (fz * forward + rz * right) * k;
    this.follow = null;
    this.clamp();
  }

  zoom(factor: number) {
    this.distance = Math.max(MIN_DIST, Math.min(MAX_DIST, this.distance * factor));
  }

  rotate(dYaw: number, dPitch: number) {
    this.yaw += dYaw;
    if (!this.topDown) this.pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, this.pitch + dPitch));
  }

  toggleTopDown() {
    this.topDown = !this.topDown;
    if (this.topDown) {
      this.savedPitch = this.pitch;
      this.pitch = MAX_PITCH;
    } else {
      this.pitch = this.savedPitch;
    }
  }

  private clamp() {
    this.target.x = Math.max(0, Math.min(this.terrain.width, this.target.x));
    this.target.z = Math.max(0, Math.min(this.terrain.depth, this.target.z));
  }

  update(dt: number, followPos: { x: number; z: number } | null) {
    if (followPos) {
      this.target.x += (followPos.x - this.target.x) * Math.min(1, dt * 4);
      this.target.z += (followPos.z - this.target.z) * Math.min(1, dt * 4);
    }
    const k = 1 - Math.exp(-dt * 12);
    this.s.x += (this.target.x - this.s.x) * k;
    this.s.z += (this.target.z - this.s.z) * k;
    this.s.distance += (this.distance - this.s.distance) * k;
    this.s.yaw += (this.yaw - this.s.yaw) * k;
    this.s.pitch += (this.pitch - this.s.pitch) * k;
    this.apply();
  }

  get smoothedDistance(): number {
    return this.s.distance;
  }

  private apply() {
    const { x, z, distance, yaw, pitch } = this.s;
    const ty = this.terrain.height(x, z);
    const h = Math.cos(pitch) * distance;
    const cx = x + Math.cos(yaw) * h;
    const cz = z + Math.sin(yaw) * h;
    let cy = ty + Math.sin(pitch) * distance;
    // Never dip under the ground (e.g. low pitch behind a hill).
    const ground = this.terrain.height(cx, cz);
    if (cy < ground + 6) cy = ground + 6;
    this.camera.position.set(cx, cy, cz);
    // At straight-down pitch, lookAt needs a stable up vector aligned with the yaw.
    this.camera.up.set(0, 1, 0);
    if (pitch > MAX_PITCH - 0.01) this.camera.up.set(-Math.cos(yaw), 0, -Math.sin(yaw));
    this.camera.lookAt(x, ty, z);
  }
}
