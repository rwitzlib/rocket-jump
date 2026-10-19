// For laying things out on a map: lists every surface (the top of each solid, highest first) under
// each x,z, with its slope when it isn't flat. Items, flag bases and race rings in the map files
// were placed with it.
//
//   npx tsx scripts/probe.ts <map> x,z [x,z ...]
//   npx tsx scripts/probe.ts temple 15,15 0,52

import RAPIER from '@dimforge/rapier3d-compat';
import { Vector3 } from 'three';
import { MAPS } from '../src/shared/map';
import { GameSim } from '../src/shared/sim';

await RAPIER.init();
const map = MAPS[process.argv[2]];
if (!map) {
  console.log(`Unknown map. One of: ${Object.keys(MAPS).join(', ')}`);
  process.exit(1);
}
const sim = new GameSim(map);
sim.world.step(); // ray casts only see colliders after a step
const normal = new Vector3();
const down = new Vector3(0, -1, 0);
for (const arg of process.argv.slice(3)) {
  const [x, z] = arg.split(',').map(Number);
  const tops: string[] = [];
  let y = 120;
  while (y > map.killY) {
    const d = sim.castLevel(new Vector3(x, y, z), down, y - map.killY, normal);
    if (d === null) break;
    const top = y - d;
    tops.push(`${top.toFixed(2)}${normal.y < 0.9 ? ` (slope ${normal.y.toFixed(2)})` : ''}`);
    // Down through this solid to whatever is under it.
    y = top - 0.02;
    while (y > map.killY && sim.castLevel(new Vector3(x, y, z), down, 0.01, normal) === 0) y -= 0.1;
  }
  console.log(`${x},${z}: ${tops.join('  ') || 'nothing (open air)'}`);
}
