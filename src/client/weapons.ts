import * as THREE from 'three';
import type { ProjectileKind } from '../shared/sim';

// Weapon and projectile models, shared by the first-person view, other players and the rockets in
// flight, so everyone's launcher looks the same up close and across the map. All face -Z. Built from
// primitives and lathed profiles; geometry and materials are made once and reused by every copy.

const gunmetal = new THREE.MeshStandardMaterial({ color: 0x6a7482, metalness: 0.3, roughness: 0.4 });
const dark = new THREE.MeshStandardMaterial({ color: 0x3c434e, metalness: 0.2, roughness: 0.6 });
const steel = new THREE.MeshStandardMaterial({ color: 0xa8b2c0, metalness: 0.45, roughness: 0.3 });
const bore = new THREE.MeshBasicMaterial({ color: 0x050505 });
const ropeMat = new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.9 });
export const GLOW = new THREE.MeshStandardMaterial({ color: 0x7cf0a0, emissive: 0x3cbf6a });
export const DEFAULT_ACCENT = new THREE.MeshStandardMaterial({ color: 0xd96c4a, roughness: 0.5 });

/** Launcher landmarks, in the launcher's own space: where hands hold it and where rockets leave. */
export const LAUNCHER = {
  foreGrip: new THREE.Vector3(0, -0.2, -0.36),
  rearGrip: new THREE.Vector3(0, -0.21, 0.1),
  muzzleZ: -0.68,
};

/** Grapple landmarks, in the gauntlet's own space (its back edge sits at the origin). */
export const GAUNTLET = {
  length: 0.36,
  tip: new THREE.Vector3(0, 0.085, -0.44),
};

const lathe = (points: [number, number][], segments = 20) =>
  // Profiles are (radius, distance forward); the lathe spins around +Y, which we turn to face -Z.
  new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), segments).rotateX(-Math.PI / 2);

const part = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) => {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
};

// --- Rocket launcher -------------------------------------------------------------------------

const launcherGeo = {
  tube: lathe([
    [0.07, -0.5],
    [0.125, -0.47],
    [0.13, -0.4],
    [0.112, -0.36],
    [0.112, 0.26],
    [0.1, 0.3],
    [0.094, 0.6],
    [0.112, 0.62],
    [0.116, 0.68],
    [0.082, 0.69],
  ]),
  housing: new THREE.BoxGeometry(0.29, 0.25, 0.52),
  housingTop: new THREE.BoxGeometry(0.22, 0.05, 0.46),
  rib: new THREE.BoxGeometry(0.03, 0.15, 0.035),
  band: new THREE.CylinderGeometry(0.118, 0.118, 0.06, 20).rotateX(Math.PI / 2),
  rail: new THREE.BoxGeometry(0.045, 0.03, 0.46),
  optic: new THREE.CylinderGeometry(0.035, 0.035, 0.16, 12).rotateX(Math.PI / 2),
  opticMount: new THREE.BoxGeometry(0.03, 0.04, 0.05),
  lens: new THREE.CircleGeometry(0.03, 12),
  stripe: new THREE.BoxGeometry(0.005, 0.05, 0.16),
  grip: new THREE.BoxGeometry(0.055, 0.15, 0.065),
  guard: new THREE.BoxGeometry(0.035, 0.012, 0.1),
  bore: new THREE.CircleGeometry(0.083, 16),
  exhaust: new THREE.CircleGeometry(0.07, 16),
  light: new THREE.BoxGeometry(0.008, 0.035, 0.05),
};

export interface LauncherModel {
  root: THREE.Group;
  /** Rockets leave here; a flash can be parented to it. */
  muzzle: THREE.Object3D;
  /** Status light on the housing's inner side: set its color to show whether a shot is ready. */
  light: THREE.MeshStandardMaterial;
  /** A revolving drum, turned around the barrel's axis (Z) as it fires. */
  drum?: THREE.Object3D;
}

/** A shoulder-fired launcher: a ribbed rear housing around a long tube, gripped from below. */
export function buildLauncher(accent: THREE.Material = DEFAULT_ACCENT): LauncherModel {
  const g = launcherGeo;
  const root = new THREE.Group();
  const light = new THREE.MeshStandardMaterial({ color: 0x7cf0a0, emissive: 0x3cbf6a });

  root.add(part(g.tube, gunmetal));
  root.add(part(g.housing, dark, 0, 0, 0.02));
  root.add(part(g.housingTop, gunmetal, 0, 0.14, 0.02));
  for (let i = 0; i < 6; i++) {
    const z = -0.17 + i * 0.07;
    root.add(part(g.rib, gunmetal, 0.15, -0.02, z), part(g.rib, gunmetal, -0.15, -0.02, z));
  }
  root.add(part(g.band, accent, 0, 0, -0.33), part(g.band, accent, 0, 0, -0.56));
  root.add(part(g.rail, dark, 0, 0.18, -0.02));
  // Optic on the outer (right) side, so the inner side stays clear of the first-person view.
  const optic = part(g.optic, dark, 0.085, 0.215, -0.02);
  const lens = part(g.lens, GLOW, 0.085, 0.215, -0.101);
  lens.rotation.y = Math.PI;
  root.add(optic, lens, part(g.opticMount, dark, 0.085, 0.185, -0.02));
  root.add(part(g.stripe, accent, -0.146, 0.09, 0.02), part(g.stripe, accent, 0.146, 0.09, 0.02));
  root.add(part(g.light, light, -0.149, 0.0, 0.235));

  const fore = part(g.grip, dark, LAUNCHER.foreGrip.x, LAUNCHER.foreGrip.y + 0.04, LAUNCHER.foreGrip.z);
  fore.rotation.x = -0.15;
  const rear = part(g.grip, dark, LAUNCHER.rearGrip.x, LAUNCHER.rearGrip.y + 0.04, LAUNCHER.rearGrip.z);
  rear.rotation.x = 0.3;
  root.add(fore, rear, part(g.guard, gunmetal, 0, -0.17, 0.02));

  const muzzleBore = part(g.bore, bore, 0, 0, LAUNCHER.muzzleZ + 0.02);
  muzzleBore.rotation.y = Math.PI;
  const exhaust = part(g.exhaust, bore, 0, 0, 0.495);
  root.add(muzzleBore, exhaust);

  const muzzle = new THREE.Object3D();
  muzzle.name = 'muzzle';
  muzzle.position.z = LAUNCHER.muzzleZ;
  root.add(muzzle);
  return { root, muzzle, light };
}

// --- Grenade launcher ------------------------------------------------------------------------

/** Grenade launcher landmarks. It shares the rocket launcher's grips, so the same hands hold it. */
export const GRENADE_LAUNCHER = {
  muzzleZ: -0.64,
};

const grenadeLauncherGeo = {
  barrel: lathe([
    [0.055, 0.1],
    [0.07, 0.12],
    [0.07, 0.54],
    [0.086, 0.56],
    [0.086, 0.64],
    [0.06, 0.645],
  ]),
  drum: new THREE.CylinderGeometry(0.15, 0.15, 0.24, 24).rotateX(Math.PI / 2),
  drumCap: new THREE.CylinderGeometry(0.11, 0.11, 0.02, 20).rotateX(Math.PI / 2),
  flute: new THREE.BoxGeometry(0.035, 0.02, 0.2),
  chamber: new THREE.CircleGeometry(0.036, 12),
  band: new THREE.CylinderGeometry(0.078, 0.078, 0.05, 20).rotateX(Math.PI / 2),
  strap: new THREE.BoxGeometry(0.05, 0.035, 0.56),
  sight: new THREE.BoxGeometry(0.05, 0.07, 0.03),
  handguard: new THREE.BoxGeometry(0.12, 0.07, 0.28),
  frame: new THREE.BoxGeometry(0.08, 0.06, 0.32),
  stock: new THREE.BoxGeometry(0.1, 0.15, 0.24),
  grip: launcherGeo.grip,
  guard: launcherGeo.guard,
  bore: new THREE.CircleGeometry(0.058, 16),
  light: launcherGeo.light,
};

/**
 * A revolver-style grenade launcher: a fat six-shot drum behind a short, wide barrel, gripped
 * where the rocket launcher is. Same landmarks as `buildLauncher`, so it can stand in for it.
 */
export function buildGrenadeLauncher(accent: THREE.Material = DEFAULT_ACCENT): LauncherModel {
  const g = grenadeLauncherGeo;
  const root = new THREE.Group();
  const light = new THREE.MeshStandardMaterial({ color: 0x7cf0a0, emissive: 0x3cbf6a });

  root.add(part(g.barrel, gunmetal));
  root.add(part(g.band, accent, 0, 0, -0.2), part(g.band, accent, 0, 0, -0.5));
  // The drum turns as a unit around the barrel's axis.
  const drum = new THREE.Group();
  drum.add(part(g.drum, dark, 0, 0, 0.02), part(g.drumCap, gunmetal, 0, 0, -0.1), part(g.drumCap, gunmetal, 0, 0, 0.14));
  root.add(drum);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
    const flute = part(g.flute, gunmetal, Math.cos(a) * 0.145, Math.sin(a) * 0.145, 0.02);
    flute.rotation.z = a + Math.PI / 2;
    // Chamber mouths on the drum's front face, between the flutes.
    const b = a + Math.PI / 6;
    const chamber = part(g.chamber, bore, Math.cos(b) * 0.085, Math.sin(b) * 0.085, -0.101);
    chamber.rotation.y = Math.PI;
    drum.add(flute, chamber);
  }
  root.add(part(g.strap, dark, 0, 0.16, -0.17), part(g.sight, gunmetal, 0, 0.2, -0.02));
  root.add(part(g.handguard, dark, 0, -0.09, LAUNCHER.foreGrip.z));
  root.add(part(g.frame, gunmetal, 0, -0.15, 0.06), part(g.stock, dark, 0, -0.03, 0.26));
  root.add(part(g.light, light, -0.152, 0.03, 0.02));

  const fore = part(g.grip, dark, LAUNCHER.foreGrip.x, LAUNCHER.foreGrip.y + 0.04, LAUNCHER.foreGrip.z);
  fore.rotation.x = -0.15;
  const rear = part(g.grip, dark, LAUNCHER.rearGrip.x, LAUNCHER.rearGrip.y + 0.04, LAUNCHER.rearGrip.z);
  rear.rotation.x = 0.3;
  root.add(fore, rear, part(g.guard, gunmetal, 0, -0.17, 0.02));

  const muzzleBore = part(g.bore, bore, 0, 0, GRENADE_LAUNCHER.muzzleZ + 0.015);
  muzzleBore.rotation.y = Math.PI;
  root.add(muzzleBore);

  const muzzle = new THREE.Object3D();
  muzzle.name = 'muzzle';
  muzzle.position.z = GRENADE_LAUNCHER.muzzleZ;
  root.add(muzzle);
  return { root, muzzle, light, drum };
}

// --- Grapple ---------------------------------------------------------------------------------

const hookGeo = {
  spike: new THREE.ConeGeometry(0.035, 0.13, 8).rotateX(-Math.PI / 2),
  collar: new THREE.CylinderGeometry(0.03, 0.04, 0.04, 10).rotateX(Math.PI / 2),
  claw: new THREE.BoxGeometry(0.018, 0.018, 0.11),
};

/** The hook that flies out on the rope: a glowing spike with three swept-back claws, pointing -Z. */
export function buildHookHead(): THREE.Group {
  const head = new THREE.Group();
  head.add(part(hookGeo.spike, GLOW, 0, 0, -0.05), part(hookGeo.collar, steel, 0, 0, 0.03));
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    const arm = new THREE.Group();
    arm.rotation.z = a;
    const claw = part(hookGeo.claw, steel, 0, 0.045, 0.0);
    claw.rotation.x = -0.55; // tips flare outward and back
    arm.add(claw);
    head.add(arm);
  }
  return head;
}

const gauntletGeo = {
  bracer: new THREE.BoxGeometry(0.15, 0.12, GAUNTLET.length),
  plate: new THREE.BoxGeometry(0.12, 0.03, 0.24),
  cuff: new THREE.CylinderGeometry(0.085, 0.085, 0.05, 14).rotateX(Math.PI / 2),
  barrel: lathe([
    [0.034, 0],
    [0.034, 0.22],
    [0.045, 0.24],
    [0.045, 0.3],
    [0.03, 0.31],
  ], 14),
  spool: new THREE.CylinderGeometry(0.06, 0.06, 0.05, 16).rotateZ(Math.PI / 2),
  coil: new THREE.TorusGeometry(0.05, 0.012, 6, 16).rotateY(Math.PI / 2),
  strip: new THREE.BoxGeometry(0.012, 0.012, 0.22),
};

export interface GauntletModel {
  root: THREE.Group;
  /** The hook sitting in the barrel: hide it while the rope is out. */
  hookHead: THREE.Object3D;
  /** Where the rope leaves the barrel. */
  tip: THREE.Object3D;
  /** The glowing strip along the top: dim it to show the grapple is recharging. */
  strip: THREE.MeshStandardMaterial;
}

/** A forearm bracer with a short launch barrel on top, the hook loaded in it and a rope spool. */
export function buildGauntlet(accent: THREE.Material = DEFAULT_ACCENT, outerSide: 1 | -1 = -1): GauntletModel {
  const g = gauntletGeo;
  const L = GAUNTLET.length;
  const root = new THREE.Group();
  const strip = GLOW.clone();
  root.add(part(g.bracer, gunmetal, 0, 0, -L / 2));
  root.add(part(g.plate, accent, 0, 0.065, -L / 2 + 0.03));
  root.add(part(g.cuff, dark, 0, 0, -L + 0.02), part(g.cuff, dark, 0, 0, -0.02));
  root.add(part(g.barrel, dark, 0, 0.085, -0.1));
  root.add(part(g.spool, steel, outerSide * 0.1, 0, -0.16), part(g.coil, ropeMat, outerSide * 0.1, 0, -0.16));
  root.add(part(g.strip, strip, -outerSide * 0.06, 0.062, -L / 2));

  const hookHead = buildHookHead();
  hookHead.name = 'hookHead';
  hookHead.scale.setScalar(0.85);
  hookHead.position.set(0, 0.085, -0.42);
  root.add(hookHead);

  const tip = new THREE.Object3D();
  tip.name = 'hookTip';
  tip.position.copy(GAUNTLET.tip);
  root.add(tip);
  return { root, hookHead, tip, strip };
}

// --- Grenade ---------------------------------------------------------------------------------

const olive = new THREE.MeshStandardMaterial({ color: 0x5f6e3c, metalness: 0.2, roughness: 0.55 });

/** Name of the grenade's arming light: each copy gets its own material so it can blink on its own. */
export const GRENADE_LIGHT = 'grenadeLight';

/** A stubby 40 mm-style round: olive body, steel cap, a light on the nose that shows when it's armed. */
export function buildGrenade(): THREE.Group {
  const root = new THREE.Group();
  const body = part(
    lathe([
      [0, -0.11],
      [0.055, -0.105],
      [0.08, -0.08],
      [0.09, -0.03],
      [0.09, 0.04],
      [0.075, 0.08],
      [0.045, 0.105],
      [0, 0.115],
    ], 16),
    olive,
  );
  const band = part(new THREE.CylinderGeometry(0.093, 0.093, 0.03, 16).rotateX(Math.PI / 2), steel, 0, 0, 0.0);
  const light = part(new THREE.SphereGeometry(0.03, 10, 8), new THREE.MeshBasicMaterial({ color: 0x7cf0a0 }), 0, 0, -0.11);
  light.name = GRENADE_LIGHT;
  light.castShadow = false;
  root.add(body, band, light);
  return root;
}

// --- Rocket ----------------------------------------------------------------------------------

/** A finned missile with a lit exhaust, pointing -Z. */
export function buildRocket(): THREE.Group {
  const root = new THREE.Group();
  const body = part(
    lathe([
      [0.05, -0.3],
      [0.062, -0.27],
      [0.075, -0.24],
      [0.075, 0.12],
      [0.068, 0.16],
    ], 14),
    steel,
  );
  const nose = part(
    lathe([
      [0.068, 0.16],
      [0.06, 0.24],
      [0.038, 0.32],
      [0.012, 0.37],
      [0, 0.38],
    ], 14),
    DEFAULT_ACCENT,
  );
  const band = part(new THREE.CylinderGeometry(0.078, 0.078, 0.04, 14).rotateX(Math.PI / 2), dark, 0, 0, -0.1);
  root.add(body, nose, band);
  const fin = new THREE.BoxGeometry(0.008, 0.075, 0.13);
  for (let k = 0; k < 4; k++) {
    const arm = new THREE.Group();
    arm.rotation.z = Math.PI / 4 + (k * Math.PI) / 2;
    arm.add(part(fin, dark, 0, 0.095, 0.2));
    root.add(arm);
  }
  // Exhaust: a hot core inside a softer additive plume.
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), new THREE.MeshBasicMaterial({ color: 0xfff0c0 }));
  core.position.z = 0.32;
  core.scale.set(1, 1, 1.6);
  const plume = new THREE.Mesh(
    new THREE.ConeGeometry(0.075, 0.45, 10, 1, true).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xff9a40, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  plume.position.z = 0.5;
  plume.rotation.y = Math.PI; // wide end at the nozzle
  root.add(core, plume);
  return root;
}

// --- Seeker launchers ------------------------------------------------------------------------

const tubeOlive = new THREE.MeshStandardMaterial({ color: 0x55603a, metalness: 0.15, roughness: 0.7 });
const tubeSand = new THREE.MeshStandardMaterial({ color: 0x8b8f6e, metalness: 0.15, roughness: 0.6 });
const lensMat = new THREE.MeshStandardMaterial({ color: 0x10161c, emissive: 0x3a1c10, metalness: 0.8, roughness: 0.1 });

/** Muzzle positions for the seeker launchers. Both share the rocket launcher's grips. */
export const SEEKER_MUZZLE_Z = { javelin: -0.64, stinger: -0.72 };

/** Shared by both seekers: grips, trigger guard, status light, bore and muzzle. */
function finishLauncher(root: THREE.Group, muzzleZ: number, boreRadius: number, lightAt: THREE.Vector3): LauncherModel {
  const light = new THREE.MeshStandardMaterial({ color: 0x7cf0a0, emissive: 0x3cbf6a });
  root.add(part(launcherGeo.light, light, lightAt.x, lightAt.y, lightAt.z));
  const fore = part(launcherGeo.grip, dark, LAUNCHER.foreGrip.x, LAUNCHER.foreGrip.y + 0.04, LAUNCHER.foreGrip.z);
  fore.rotation.x = -0.15;
  const rear = part(launcherGeo.grip, dark, LAUNCHER.rearGrip.x, LAUNCHER.rearGrip.y + 0.04, LAUNCHER.rearGrip.z);
  rear.rotation.x = 0.3;
  root.add(fore, rear, part(launcherGeo.guard, gunmetal, 0, -0.17, 0.02));
  const muzzleBore = part(new THREE.CircleGeometry(boreRadius, 16), bore, 0, 0, muzzleZ + 0.015);
  muzzleBore.rotation.y = Math.PI;
  root.add(muzzleBore);
  const muzzle = new THREE.Object3D();
  muzzle.name = 'muzzle';
  muzzle.position.z = muzzleZ;
  root.add(muzzle);
  return { root, muzzle, light };
}

const javelinGeo = {
  tube: lathe([
    [0.1, -0.5],
    [0.135, -0.48],
    [0.135, -0.4],
    [0.118, -0.38],
    [0.118, 0.5],
    [0.135, 0.52],
    [0.135, 0.63],
    [0.1, 0.64],
  ]),
  clu: new THREE.BoxGeometry(0.2, 0.22, 0.26),
  cluHood: new THREE.BoxGeometry(0.17, 0.05, 0.3),
  eyepiece: new THREE.BoxGeometry(0.11, 0.07, 0.06),
  lens: new THREE.CircleGeometry(0.045, 14),
  battery: new THREE.CylinderGeometry(0.05, 0.05, 0.2, 12).rotateX(Math.PI / 2),
  band: new THREE.CylinderGeometry(0.122, 0.122, 0.05, 20).rotateX(Math.PI / 2),
};

/** Javelin: a fat olive tube with the boxy command launch unit (sight and seeker) clamped to its inner side. */
export function buildJavelin(accent: THREE.Material = DEFAULT_ACCENT): LauncherModel {
  const g = javelinGeo;
  const root = new THREE.Group();
  root.add(part(g.tube, tubeOlive), part(g.band, accent, 0, 0, -0.25), part(g.band, accent, 0, 0, 0.25));
  root.add(part(g.clu, dark, -0.21, 0.02, 0.04), part(g.cluHood, gunmetal, -0.21, 0.15, 0.02), part(g.eyepiece, dark, -0.21, 0.05, 0.2));
  const lensL = part(g.lens, lensMat, -0.25, 0.04, -0.091);
  const lensR = part(g.lens, lensMat, -0.17, 0.04, -0.091);
  lensL.rotation.y = lensR.rotation.y = Math.PI;
  root.add(lensL, lensR, part(g.battery, gunmetal, 0, -0.15, 0.28));
  return finishLauncher(root, SEEKER_MUZZLE_Z.javelin, 0.1, new THREE.Vector3(-0.311, -0.04, 0.04));
}

const stingerGeo = {
  tube: lathe([
    [0.07, -0.55],
    [0.082, -0.53],
    [0.082, -0.46],
    [0.075, -0.44],
    [0.075, 0.6],
    [0.095, 0.62],
    [0.095, 0.72],
    [0.07, 0.725],
  ]),
  gripstock: new THREE.BoxGeometry(0.07, 0.09, 0.42),
  antennaArm: new THREE.BoxGeometry(0.015, 0.14, 0.015),
  antenna: new THREE.BoxGeometry(0.012, 0.13, 0.17),
  sightPost: new THREE.BoxGeometry(0.012, 0.09, 0.012),
  sightBar: new THREE.BoxGeometry(0.1, 0.012, 0.012),
  band: new THREE.CylinderGeometry(0.079, 0.079, 0.04, 18).rotateX(Math.PI / 2),
  seeker: new THREE.CylinderGeometry(0.05, 0.05, 0.08, 12).rotateX(Math.PI / 2),
};

/** Stinger: a long slim tube on a gripstock, with the fold-out IFF antenna and an open frame sight. */
export function buildStinger(accent: THREE.Material = DEFAULT_ACCENT): LauncherModel {
  const g = stingerGeo;
  const root = new THREE.Group();
  root.add(part(g.tube, tubeSand), part(g.band, accent, 0, 0, -0.5), part(g.band, accent, 0, 0, 0.35));
  root.add(part(g.gripstock, dark, 0, -0.11, -0.12), part(g.seeker, gunmetal, 0, -0.11, 0.12));
  // IFF antenna, folded out to the inner side on a short arm.
  const arm = part(g.antennaArm, gunmetal, -0.09, 0.1, -0.3);
  arm.rotation.z = 0.7;
  root.add(arm, part(g.antenna, dark, -0.15, 0.15, -0.3));
  // Open sight frame above the tube.
  root.add(part(g.sightPost, gunmetal, -0.05, 0.12, -0.05), part(g.sightPost, gunmetal, 0.05, 0.12, -0.05), part(g.sightBar, gunmetal, 0, 0.165, -0.05));
  return finishLauncher(root, SEEKER_MUZZLE_Z.stinger, 0.068, new THREE.Vector3(-0.036, -0.1, 0.04));
}

// --- Hypersonic launcher ---------------------------------------------------------------------

const coilGlow = new THREE.MeshStandardMaterial({ color: 0x9ff4ff, emissive: 0x2ad0ff, emissiveIntensity: 1.2 });

const hypersonicGeo = {
  body: new THREE.BoxGeometry(0.13, 0.15, 0.46),
  rail: new THREE.BoxGeometry(0.028, 0.032, 0.86),
  spine: new THREE.BoxGeometry(0.05, 0.03, 0.86),
  coil: new THREE.TorusGeometry(0.072, 0.012, 6, 18),
  stripe: new THREE.BoxGeometry(0.005, 0.04, 0.2),
  vent: new THREE.BoxGeometry(0.14, 0.012, 0.03),
};

/** Hypersonic launcher: a slim twin-rail barrel ringed with glowing coils over a compact receiver. */
export function buildHypersonic(accent: THREE.Material = DEFAULT_ACCENT): LauncherModel {
  const g = hypersonicGeo;
  const root = new THREE.Group();
  root.add(part(g.body, dark, 0, -0.01, 0.05));
  root.add(part(g.rail, gunmetal, 0.045, 0.02, -0.33), part(g.rail, gunmetal, -0.045, 0.02, -0.33), part(g.spine, dark, 0, -0.04, -0.33));
  for (let k = 0; k < 4; k++) root.add(part(g.coil, coilGlow, 0, 0, -0.26 - k * 0.12));
  for (let k = 0; k < 4; k++) root.add(part(g.vent, gunmetal, 0, 0.065, 0.2 - k * 0.04));
  root.add(part(g.stripe, accent, -0.066, 0.02, 0.05), part(g.stripe, accent, 0.066, 0.02, 0.05));
  return finishLauncher(root, -0.76, 0.03, new THREE.Vector3(-0.066, -0.04, 0.22));
}

/** The hypersonic round: a thin steel dart with a glowing tail, pointing -Z. */
export function buildDart(): THREE.Group {
  const root = new THREE.Group();
  root.add(part(new THREE.CylinderGeometry(0.025, 0.025, 0.5, 8).rotateX(Math.PI / 2), steel));
  root.add(part(new THREE.ConeGeometry(0.025, 0.14, 8).rotateX(-Math.PI / 2), DEFAULT_ACCENT, 0, 0, -0.32));
  const tail = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xbff8ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  tail.position.z = 0.32;
  tail.scale.set(1, 1, 4);
  root.add(tail);
  return root;
}

/** Every primary weapon's model, by weapon. */
export const PRIMARY_MODELS: Record<ProjectileKind, (accent?: THREE.Material) => LauncherModel> = {
  rocket: buildLauncher,
  grenade: buildGrenadeLauncher,
  hypersonic: buildHypersonic,
  javelin: buildJavelin,
  stinger: buildStinger,
};

// --- Missiles --------------------------------------------------------------------------------

const missileWhite = new THREE.MeshStandardMaterial({ color: 0xd8dcd4, metalness: 0.2, roughness: 0.45 });

/** Seeker missiles are restyled rockets: a big olive javelin, a slim white stinger. Both point -Z. */
export function buildMissile(kind: 'javelin' | 'stinger'): THREE.Group {
  const root = buildRocket();
  const javelin = kind === 'javelin';
  const body = javelin ? olive : missileWhite;
  const nose = javelin ? dark : DEFAULT_ACCENT;
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    if (o.material === steel) o.material = body;
    else if (o.material === DEFAULT_ACCENT) o.material = nose;
  });
  if (javelin) root.scale.set(1.3, 1.3, 1.25);
  else root.scale.set(0.7, 0.7, 1.1);
  return root;
}
