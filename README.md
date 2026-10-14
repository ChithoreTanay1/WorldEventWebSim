# Lines of Battle: Gupta Frontier (prototype)

A browser battle game played in simultaneous turns (WEGO), with mechanics remodelled on the **Lines of Battle wiki (v1.7) "Game Mechanics"** pages. You command an invented Gupta-era army (c. 5th century CE) against a nomad host on a plain with a river on one flank. Units are 3D blocks of box soldiers; you draw lines, paths and facings with the right mouse button.

> **This battle is invented**, not a reconstruction. All unit stats are estimates. The wiki is Napoleonic; its rules are mapped onto this era, and numbers it doesn't give are our estimates (listed below).

## Run

```bash
npm install
npm run dev     # http://localhost:5173
npm test        # rules, formation, data and balance tests
npm run build   # static build in dist/ (GitHub Pages / Netlify)
```

The game opens on the **campaign map** (North India, 455 CE): march armies between towns in simultaneous turns, recruit (10 slots per town, every unit ready next turn), split and merge armies. When armies meet, *Take command* dives the camera into a generated battlefield and casualties carry back to the map. `?mode=battle` opens the standalone battle.

**Performance:** add `?perf` to the URL (or press F3) for an FPS / frame-time / draw-call overlay; `window.__perf.report()` gives CPU time per section, GPU time, draw calls and allocation rate. See [PERFORMANCE.md](PERFORMANCE.md) for the 60 FPS work and its numbers.

## How a battle plays

1. **Deployment turn.** Drag units into place inside your zone (they move instantly) and set formations. *Begin battle* reveals two neutral hills between the armies.
2. **Plan.** Time is stopped. Give each unit **one order** of a chosen type and queue formation changes. The AI plans at the same time and can't see your orders.
3. **End turn.** The turn resolves: **16 ticks**, attacks every 2 ticks. You can't interrupt it; **Replay** shows it again.
4. Orders expire at the end of the turn. Unfinished paths carry on (faded arrow); units without orders stand.
5. **Victory points** are recounted each turn. A side at 0 VP is knocked out; after 24 turns the leader wins unless the scores are within 10.

## Controls

| Input | Action |
|---|---|
| Left click / drag | Select / box-select. Shift adds. Double-click: on-screen units of the same type and formation |
| **Left-drag from a selected unit** | Draw its route: the unit follows the curve exactly; a group follows it in parallel lanes. A label by the cursor says what the drag will do |
| **1 2 3 4 5** | Order type: Fire & Advance, Run, Shoot, Walk, Fallback. Changing the type re-stamps the selection's drawn paths |
| **Y** | Clear the selection's orders |
| Right click ground | Move there with the current order type (a group stays side by side) |
| Right-drag | One unit: draw its path. Several: lay them along the line, stacked by role (skirmishers, lines, other infantry, cavalry). Starting on a single selected unit: **Rotate** it |
| Right click enemy / friend | Lock on (Shoot fires, Fire & Advance closes and fires, Walk/Run chase, Fallback backs away) / follow it (several units form a column) |
| **R T F G** | Formation slots (applied when the turn starts) |
| Ctrl / Alt / Shift + 1-9 | Assign / recall / add to control group (Ctrl+Shift assigns exclusively). On-screen groups bar: click recalls, Ctrl+click overwrites, **+** saves to a free slot |
| Space / Enter · P | End turn · replay last turn |
| WASD / arrows / edges · wheel · Q E | Pan · zoom (far out: NATO markers) · rotate |
| **Ctrl+Shift+left-drag** / middle-drag | Tilt the camera up and down (and turn it) |
| V · Z · + - | Top-down · follow selected · playback speed |
| Bottom bar | Order type, formation, autofire range (Close / Effective / Max) |

## Rules implemented (wiki page → what's in the game)

- **Turn Resolution:** simultaneous planning; 16-tick turns with the wiki's per-tick order (orders, autofire targets, flee direction, collisions and contact, organization field, attacks, organization update, movement, capture); formation changes at turn start; deployment turn; one-turn orders with re-sent multi-turn paths.
- **Orders / Order Types:** Walk, Run, Shoot, Fire & Advance (stand-off, −20% fire while moving), Fallback (backs off facing the enemy: −35% speed and fire, +15% org damage taken, −0.2 charge resistance), Rotate. Also lock-on, follow and column marching, and retyping a selection's orders.
- **Formations:** Column, Line, Spear Ring (our square), Loose (skirmish), Cavalry, Elephant, and Dispersed for routers. Each has its footprint, firing edges and emitters, flank-angle limits (Column 37.9°/142.1°, Line 79.2°/100.8°, Cavalry 63.4°/116.6°), modifiers, and break-down plus form-up times. Footprint and flank rules switch immediately; stats switch on completion. One change per turn; changes are blocked after melee and cancelled by a melee hit.
- **Melee:** `Atk²/(Atk+Def)/8` per swing times a factor product with a 0.2 floor (HP, org, stamina, terrain, stacking and formation factors). Flanking raises organization damage, not HP. Org loss = `dmg/maxHP × 10 × org ratio × factors`. Been In Melee status.
- **Charges:** the five requirements (Run, run-up, stamina above 40%, no Been In Melee, weapon can hit the target). Base charge × condition, penetration scaled by organization, charge resistance (org gate, nearby allies, formation, Fallback, about-face), flank resistance, backlash on the charger, and the 100-point stamina cost split by flank angle.
- **Ranged:** range bands with linear falloff; firing edges and emitters with shared firepower; friendly units blocking emitters; autofire range setting with panic fire. Limited-ammo units don't autofire on routers. Rear-fire bonus +150% org against line and column; formation attack and defence modifiers.
- **Organization:** max org lowered by HP loss and stamina. Route, recover, rally and shatter marks; Standing / Recovering / Routing states with a rout lock. A nearby-units field (clamped ±56, ×5 for routing receivers, panic sign-flip after breaking). Recovery shaped by HP, order, safety, VP deficit and suppression. Low-organization penalties to fire, melee, charges and movement. Routers flee toward their own side, pass through enemies for 12 ticks, desert at the map edge, and shatter.
- **Stamina:** run, melee, ranged, climbing and charge costs; banded recovery; penalties from 85% down to 40%.
- **Stacking:** overlap as a share of the smaller footprint; penalties from 10% to 60% (speed, melee, fire, org damage, org radius); 40%+ hard overlap clears the run-up; allies are nudged apart.
- **Objectives / Victory:** only standing infantry captures (2/tick); defended objectives can't be taken; big 60, small 15 and neutral-hill 15 VP; VP = base ± casualties + objectives − pressure; knockout at 0; tie margin at the turn limit; VP deficit slows organization recovery.
- **Fog of war:** shared team vision from standing units only; distance bands (hidden, silhouette, identified, full); ridges block sight; firing reveals a unit; skirmishers are harder to spot. The AI plays under the same fog.
- **Control Groups:** the full modifier scheme, the on-screen bar, initial groups by category, and the selection panel's click semantics.

**Skipped, as asked or not applicable:** army composition and battle budgets; ammunition reserves and refills; supply lines and entrenchment (WW2 only); the Fischer clock and online play; replay fog perspectives; the path-finding and curved-movement settings; the scenario editor and triggers; artillery and naval rules; terrain types beyond hills, river and ford.

## Mapping to this era and our estimates

- **Era mapping:** Spear Ring stands in for the square. War elephants use a flankable "Elephant Line" posture with a large organization aura. Javelin skirmishers use Loose order. Horse archers fire all round, like the wiki's cavalry.
- **Casualties (extension):** in the wiki, HP damage is mostly a vehicle for organization loss, so men barely die. We keep organization damage exactly as the wiki computes it, but multiply the men killed: melee ×4, charges ×2.5, missiles ×2.2, and ×2 more against routers caught in melee. Both sides lose men in a fight, a charger pays when it hits braced spears, and each turn's losses are reported in the log.
- **Extensions not in the wiki:**
  - Spears add +0.35 charge resistance against horse and elephants.
  - Routing elephants trample whatever they run through.
  - Horses fight elephants at −40%.
  - A side with no standing or recovering units is knocked out.
- **Estimated values the wiki doesn't give:**
  - Turn time: one turn plays in about 7.7 s at 1×; walk and run distances per turn are in `data/units`.
  - Organization marks and recovery share (6% of max per turn), safety distance (160 m).
  - Rout-lock and panic durations, run-up time (3 ticks), run stamina cost (160/turn), elevation step (2.5 m).
  - VP base (25) and the casualty scale (±120 × difference in power lost), pressure penalty rate.
  - Vision range (420 m) and spotting bands.
  - All unit stats.
- **Scale:** the battlefield is 1 km × 600 m, much smaller than wiki maps. Movement per turn is scaled down to fit, and the nearby-units field uses 3 points per radius-bonus point instead of the wiki's 5.

## Balance (scripted players, 3 seeds, `tests/balance.test.ts`)

| Strategy | Result |
|---|---|
| Intended pattern: advance the infantry on the objectives, counter-charge their horse | 3 wins |
| Passive (no orders) | 3 ties |
| Lancers chase the horse archers | 1 win, 2 ties (narrow) |
| Reckless: everything runs at the nearest enemy | 3 wins (**too strong, needs tuning**) |

Under the strict wiki rule only infantry captures or contests objectives, and the nomads have none. Their only defence is driving capturers off, so a determined infantry push is currently hard for them to stop.

## Project layout

```
src/sim      deterministic WEGO engine: types, constants, combat formulas, battle (ticks, org, stamina,
             stacking, objectives, VP, fog), AI planner — no DOM
src/render   Three.js: terrain, unit blocks + instanced soldiers (from recorded frames), order overlay,
             markings (objectives, range fan, org radius, deployment zone), arrow volleys
src/input    controls, draw-the-line placement maths
src/ui       HUD
src/campaign campaign map: geography, armies and turns, AI, recruiting, battle generation (toScenario),
             map renderer, HUD and the mode that hands off to a BattleSession
data/units       unit types        data/formations  formation postures       data/scenarios  battles
data/campaign    campaign maps (towns, roads, rivers, armies, reinforcements)
```
