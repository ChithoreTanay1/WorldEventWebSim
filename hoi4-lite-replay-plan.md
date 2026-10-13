# Build Instruction: HOI4-Style War Replay (Trial Version)

Build a static browser app that plays back historical wars as scripted, non-interactive replays, styled like Hearts of Iron IV, with Kings & Generals-style battle scenes.

## Trial Scope

Build the engine and **two periods only**:

1. **Punic Wars**: Second Punic War (218-201 BC), with the **Battle of Cannae** as the battle scene.
2. **Napoleonic Wars**: the 1805 campaign (or a coarse overview of 1803-1815), with the **Battle of Austerlitz** as the battle scene.

Each period needs its own map, factions, territory snapshots, unit paths, events and one battle scene. Make it easy to add more wars later by adding data files only, with no engine changes.

## Constraints

- Cheap and light: static site, no backend, no database, no paid APIs, free hosting (GitHub Pages or Netlify).
- Small bundle. No game engine, no 3D.
- No simulation or AI. All outcomes are pre-authored data.
- Only user input: choose a war, play/pause, change speed, scrub the timeline.

## Stack

- Vite + TypeScript
- D3 + SVG for the map (no tile server, no API keys)
- Plain DOM + CSS for the UI
- GSAP for battle animation
- Vanilla state (`currentDate`, `selectedWar`)

## Project Structure

```
/src
  /engine    timeline clock, interpolation, event dispatcher
  /map       province rendering, unit counters
  /battle    tactical scene player
  /ui        top bar, popups, sidebar log, war selector
/data
  /wars      one JSON per war
  /battles   one JSON per battle
  /maps      one GeoJSON/SVG region set per war
```

## Strategic Layer (HOI4 style)

- Dark, muted UI. Top bar with date and pause/speed buttons. Event log sidebar.
- Map with flat province fills by faction color, thin borders, subtle paper/terrain texture.
- Banner-style unit counters showing army size, moving along interpolated paths.
- Classic centered event popup (title, short text, one button). Playback pauses until dismissed.
- Province-level regions (100-300 per war), grouped into factions. Coarse is fine.

## Battle Scenes (Kings & Generals style)

- Triggered by an event that references a battle. Pause the timeline, zoom in, cross-fade to a top-down tactical view, then fade back.
- Terrain as a simple SVG (gradients, rivers, hills) with a dark vignette.
- Units as colored blocks in formations (infantry rectangles, cavalry as distinct shapes, skirmishers as dots), with arrows for movement and flanking.
- Played in timed phases, each with a caption. Interpolate positions between phases with easing.

## Data Model

**War file:**

```json
{
  "id": "second-punic-war",
  "start": "-218-01-01",
  "end": "-201-01-01",
  "map": "mediterranean-218bc.geojson",
  "factions": [{ "id": "rome", "color": "#b22222" }],
  "territory": [
    { "date": "-218-01-01", "controls": { "rome": ["italia"] } }
  ],
  "units": [
    { "id": "hannibal", "faction": "carthage",
      "path": [{ "date": "-218-05-01", "pos": [2.2, 41.4] }] }
  ],
  "events": [{ "date": "-216-08-02", "title": "Cannae", "text": "...", "battle": "cannae" }]
}
```

**Battle file:**

```json
{
  "id": "cannae",
  "terrain": "cannae.svg",
  "phases": [
    { "t": 0, "caption": "Armies deploy",
      "units": [{ "id": "rom-inf", "side": "rome", "type": "infantry", "pos": [300,400], "size": [200,60] }] },
    { "t": 1, "caption": "Cavalry engages",
      "moves": [{ "id": "car-cav-r", "to": [520,260], "dur": 3 }] }
  ]
}
```

## Technical Notes

- **Dates:** JS `Date` breaks on BC years. Use an integer day count internally and write your own formatter.
- **Borders:** modern GeoJSON is wrong for historical eras. Use hand-drawn or simplified regions per war (Historical Basemaps by aourednik is a reference). Simplify geometry with mapshaper.
- **Performance:** move unit counters with CSS transforms instead of re-rendering the map. Keep the sim logic free of DOM code.

## Build Order

1. Static map for the Punic Wars with provinces colored by faction.
2. Timeline slider and play/pause switching territory snapshots.
3. HOI4 UI shell: top bar, speed controls, fonts, panel textures.
4. Unit counters moving along interpolated paths.
5. Event popups that pause playback, plus sidebar log.
6. Battle scene engine with Cannae.
7. Map-to-battle zoom and cross-fade transition.
8. War selector, then add the Napoleonic Wars with Austerlitz using only new data files.

## Deliverable

A running Vite project where I can select either the Punic Wars or the Napoleonic Wars, watch the replay with the HOI4-style layout, and trigger a battle scene from each. Use approximate, clearly labeled illustrative data, and tell me which coordinates and dates need manual verification.
