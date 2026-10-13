# Build Instruction: Ancient India Lines-of-Battle Game (Prototype)

Build a browser-based, real-time-with-pause battle game with 3D block units, a free camera and draw-the-line army control. Prototype **one battle**, then expand.

## Prototype Scope

One **fictional, illustrative** battle: a Gupta-era army (c. 5th century CE) defeats a nomadic cavalry army on an open plain with a river on one flank.

- **Gupta side (player):** levy spearmen, heavy sword-and-shield infantry, archers, war elephants, heavy cavalry (lancers).
- **Invader side (AI):** mostly light horse archers, some heavy cavalry, a small skirmish infantry screen.
- **Intended winning pattern:** infantry and archers hold the center behind elephants, the enemy horse archers harass and attempt a feigned retreat, and Gupta cavalry on the wings (plus a held-back reserve) counter-charges the overextended enemy and hits its flank or rear.
- Label the battle as invented and the unit stats as estimates. Sources for this period are sparse, so do not present it as a historical reconstruction.

## Constraints

- Light and cheap: static site, no backend, no paid APIs, free hosting.
- Runs smoothly on integrated graphics. Keep the bundle small.
- No detailed models. Solid-color boxes and flat banners only.

## Stack

- Vite + TypeScript
- Three.js (low-FOV perspective or orthographic camera)
- DOM/CSS for UI panels over the canvas
- Optional: Yuka for steering and state machines
- Deterministic simulation in plain TypeScript with a fixed tick, no DOM code, separate from rendering

## Project Structure

```
/src
  /sim        units, combat, morale, orders, AI (no rendering code)
  /render     scene, camera, unit meshes, terrain, order-line overlay
  /input      selection, draw-line control, hotkeys
  /ui         unit card, order buttons, speed/pause, battle log
/data
  /units      unit type stats (JSON)
  /scenarios  battle setup (JSON)
```

Everything is data-driven. New units and battles must need no engine changes.

## Rendering

- Terrain: a heightmap plane with flat colors, a river, and hills that affect combat.
- Each unit is a 3D block: width is frontage, depth is ranks, height varies by type (elephants tall, infantry low).
- Top face shows a unit-type icon, front face shows a faction banner, and a facing arrow or colored front edge marks which way it points.
- Show strength physically: render each unit as a grid of tiny soldier-boxes with `InstancedMesh`, and remove them as casualties mount.
- State cues: shake or tint when wavering, soldiers scatter when routing.
- **Zoom-out swap:** when zoomed out, replace the 3D blocks with flat NATO-style markers (spear, archer, elephant, cavalry icons) so lines stay readable.
- Outlines on all units, and a top-down camera toggle for readability.

## Camera

- Pan (WASD or edge scroll), zoom (scroll), rotate (Q/E or middle mouse).
- Clamp pitch, zoom and map edges so the camera never goes under terrain.
- Optional follow-selected-unit mode.
- Camera input must never conflict with selection or orders.

## Controls (draw-the-line system)

- **Select:** click, shift-click to add, box-drag, double-click to select all of a type, hotkeys 1-9 for control groups. Raycast against unit blocks.
- **Draw a front:** right-click drag traces a path on the terrain (project onto the heightmap).
  1. Smooth the path with a Catmull-Rom spline and resample it at equal arc-length spacing, one slot per selected unit.
  2. Assign units to slots by sorting both along the line, so order lines never cross.
  3. Facing at each slot is the line's normal.
  4. Draw one **order line per unit** from its position to its slot, with an arrow at the slot showing facing, draped over the terrain.
  5. Show ghost blocks at the slots while dragging. Release to commit, Esc to cancel.
- **Arrival timing:** scale each unit's speed so the whole line arrives together, otherwise outer units on a wheel arrive late and the line is ragged.
- Units pivot and turn as formations. They do not slide sideways.
- **Quick orders:** single right-click to move, right-click an enemy to attack. Stances: hold, advance, charge, withdraw, fire at will.
- Pause with orders allowed, plus speed controls.

## Combat and Morale

- Each unit has strength (men), morale, facing, weapon stats, armor, speed and a footprint.
- Combat modifiers: flank and rear attacks, charge impact (cavalry, elephants), ranged vs. melee, terrain and elevation, fatigue.
- **Morale** drops from casualties, being flanked or hit from the rear, nearby units routing, elephant charges, and the general falling. It recovers slowly out of combat or near the general.
- **States:** steady, wavering (reduced attack, visual cue), retreating (disengages in order, facing the enemy), routing (uncontrollable, spreads panic, can be ridden down by cavalry), rallying (recovers once far from the enemy).
- Unit-type behavior: elephants are terrifying but can panic and trample their own lines; veterans hold longer than levies; horse archers avoid melee and kite.
- Victory condition: the enemy army breaks (most units routed or destroyed) or the Gupta army breaks.

## Unit Roster (starting estimates, tune by playtest)

| Unit | Role |
|---|---|
| Levy spearmen | Cheap line filler, low morale |
| Heavy infantry (sword and shield) | Core melee, holds the line |
| Archers | Ranged screen, vulnerable in melee |
| War elephants | Shock and morale weapon, risk of panic |
| Heavy cavalry (lancers) | Charge, flank and pursuit |
| Horse archers (enemy) | Harass, kite, feigned retreat |

## AI (two layers)

1. **Army level:** pick a plan (advance, hold, flank left or right, withdraw, feign retreat) by scoring troop ratio, terrain, morale and enemy position. Re-evaluate every few seconds.
2. **Unit level:** a small state machine per unit (move, engage, hold, rout, rally) with type rules, e.g. horse archers keep distance and shoot, retreat when approached, return when the enemy is disordered.
- The AI uses the same morale and retreat rules as the player. It should pull back wounded units and cover gaps with reserves.

## Data Model

**Unit type:**

```json
{
  "id": "heavy-cavalry",
  "name": "Heavy Cavalry",
  "men": 120,
  "attack": 7, "charge": 10, "armor": 6,
  "speed": 9, "morale": 8,
  "range": 0,
  "footprint": [3, 2],
  "icon": "cav-heavy"
}
```

**Scenario:**

```json
{
  "id": "gupta-frontier-battle",
  "terrain": { "size": [800, 600], "heightmap": "plain-river.png" },
  "sides": {
    "gupta": { "units": [{ "type": "heavy-cavalry", "pos": [120, 200], "facing": 0 }] },
    "invader": { "ai": true, "units": [{ "type": "horse-archers", "pos": [650, 300], "facing": 180 }] }
  }
}
```

## Build Order

1. Flat plane, tilted camera, two lines of boxes, camera controls.
2. Selection and the draw-the-line order system with ghost preview and order lines.
3. Movement: formation turning, slot arrival timing.
4. Melee combat with flank and rear modifiers, strength shown by shrinking blocks.
5. Morale and the retreat/rout/rally states.
6. Ranged units, cavalry charges, elephants.
7. Enemy AI (army plan plus unit state machines).
8. Terrain with a river and hills affecting combat.
9. Zoom-out NATO-style markers, unit card UI, pause and speed controls.
10. Balance the scenario so the intended cavalry-counter-charge win is possible but not guaranteed.

## Deliverable

A running Vite project with the one scenario playable: I can move the camera, select units, draw battle lines, fight the AI, and see units waver, retreat and rout. List which stats and mechanics are estimates, and anything that is a rough approximation.
