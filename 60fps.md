# Performance Instruction: Make the Game Run at a Stable 60 FPS

Goal: the browser game (Three.js + TypeScript) must hold a stable 60 FPS on integrated graphics. Refactor and rewrite the code as needed to get there.

## Rules

1. **Profile first.** Before rewriting anything, add `stats.js` and measure. Record baseline FPS, frame time, draw calls (`renderer.info.render.calls`) and whether the frame is CPU-bound (scripting) or GPU-bound. Rewrite only what the numbers point to.
2. **Keep behavior identical.** Rewrites must not change gameplay results. Keep the sim deterministic.
3. **Measure after each change** and report the before/after numbers.
4. Test with `vite build` + `vite preview`, not the dev server, with DevTools closed.

## Targets

- 60 FPS (16.6 ms frame) with the full prototype battle on screen.
- Under ~200 draw calls.
- No garbage-collection stutter during battle (no per-frame allocations in hot paths).

## Rendering Fixes

- Replace one-mesh-per-soldier with `InstancedMesh`, one per unit type or material. Update instance matrices only for units that changed (set `instanceMatrix.needsUpdate` selectively).
- Share geometries and materials. Never create them inside update loops.
- Cap the pixel ratio: `Math.min(devicePixelRatio, 1.5)`.
- No MSAA. Use no antialiasing or FXAA.
- No real-time shadow maps. Use blob or baked shadows under units.
- No post-processing unless profiling shows spare budget.
- Frustum culling on. Terrain as a single mesh, low-poly, flat-shaded.
- Order lines and overlays: batch into as few draw calls as possible.
- Zoom-out LOD: swap 3D blocks for flat 2D icon markers when zoomed out.

## Simulation Fixes

- Run the sim on a fixed tick (10-20 Hz), separate from rendering, and interpolate positions in the render loop.
- Replace O(n²) neighbor and collision checks with a spatial grid or hash.
- Convert hot data from arrays of JSON-style objects to **typed arrays in struct-of-arrays layout** (e.g. `Float32Array` for x, z, facing, morale, strength). Load JSON data once at startup into these structures. Do not read JSON objects in per-tick loops.
- Remove per-frame allocations: no `new Vector3()`, no `.map()`/`.filter()`/spread in hot loops. Pool and reuse objects.
- Cache expensive results (pathing, line-slot assignments) and recompute only when inputs change.
- If the sim still exceeds budget after the above, move it into a **Web Worker** and pass state through transferable typed arrays. Consider WebAssembly only if profiling proves a specific hot loop needs it.

## Data and Loading

- Validate and convert all JSON (units, scenarios) at load time into the optimized runtime structures. Keep the JSON files as authoring format only.
- Keep the bundle small: tree-shake Three.js imports, import only what is used.

## Deliverable

1. A short baseline report (FPS, frame time, draw calls, CPU vs GPU bound).
2. The refactored code.
3. A final report with the same metrics, a list of changes made, and any remaining bottlenecks. State clearly if 60 FPS was not reached on a given scenario and why.
