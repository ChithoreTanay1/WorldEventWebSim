// Scripted stand-ins for a human player, used to check the scenario's balance headlessly.
import type { Battle } from '../src/sim/battle';

/** The intended winning pattern: hold the centre; lancers and the general counter-charge enemy horse that comes close. */
export function goodPlayer(b: Battle) {
  if (b.ticks % 40 !== 0) return;
  const mine = b.units.filter((u) => u.side === 'gupta' && u.controllable);
  const cx = mine.reduce((s, u) => s + u.x, 0) / Math.max(1, mine.length);
  const cz = mine.reduce((s, u) => s + u.z, 0) / Math.max(1, mine.length);
  for (const u of mine) {
    if (u.type.class !== 'cavalry' || u.contacts.length) continue;
    const prey = b.units
      .filter((e) => e.side === 'invader' && e.alive &&
        ((Math.hypot(e.x - cx, e.z - cz) < 200 && (e.type.id === 'steppe-lancers' || e.contacts.length > 0)) ||
          (Math.hypot(e.x - u.x, e.z - u.z) < 250 && e.state !== 'steady')))
      .sort((a, c) => Math.hypot(a.x - u.x, a.z - u.z) - Math.hypot(c.x - u.x, c.z - u.z))[0];
    if (prey) b.orderAttack(u.id, prey.id, true);
    else if (u.order?.kind === 'attack') b.halt(u.id);
  }
}

/** Everyone charges at once. */
export function recklessPlayer(b: Battle) {
  if (b.ticks !== 20) return;
  for (const u of b.units) if (u.side === 'gupta') b.setStance(u.id, 'charge');
}

/** Lancers chase the nearest horse archers wherever they go: the feigned retreat's victim. */
export function chaserPlayer(b: Battle) {
  if (b.ticks % 40 !== 0) return;
  for (const u of b.units) {
    if (u.side !== 'gupta' || u.type.class !== 'cavalry' || !u.controllable || u.contacts.length) continue;
    const ha = b.units.filter((e) => e.side === 'invader' && e.alive && e.type.id === 'horse-archers')
      .sort((a, c) => Math.hypot(a.x - u.x, a.z - u.z) - Math.hypot(c.x - u.x, c.z - u.z))[0];
    if (ha) b.orderAttack(u.id, ha.id, true);
  }
}
