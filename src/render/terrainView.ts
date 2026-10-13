// Flat-coloured terrain mesh built from the simulation's analytic heightfield, plus water and a
// few instanced trees for scale.
import {
  BufferAttribute, BufferGeometry, Color, ConeGeometry, Group, InstancedMesh, Matrix4, Mesh,
  MeshLambertMaterial, PlaneGeometry,
} from 'three';
import { Rng } from '../sim/rng';
import { WATER_LEVEL, type Terrain } from '../sim/terrain';

const CELL = 4;

export function buildTerrain(terrain: Terrain): Group {
  const group = new Group();
  const nx = Math.round(terrain.width / CELL);
  const nz = Math.round(terrain.depth / CELL);
  const pos = new Float32Array((nx + 1) * (nz + 1) * 3);
  const col = new Float32Array((nx + 1) * (nz + 1) * 3);
  const grass = new Color('#7b8a48'), dry = new Color('#b19e62'), lush = new Color('#5e7a3c'), mud = new Color('#6f6446'), sand = new Color('#a89670');
  const c = new Color();
  const half = (terrain.river?.width ?? 0) / 2;
  let i = 0;
  for (let iz = 0; iz <= nz; iz++) {
    for (let ix = 0; ix <= nx; ix++) {
      const x = (ix / nx) * terrain.width;
      const z = (iz / nz) * terrain.depth;
      const h = terrain.height(x, z);
      pos[i] = x;
      pos[i + 1] = h;
      pos[i + 2] = z;
      const rd = terrain.riverDistance(x, z);
      if (h < WATER_LEVEL + 0.3) c.copy(mud);
      else if (rd < half + 4) c.copy(sand);
      else {
        c.copy(grass).lerp(dry, Math.max(0, Math.min(1, (h - 1.5) / 7)));
        if (rd < half + 40) c.lerp(lush, 0.6 * (1 - (rd - half - 4) / 36));
      }
      // Low-frequency mottling so the plain isn't a flat sheet of one colour.
      const n = Math.sin(x * 0.031 + z * 0.019) * Math.cos(z * 0.027 - x * 0.013) * 0.035 + Math.sin(x * 0.53) * Math.sin(z * 0.47) * 0.012;
      c.offsetHSL(0, 0, n);
      col[i] = c.r;
      col[i + 1] = c.g;
      col[i + 2] = c.b;
      i += 3;
    }
  }
  const idx: number[] = [];
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const a = iz * (nx + 1) + ix, b = a + 1, d = a + nx + 1, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  geo.setAttribute('color', new BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const ground = new Mesh(geo, new MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  ground.name = 'terrain';
  group.add(ground);

  // Surrounding land beyond the playable map, so the edges don't fall into the void.
  const outer = new Mesh(new PlaneGeometry(6000, 6000), new MeshLambertMaterial({ color: '#76844a' }));
  outer.rotation.x = -Math.PI / 2;
  outer.position.set(terrain.width / 2, -0.15, terrain.depth / 2);
  group.add(outer);

  if (terrain.river) {
    const water = new Mesh(
      new PlaneGeometry(terrain.width, terrain.depth),
      new MeshLambertMaterial({ color: '#3f6f7d', transparent: true, opacity: 0.88 }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.set(terrain.width / 2, WATER_LEVEL, terrain.depth / 2);
    group.add(water);
    // Continue the river channel past the map edges.
    const p = terrain.river.points;
    for (const [a, b] of [[p[0], p[1]], [p[p.length - 1], p[p.length - 2]]]) {
      const ang = Math.atan2(a[1] - b[1], a[0] - b[0]);
      const strip = new Mesh(new PlaneGeometry(1200, terrain.river.width), new MeshLambertMaterial({ color: '#3f6f7d' }));
      strip.rotation.x = -Math.PI / 2;
      strip.rotation.z = -ang;
      strip.position.set(a[0] + Math.cos(ang) * 600, 0.25, a[1] + Math.sin(ang) * 600);
      group.add(strip);
    }
  }

  group.add(buildTrees(terrain));
  return group;
}

function buildTrees(terrain: Terrain): InstancedMesh {
  const rng = new Rng(4242);
  const spots: [number, number, number][] = [];
  const half = (terrain.river?.width ?? 0) / 2;
  for (let tries = 0; tries < 6000 && spots.length < 260; tries++) {
    const x = rng.range(-120, terrain.width + 120);
    const z = rng.range(-120, terrain.depth + 120);
    const rd = terrain.riverDistance(x, z);
    const edge = Math.min(x, z, terrain.width - x, terrain.depth - z);
    // Groves along the river banks and around the map edges; keep the battle plain open.
    const bank = rd > half + 10 && rd < half + 45 && rng.next() < 0.5;
    const rim = edge < 25 && rng.next() < 0.25;
    if (!bank && !rim) continue;
    if (terrain.inside(x, z) && terrain.inWater(x, z)) continue;
    spots.push([x, z, rng.range(0.7, 1.4)]);
  }
  const geo = new ConeGeometry(2.6, 8, 6);
  geo.translate(0, 4, 0);
  const mesh = new InstancedMesh(geo, new MeshLambertMaterial({ color: '#58733a', flatShading: true }), spots.length);
  const m = new Matrix4();
  spots.forEach(([x, z, s], k) => {
    const y = terrain.inside(x, z) ? terrain.height(x, z) : -0.15;
    m.makeScale(s, s * rng.range(0.8, 1.3), s).setPosition(x, y, z);
    mesh.setMatrixAt(k, m);
    mesh.setColorAt(k, new Color('#58733a').offsetHSL(rng.range(-0.02, 0.02), 0, rng.range(-0.06, 0.05)));
  });
  return mesh;
}
