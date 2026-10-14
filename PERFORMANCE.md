# Performance report: 60 FPS pass

Work done against [60fps.md](60fps.md). Target: a steady 60 FPS (16.6 ms frames) on integrated graphics, under ~200 draw calls, no GC stutter, gameplay unchanged.

## How it was measured

- **Machine:** Intel Iris Xe (integrated), Windows 11, Chrome with real GPU (ANGLE / D3D11).
- **Page:** 1920×1080 at 150% display scaling (a typical laptop), **`vite build` + `vite preview`**, no DevTools.
- **Profiler:** open the game with **`?perf`** (or press **F3**) for `stats.js` panels (FPS, ms, draw calls). `window.__perf.report()` returns:
  - frame interval (avg, p95, max)
  - long frames (over 25 ms)
  - CPU time per section (sim, controls, units, render, HUD, labels, march)
  - **GPU time** from WebGL timer queries
  - draw calls and triangles
  - JS heap allocation rate
- **Scenes:**
  - battle planning
  - battle planning with 11 order paths shown
  - battle resolving at 4× speed (twice)
  - battle zoomed out (markers)
  - campaign map: idle, zoomed out, and armies marching
- Each scene was measured for 2.4–5 s. Hot spots were found with Chrome's CPU profiler and heap sampling.

## Baseline (before)

| Scene | FPS | Long frames | CPU ms | GPU ms | Draw calls | Alloc MB/s |
|---|---|---|---|---|---|---|
| Battle planning | 55.6 | 22 | 5.1 | 10.0 | 105 | 12.3 |
| Battle resolving 4× | 55.5 | 11 | 5.4 | 9.7 | 96 | 21.4 |
| Battle zoomed out | 60.0 | 0 | 4.6 | 9.3 | 83 | 10.9 |
| Campaign idle | 59.8 | 1 | 6.2 | 9.9 | 128 | 3.0 |
| Campaign zoomed out | 51.8 | 41 | 9.0 | 11.9 | 358 | 6.0 |
| Campaign marching | 48.4 | 16 | 11.5 (spikes 46) | 12.0 | 361 | 8.1 |

**Verdict:** neither purely CPU- nor GPU-bound. Every scene paid about 10 ms of GPU time, mostly pixel fill (2880×1620 with 4× MSAA). On top of that came 5–11 ms of CPU and frequent GC, and together they overran 16.6 ms and dropped frames to 33 ms.

The profiler pinned the CPU and garbage on:
1. Three.js re-deriving shader programs on every draw of every transparent double-sided object (`getParameters`, `getProgramCacheKey`), every frame.
2. The unit renderer's per-soldier work: analytic terrain height, HSL colour maths, and string colour parsing.
3. One small mesh per unit part, town house and army standard, which brought per-object uniform uploads and frustum tests.
4. `getBoundingClientRect` once per map label every frame, which forced layout.
5. Order arrows rebuilt and re-simulated every frame. With 11 paths shown, this cost 5 ms of CPU, 46 MB/s of garbage, 99 GCs in 5 s and 130 draw calls.

The simulation itself cost 0.3–0.6 ms per frame.

## Changes, each measured

| # | Change | Effect |
|---|---|---|
| 1 | One shared renderer setup (`src/render/renderer.ts`): **no MSAA**, pixel ratio capped at **1.5**, no stencil | GPU ~10 → ~5 ms in every scene; long frames gone |
| 2 | `forceSinglePass` on transparent double-sided materials (order ribbons, arrows, chevrons, zones) | Ended the per-frame shader-program churn; draw calls 105 → 94, battle garbage −40% |
| 3 | **Unit renderer rewrite** (`src/render/unitLayer.ts`): every block part (plate, front, arrow, banner, flag, icon per type, NATO marker parts) is an `InstancedMesh` or one merged line set. Matrices and colours are written straight into typed arrays. A unit whose drawn state didn't change is skipped. Only changed soldier ranges are uploaded (`addUpdateRange`). Soldier colours are precomputed. **Render height cache** (`src/render/heightCache.ts`) on the terrain mesh's own triangles, so soldiers sit exactly on the visible ground. `Unit.footprint` cached instead of allocating per call. | Battle CPU 4.2 → 1.1 ms (planning), 5.7 → 2.6 ms (4×); draw calls 94 → 42; garbage 8–18 → 1.3–5 MB/s |
| 4 | **Campaign map**: all towns merged into 5 meshes (a vertex shader keeps the per-town zoom scaling), roads into 1, army standards instanced (6 calls total). Canvas rect read once per resize, not per label. Label styles written only when they change. Territory recolour rewritten as a flat number loop. | Draw calls 358 → 16; CPU 9 → 0.7 ms; labels 2.8 → 0.06 ms; end-of-march spike gone |
| 5 | **Order overlay batching** (`src/render/overlay.ts`): all ribbons and arrowheads go into two meshes, ghosts into one instanced box and one line set. Rebuilt only when orders, selection or zoom change (`controls.cachedVisuals`). Drag preview replanned once per frame, not per pointer event. | With 11 paths: CPU 7.6 → 1.4 ms, controls 5.1 → 0.03 ms, garbage 46 → 1.2 MB/s, draw calls 130 → 46 |
| 6 | **Adaptive resolution**, GPU-driven: if frames miss *and* measured GPU time is over 10 ms, the render scale steps down 0.125 (floor 1.0). It climbs back after 3 steady seconds when the larger frame fits. It never reacts to CPU contention, where it wouldn't help, and stays off without timer-query support. | No effect on a quiet machine (GPU ~5 ms). Under heavy background load it trimmed the battle to 1.375 and left the map at 1.5. |

## Final (after), quiet machine

| Scene | FPS | Long frames | CPU ms | GPU ms | Draw calls | Alloc MB/s |
|---|---|---|---|---|---|---|
| Battle planning | 60.0 | 0 | 1.0 | 4.8 | 44 | 1.3 |
| Battle planning, 11 paths | 60.0 | 0 | 1.4 | 5.1 | 46 | 1.2 |
| Battle resolving 4× | 60.0 | 0 | 1.9 | 5.0 | 47 | 5.4 |
| Battle zoomed out | 60.0 | 0 | 1.6 | 5.2 | 45 | 3.3 |
| Campaign idle | 60.0 | 0 | 0.8 | 4.6 | 16 | 0.7 |
| Campaign zoomed out | 60.0 | 0 | 0.7 | 4.6 | 16 | 0.7 |
| Campaign marching | 60.0 | 0 | 1.3 | 4.7 | 19 | 3.8 |

Frame budget used: about **6–7 ms of 16.6 ms**. All targets are met: 60 FPS, under 200 draw calls (16–47), and no GC stutter (max frame 17–19 ms with zero long frames).

**Gameplay is unchanged.** `tests/determinism.test.ts` plays three full battles from fixed seeds with scripted orders. They must end bit-identical to fingerprints recorded before this work, and they do. All 63 tests pass.

## When 60 FPS is not reached

**Heavy background load on the same laptop.** With other apps holding the CPU at 50–80%, the game's *own* per-frame CPU work slows 4–7× (the same 1 ms frame takes 6–8 ms), and the shared integrated GPU slows too (5 → 8–10 ms). In those runs the battle dropped to 40–50 FPS and the campaign to 54–58. The game can't fix that from inside. The adaptive resolution trims GPU load when the GPU is the problem; otherwise, close other heavy apps.

## Remaining bottlenecks and what was not done

- **Simulation allocations, about 3–5 MB/s while resolving.** Replay frame recording (one snapshot per unit per sub-step, by design) plus vision and line-of-sight work cause small young-generation GCs that never produced a long frame. Removing them means pooling snapshots and reworking vision; that's worth doing if battles grow much larger.
- **Not done, because the profile didn't point there** (rule 1):
  - struct-of-arrays typed-array sim
  - Web Worker / WebAssembly
  - spatial hash for collisions

  The sim costs 0.3–0.5 ms per frame with 20 units (p95 ~2 ms at 4×), and the O(n²) checks over 20 units are 400 pairs. Revisit at a few hundred units.
- **Already in place before this pass:**
  - fixed-step sim with interpolated rendering
  - zoom-out LOD (NATO markers)
  - no shadows or post-processing
  - single flat-shaded terrain mesh
- **Not added: FXAA.** Edges are slightly jaggier without MSAA. FXAA would cost a full-screen pass (~1 ms here); add it only if the look matters more than the headroom.
- **Bundle:** Three.js is imported by name and tree-shaken by Vite; the bundle is ~200 KB gzipped, mostly Three.js.
