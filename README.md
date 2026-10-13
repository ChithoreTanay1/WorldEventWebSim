# Lines of Battle: Gupta Frontier (prototype)

A browser battle game, real-time with pause. You command an invented Gupta-era army (c. 5th century CE) against a nomad host on an open plain with a river on one flank. Units are 3D blocks filled with tiny box soldiers. You draw battle lines with the right mouse button, and the soldiers waver, fall back, rout and rally.

> **This battle is invented**, not a reconstruction. Sources for Gupta-era warfare are sparse. All unit stats and combat rules are estimates (see below).

## Run

```bash
npm install
npm run dev     # http://localhost:5173
npm test        # simulation, formation, data and balance tests
npm run build   # static build in dist/, deployable to GitHub Pages or Netlify
```

The game starts paused after the briefing, so you can set your lines before pressing **Space**. Press **F1** or **?** in-game for controls.

| Input | Action |
|---|---|
| Left click / drag | Select / box-select (Shift adds, double-click selects all of a type) |
| Right-drag | Draw a battle line: ghost blocks preview the slots, Esc cancels |
| Right click | Move (group keeps its frontage) or attack an enemy; Alt runs |
| WASD / arrows / screen edge, wheel, Q/E, middle-drag | Pan, zoom, rotate, tilt |
| T / Y | Top-down camera / follow selected unit |
| H G C X / F / Backspace | Hold, Advance, Charge, Withdraw / fire at will / halt |
| Alt+1-9, 1-9 | Assign / select control group |
| Space, + / - | Pause (orders still work), speed 1×/2×/4× |

## Layout

```
src/sim      deterministic simulation (fixed 20 Hz tick, seeded RNG, no DOM): units, movement,
             combat, morale, terrain, AI
src/render   Three.js scene: terrain, unit blocks + instanced soldiers, NATO markers, order lines, arrows
src/input    selection, draw-the-line maths (pure, unit tested), camera keys
src/ui       HUD: unit card, order bar, army bars, battle log, briefing/help/result dialogs
data/units       one JSON per unit type
data/scenarios   one JSON per battle (terrain, deployment, sides, AI flag)
```

New unit types and scenarios are data files only; the app discovers them by folder. Pick a scenario with `?scenario=<id>`.

## How the line drawing works

The dragged path is smoothed with a Catmull-Rom spline and measured by arc length. Each unit gets a slot whose width matches its frontage, and units widen or thin their ranks to fill the line within their formation limits. Units and slots are matched by sorting both along the line, so order lines never cross. Each slot faces along the line's normal, chosen to point away from the camera. Nearer units are slowed so the whole line arrives together, and formations pivot rather than slide sideways.

## Estimates and approximations

**Invented or estimated (tune freely):**
- The battle, its terrain, deployments and army sizes. Units are shown at reduced scale (12–160 figures each).
- Every number in `data/units/*.json`: attack, charge, armour, hit points, speeds, turn rates, morale, range, accuracy, ammunition and reload.
- Combat constants in `TUNING` (`src/sim/battle.ts`): melee kill rate, armour factor, flank ×1.5, rear ×2.0, charge impact, brace reduction against cavalry, and the morale thresholds (waver 45, fall back 22, rout 9).
- Morale shocks: casualties, flank and rear pressure, elephant fear, nearby routs, the general falling, and fatigue.
- Elephant panic and trampling, horses' reluctance to fight elephants, spearmen's bonus against cavalry.

**Rough approximations (simplified mechanics):**
- Units are rectangles. Melee is resolved between touching rectangles: only the front two ranks fight, and the attack side comes from the attacker's position relative to the defender's facing. There's no collision between friendly units.
- Missiles resolve as volleys with hit chances. The arrows you see are visual only.
- The terrain is analytic hills plus a river with one ford, not a heightmap image. This keeps the simulation independent of DOM and image decoding.
- Fatigue, elevation (±15%), and water (slower movement, weaker fighting) are coarse modifiers.
- The AI is rule-based, not search-based. It picks among harass, flank, advance and withdraw from troop ratio and enemy disorder, and runs per-type rules: horse archers kite and feign retreat, heavy horse ambush pursuers, and wounded units are relieved by a reserve.
- **Results:** a side breaks when fewer than 25% of its men are still fighting. A nomad withdrawal counts as a Gupta victory only if the nomads lost at least 45% of their fighting power; otherwise the result is "Indecisive".

**Balance:** checked headlessly with scripted players over 5 seeds (`tests/players.ts`).

| Strategy | Outcome |
|---|---|
| Intended pattern (hold the centre, counter-charge the enemy horse) | 5 wins |
| Passive | 5 draws |
| Lancers chase the horse archers | 5 draws |
| Reckless all-out charge | 4 draws, 1 win |

No scripted strategy currently *loses* outright: the Gupta line is very hard to break, so the nomads usually ride away instead.
