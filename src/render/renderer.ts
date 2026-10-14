// One renderer setup for the battle and the campaign map, tuned for integrated graphics: no MSAA
// (the biggest GPU cost at laptop resolutions), pixel ratio capped at 1.5, no stencil buffer.
//
// Adaptive resolution keeps play smooth when the GPU can't keep up (on an integrated chip other
// apps' load slows it too): it measures real GPU time per frame with timer queries, steps the render
// scale down only when frames are missing *and* the GPU is the bottleneck, and climbs back to full
// sharpness once there is headroom. If the CPU is the contended part, lowering resolution wouldn't
// help, so it leaves the picture alone. Without timer-query support it stays off.
import type { WebGLRenderer } from 'three';
import { WebGLRenderer as Renderer } from 'three';

export const MAX_PIXEL_RATIO = 1.5;
/** Never render below this pixel ratio (or the device's own, if lower). */
const MIN_PIXEL_RATIO = 1;
const STEP = 0.125;
/** GPU ms per frame above which the GPU is treated as the bottleneck, and the target after sharpening. */
const GPU_HEAVY = 10;
const GPU_ROOM = 8;

export function createRenderer(canvas: HTMLCanvasElement): WebGLRenderer {
  const r = new Renderer({ canvas, antialias: false, stencil: false, powerPreference: 'high-performance' });
  r.setPixelRatio(targetRatio());
  return r;
}

function targetRatio(): number {
  return Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);
}

interface TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

/** GPU time of each frame's rendering (EXT_disjoint_timer_query_webgl2), read back a few frames later. */
class GpuTimer {
  private gl: WebGL2RenderingContext | null = null;
  private ext: TimerExt | null = null;
  private pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  /** Results since the last drain, and an optional listener (the profiler). */
  sum = 0;
  count = 0;
  onResult: ((ms: number) => void) | null = null;

  get supported(): boolean {
    return this.ext !== null;
  }

  begin(r: WebGLRenderer) {
    if (this.active) return;
    const gl = r.getContext() as WebGL2RenderingContext;
    if (gl !== this.gl) {
      this.gl = gl;
      this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      this.pending = [];
    }
    if (!this.ext || this.pending.length > 8) return;
    const q = gl.createQuery();
    if (!q) return;
    gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }

  end() {
    if (!this.active || !this.gl || !this.ext) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  poll() {
    const gl = this.gl, ext = this.ext;
    if (!gl || !ext) return;
    while (this.pending.length) {
      const q = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) {
        const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        this.sum += ms;
        this.count++;
        this.onResult?.(ms);
      }
      gl.deleteQuery(q);
    }
  }
}

export const gpuTimer = new GpuTimer();

class AdaptiveResolution {
  private misses = 0;
  private frames = 0;
  private steady = 0;
  private window = 0;

  /** Call once per frame with the frame interval (seconds) and the renderer on screen. */
  update(dt: number, r: WebGLRenderer) {
    gpuTimer.poll();
    // Ignore stalls longer than a few frames (tab switches, dialogs): they say nothing about load.
    if (dt > 0.1) return;
    this.frames++;
    this.window += dt;
    if (dt > 1 / 50) this.misses++;
    if (this.window < 1) return;
    const missRate = this.misses / this.frames;
    const gpu = gpuTimer.count ? gpuTimer.sum / gpuTimer.count : 0;
    gpuTimer.sum = gpuTimer.count = 0;
    this.misses = this.frames = 0;
    this.window = 0;
    if (!gpuTimer.supported || gpu === 0) return;
    const ratio = r.getPixelRatio();
    const floor = Math.min(MIN_PIXEL_RATIO, targetRatio());
    if (missRate > 0.1 && gpu > GPU_HEAVY && ratio > floor) {
      r.setPixelRatio(Math.max(floor, ratio - STEP));
      this.steady = 0;
      return;
    }
    // Sharpen again after three steady seconds, if the larger frame should still fit (cost ~ pixels).
    const next = Math.min(targetRatio(), ratio + STEP);
    if (missRate < 0.02 && next > ratio && gpu * (next / ratio) ** 2 < GPU_ROOM) {
      if (++this.steady >= 3) {
        r.setPixelRatio(next);
        this.steady = 0;
      }
    } else this.steady = 0;
  }
}

export const adaptiveResolution = new AdaptiveResolution();
