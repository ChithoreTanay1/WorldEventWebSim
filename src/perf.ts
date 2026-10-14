// Frame profiler, off unless the URL has ?perf (or F3 is pressed). Shows stats.js panels (FPS, frame
// ms, draw calls) and keeps rolling numbers for automated runs on window.__perf: frame interval, CPU
// time per section, draw calls, triangles, long frames and JS heap allocation rate.
import Stats from 'stats.js';
import type { WebGLRenderer } from 'three';
import { gpuTimer } from './render/renderer';

const N = 600;

class Ring {
  readonly v = new Float32Array(N);
  n = 0;
  i = 0;
  push(x: number) {
    this.v[this.i] = x;
    this.i = (this.i + 1) % N;
    if (this.n < N) this.n++;
  }
  clear() {
    this.n = this.i = 0;
  }
  summary() {
    const a = Array.from(this.v.subarray(0, this.n)).sort((x, y) => x - y);
    const q = (p: number) => a[Math.min(a.length - 1, Math.floor(p * a.length))] ?? 0;
    const avg = a.reduce((s, x) => s + x, 0) / (a.length || 1);
    return { avg: round(avg), p50: round(q(0.5)), p95: round(q(0.95)), p99: round(q(0.99)), max: round(a[a.length - 1] ?? 0), n: a.length };
  }
}

function round(x: number) {
  return Math.round(x * 100) / 100;
}

interface MemoryInfo {
  usedJSHeapSize: number;
}

class Perf {
  enabled = new URLSearchParams(location.search).has('perf');
  /** The renderer currently on screen (set by the battle and the campaign map, profiling on or off). */
  renderer: WebGLRenderer | null = null;
  private stats: Stats | null = null;
  private callsPanel: Stats.Panel | null = null;
  private readonly interval = new Ring();
  private readonly cpu = new Ring();
  private readonly calls = new Ring();
  private readonly tris = new Ring();
  private readonly sections = new Map<string, Ring>();
  private readonly frameSections = new Map<string, number>();
  private frameStart = 0;
  private lastFrame = 0;
  private lastHeap = 0;
  private allocBytes = 0;
  private allocSince = performance.now();
  private gcDrops = 0;
  private readonly gpu = new Ring();

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F3') {
        e.preventDefault();
        this.enabled = !this.enabled;
        this.mount();
      }
    });
    if (this.enabled) this.mount();
    gpuTimer.onResult = (ms) => {
      if (this.enabled) this.gpu.push(ms);
    };
  }

  private mount() {
    if (!this.enabled) {
      this.stats?.dom.remove();
      return;
    }
    if (!this.stats) {
      this.stats = new Stats();
      this.callsPanel = this.stats.addPanel(new Stats.Panel('CALLS', '#ff8', '#221'));
      this.stats.dom.style.cssText = 'position:fixed;left:8px;top:96px;z-index:100;opacity:0.85;cursor:pointer';
    }
    document.body.append(this.stats.dom);
  }

  beginFrame(now: number) {
    if (!this.enabled) return;
    this.stats?.begin();
    if (this.lastFrame) this.interval.push(now - this.lastFrame);
    this.lastFrame = now;
    this.frameStart = performance.now();
    this.frameSections.clear();
  }

  /** Add CPU time to a named section of this frame. */
  add(section: string, ms: number) {
    if (!this.enabled) return;
    this.frameSections.set(section, (this.frameSections.get(section) ?? 0) + ms);
  }

  endFrame() {
    if (!this.enabled) return;
    this.cpu.push(performance.now() - this.frameStart);
    for (const [k, v] of this.frameSections) {
      let r = this.sections.get(k);
      if (!r) this.sections.set(k, (r = new Ring()));
      r.push(v);
    }
    const info = this.renderer?.info.render;
    if (info) {
      this.calls.push(info.calls);
      this.tris.push(info.triangles);
      this.callsPanel?.update(info.calls, 400);
    }
    const mem = (performance as unknown as { memory?: MemoryInfo }).memory;
    if (mem) {
      const h = mem.usedJSHeapSize;
      if (this.lastHeap) {
        if (h >= this.lastHeap) this.allocBytes += h - this.lastHeap;
        else this.gcDrops++;
      }
      this.lastHeap = h;
    }
    this.stats?.end();
  }

  reset() {
    this.interval.clear();
    this.cpu.clear();
    this.calls.clear();
    this.tris.clear();
    this.gpu.clear();
    this.sections.clear();
    this.allocBytes = 0;
    this.gcDrops = 0;
    this.allocSince = performance.now();
    this.lastHeap = 0;
  }

  report() {
    const iv = this.interval.summary();
    const secs = (performance.now() - this.allocSince) / 1000;
    return {
      fps: round(1000 / (iv.avg || 1)),
      frameInterval: iv,
      longFrames: Array.from(this.interval.v.subarray(0, this.interval.n)).filter((x) => x > 25).length,
      pixelRatio: this.renderer?.getPixelRatio() ?? 0,
      cpu: this.cpu.summary(),
      gpu: this.gpu.summary(),
      sections: Object.fromEntries([...this.sections].map(([k, r]) => [k, r.summary()])),
      drawCalls: this.calls.summary(),
      triangles: this.tris.summary(),
      allocMBps: round(this.allocBytes / 1048576 / (secs || 1)),
      gcDrops: this.gcDrops,
    };
  }
}

export const perf = new Perf();
(window as unknown as { __perf: Perf }).__perf = perf;
