// Scripted stand-ins for a human player, used to check scenario balance headlessly under WEGO rules.
import type { Battle } from '../src/sim/battle';
import type { Unit } from '../src/sim/unit';

const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const visibleEnemies = (b: Battle) => b.units.filter((e) => e.side !== b.player && e.alive && b.seen(b.player, e) > 0);
const mine = (b: Battle) => b.units.filter((u) => u.side === b.player && u.standing);

/**
 * The intended pattern: advance the infantry line on the enemy objectives with archers firing,
 * elephants alongside; lancers and the general hold the wings and counter-charge enemy horse
 * that comes within reach.
 */
export function goodPlayer(b: Battle) {
  const enemies = visibleEnemies(b);
  const goal = b.objectives
    .filter((o) => o.owner !== b.player)
    .sort((a, c) => (a.size === 'small' ? 0 : a.size === 'hill' ? 1 : 2) - (c.size === 'small' ? 0 : c.size === 'hill' ? 1 : 2) || a.x - c.x)[0];
  if (!goal) return;
  const line = mine(b).filter((u) => u.type.category === 'infantry' || u.type.category === 'missile' || u.type.category === 'elephant');
  const order = [...line].sort((a, c) => a.z - c.z);
  const spacing = 62;
  order.forEach((u, i) => {
    const lz = goal.z + (i - (order.length - 1) / 2) * spacing * 0.5;
    const lx = goal.x - (u.type.category === 'missile' ? -25 : 15);
    const near = enemies.filter((e) => !e.routing).sort((a, c) => dist(a, u) - dist(c, u))[0];
    if (u.type.category === 'missile' && near && dist(near, u) < 170) b.setOrder(u.id, { type: 'shoot', target: near.id });
    else if (u.type.category === 'elephant' && near && near.type.category === 'cavalry' && dist(near, u) < 160) b.setOrder(u.id, { type: 'walk', target: near.id });
    else b.setOrder(u.id, { type: 'walk', path: [{ x: lx, z: Math.max(30, Math.min(520, lz)) }], facing: 0 });
  });
  for (const u of mine(b).filter((x) => x.type.category === 'cavalry')) {
    const prey = enemies
      .filter((e) => !e.routing && e.type.category === 'cavalry' && dist(e, u) < u.type.run * 0.85 && (e.type.id === 'steppe-lancers' || e.contacts.length > 0))
      .sort((a, c) => dist(a, u) - dist(c, u))[0];
    if (prey && u.staminaFrac > 0.5) b.setOrder(u.id, { type: 'run', target: prey.id });
    else {
      const anchor = order[u.z < 300 ? 0 : order.length - 1] ?? u;
      b.setOrder(u.id, { type: 'walk', path: [{ x: anchor.x - 30, z: anchor.z + (u.z < 300 ? -70 : 70) }], facing: 0 });
    }
  }
}

/** Everyone runs at the nearest visible enemy, every turn. */
export function recklessPlayer(b: Battle) {
  const enemies = visibleEnemies(b);
  for (const u of mine(b)) {
    const t = enemies.filter((e) => !e.routing).sort((a, c) => dist(a, u) - dist(c, u))[0];
    if (t) b.setOrder(u.id, { type: 'run', target: t.id });
    else b.setOrder(u.id, { type: 'run', path: [{ x: u.x + 150, z: u.z }] });
  }
}

/** Lancers chase the nearest horse archers: the feigned retreat's victim. Infantry stays put. */
export function chaserPlayer(b: Battle) {
  const enemies = visibleEnemies(b);
  for (const u of mine(b).filter((x: Unit) => x.type.category === 'cavalry')) {
    const t = enemies.filter((e) => e.type.id === 'horse-archers' && !e.routing).sort((a, c) => dist(a, u) - dist(c, u))[0];
    if (t) b.setOrder(u.id, { type: 'run', target: t.id });
  }
}
