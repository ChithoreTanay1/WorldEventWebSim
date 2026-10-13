// Scene composition: renderer, lights, terrain, units, order overlay and effects.
import { Color, DirectionalLight, Fog, HemisphereLight, Scene, Vector3, WebGLRenderer } from 'three';
import type { Battle } from '../sim/battle';
import { CameraRig } from './camera';
import { Effects } from './effects';
import { OrderOverlay } from './overlay';
import { buildTerrain } from './terrainView';
import { UnitLayer } from './unitLayer';

const SKY = '#c3c9c4';

export class View {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly rig: CameraRig;
  units: UnitLayer;
  readonly overlay: OrderOverlay;
  effects: Effects;
  private readonly v = new Vector3();

  constructor(readonly canvas: HTMLCanvasElement, private battle: Battle) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.scene.background = new Color(SKY);
    this.scene.fog = new Fog(SKY, 900, 2600);
    this.scene.add(new HemisphereLight('#e4ecf2', '#6a5b3c', 1.1));
    const sun = new DirectionalLight('#fff0d6', 1.7);
    sun.position.set(-300, 500, 200);
    this.scene.add(sun);
    this.scene.add(buildTerrain(battle.terrain));
    this.rig = new CameraRig(battle.terrain, 1);
    this.units = new UnitLayer(battle);
    this.scene.add(this.units.root);
    this.overlay = new OrderOverlay(battle.terrain);
    this.scene.add(this.overlay.root);
    this.effects = new Effects(battle.terrain);
    this.scene.add(this.effects.mesh);
    this.resize();
  }

  /** Swap in a fresh battle (restart). Terrain is rebuilt only if the scenario differs. */
  setBattle(battle: Battle) {
    this.battle = battle;
    this.units.dispose();
    this.units = new UnitLayer(battle);
    this.scene.add(this.units.root);
    this.scene.remove(this.effects.mesh);
    this.effects = new Effects(battle.terrain);
    this.scene.add(this.effects.mesh);
    this.overlay.show([]);
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.rig.camera.aspect = w / h;
    this.rig.camera.updateProjectionMatrix();
  }

  frame(alpha: number, dt: number, time: number) {
    const f = this.rig.follow !== null ? this.battle.unit(this.rig.follow) : null;
    this.rig.update(dt, f && f.alive ? { x: f.x, z: f.z } : null);
    for (const v of this.battle.volleys) this.effects.spawn(v);
    this.battle.volleys.length = 0;
    this.effects.update(dt);
    this.units.update(alpha, time, this.rig.smoothedDistance);
    this.renderer.render(this.scene, this.rig.camera);
  }

  /** Ground point under a client-space pixel, by marching the view ray over the heightfield. */
  pickGround(clientX: number, clientY: number): { x: number; z: number } | null {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new Vector3(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1, 0.5);
    const cam = this.rig.camera;
    ndc.unproject(cam);
    const dir = ndc.sub(cam.position).normalize();
    const o = cam.position;
    const t = this.battle.terrain;
    let prev = 0;
    for (let s = 0; s < 6000; s += 3) {
      const x = o.x + dir.x * s, y = o.y + dir.y * s, z = o.z + dir.z * s;
      const h = t.inside(x, z) ? t.height(x, z) : -0.15;
      if (y <= h) {
        // Refine between the last two samples.
        let lo = prev, hi = s;
        for (let k = 0; k < 12; k++) {
          const mid = (lo + hi) / 2;
          const mx = o.x + dir.x * mid, my = o.y + dir.y * mid, mz = o.z + dir.z * mid;
          if (my <= (t.inside(mx, mz) ? t.height(mx, mz) : -0.15)) hi = mid;
          else lo = mid;
        }
        return { x: o.x + dir.x * hi, z: o.z + dir.z * hi };
      }
      prev = s;
      if (dir.y >= 0 && y > 2000) break;
    }
    return null;
  }

  /** World point to client-space pixel. */
  project(x: number, y: number, z: number): { x: number; y: number; visible: boolean } {
    const r = this.canvas.getBoundingClientRect();
    this.v.set(x, y, z).project(this.rig.camera);
    return { x: r.left + ((this.v.x + 1) / 2) * r.width, y: r.top + ((1 - this.v.y) / 2) * r.height, visible: this.v.z < 1 };
  }
}
