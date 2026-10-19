import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { CAR, HELI } from '../shared/config';
import type { VehicleSim } from '../shared/vehicle';
import { withRim } from './remoteview';

// Vehicle models, built from primitives like everything else, and synced to the sim each frame.
// Both face -Z with the collider's center at the origin. The buggy is a rounded open tub on four
// fat tires, with a roll cage and a raised platform at the back for a gunner to stand on; the
// helicopter has an egg-shaped cabin with a bubble canopy, a tapered tail, rocket pods on stub
// wings and a step on its right side for its gunner.

const body = withRim(new THREE.MeshStandardMaterial({ color: 0x6b8e3e, roughness: 0.55 }));
const heliBody = withRim(new THREE.MeshStandardMaterial({ color: 0x4f7396, roughness: 0.45, metalness: 0.15 }));
const belly = withRim(new THREE.MeshStandardMaterial({ color: 0xe8e8e2, roughness: 0.5 }));
const frame = withRim(new THREE.MeshStandardMaterial({ color: 0x2c3138, roughness: 0.5, metalness: 0.4 }));
const tire = new THREE.MeshStandardMaterial({ color: 0x1c1c1e, roughness: 0.95 });
const rim = new THREE.MeshStandardMaterial({ color: 0xb8bec8, roughness: 0.35, metalness: 0.6 });
const glass = new THREE.MeshStandardMaterial({ color: 0x9fd0f0, roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.45, depthWrite: false });
const accent = withRim(new THREE.MeshStandardMaterial({ color: 0xe8752e, roughness: 0.5 }));
const blade = new THREE.MeshStandardMaterial({ color: 0x24272c, roughness: 0.6 });
const seat = new THREE.MeshStandardMaterial({ color: 0x3a3028, roughness: 0.9 });
const headlight = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 2.8, 2.2) });
const taillight = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 0.3, 0.2) });
const navGreen = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 2.6, 0.6) });
const yellow = new THREE.MeshStandardMaterial({ color: 0xf2c230, roughness: 0.5 });

const WHEEL_RADIUS = 0.5;
const ROTOR_SPEED = 28; // radians per second at full power

function rounded(w: number, h: number, d: number, r: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2)), mat);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}

function cylinder(r: number, len: number, mat: THREE.Material, axis: 'x' | 'y' | 'z', segments = 16, r2 = r): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(r2, r, len, segments);
  if (axis === 'x') geo.rotateZ(Math.PI / 2);
  if (axis === 'z') geo.rotateX(Math.PI / 2);
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  return m;
}

function at<T extends THREE.Object3D>(o: T, x: number, y: number, z: number): T {
  o.position.set(x, y, z);
  return o;
}

/** A bar from a to b (for roll cages and skids). */
function bar(a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material): THREE.Mesh {
  const m = cylinder(r, a.distanceTo(b), mat, 'y', 8);
  m.position.addVectors(a, b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  return m;
}

interface Model {
  root: THREE.Group;
  /** Front then back, left then right. */
  wheels: THREE.Object3D[];
  steering: THREE.Object3D[]; // the front wheels' steering knuckles
  rotor: THREE.Object3D | null;
  tailRotor: THREE.Object3D | null;
  spin: number; // rotor speed, eased up and down
}

function buildCar(): Model {
  const root = new THREE.Group();
  const [w, h, l] = CAR.size;
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const floor = -h / 2 + 0.35;
  // The tub, a sloped hood and a dark bumper with a bull bar.
  root.add(rounded(w - 0.3, 0.5, l - 0.5, 0.14, body, 0, floor + 0.2, 0));
  const hood = rounded(w - 0.45, 0.32, 1.3, 0.12, body, 0, floor + 0.5, -l / 2 + 0.95);
  hood.rotation.x = 0.12;
  root.add(hood);
  root.add(rounded(w - 0.1, 0.22, 0.28, 0.08, frame, 0, floor + 0.12, -l / 2 + 0.2));
  root.add(rounded(w - 0.1, 0.22, 0.28, 0.08, frame, 0, floor + 0.12, l / 2 - 0.2));
  root.add(bar(v(-0.6, floor + 0.2, -l / 2 + 0.12), v(-0.5, floor + 0.75, -l / 2 + 0.3), 0.05, frame));
  root.add(bar(v(0.6, floor + 0.2, -l / 2 + 0.12), v(0.5, floor + 0.75, -l / 2 + 0.3), 0.05, frame));
  root.add(bar(v(-0.5, floor + 0.75, -l / 2 + 0.3), v(0.5, floor + 0.75, -l / 2 + 0.3), 0.05, frame));
  // Racing stripe and an accent panel down the hood.
  const stripe = rounded(0.32, 0.04, 1.25, 0.02, accent, 0, floor + 0.68, -l / 2 + 0.95);
  stripe.rotation.x = 0.12;
  root.add(stripe);
  // Headlights and taillights.
  for (const x of [-0.7, 0.7]) {
    const lamp = at(cylinder(0.14, 0.14, frame, 'z', 16), x, floor + 0.45, -l / 2 + 0.28);
    root.add(lamp, at(cylinder(0.11, 0.02, headlight, 'z', 16), x, floor + 0.45, -l / 2 + 0.2));
    root.add(rounded(0.22, 0.1, 0.05, 0.02, taillight, x, floor + 0.35, l / 2 - 0.05));
  }
  // Seats with headrests, a steering wheel.
  for (const x of [-0.45, 0.45]) {
    root.add(rounded(0.62, 0.22, 0.6, 0.08, seat, x, floor + 0.5, 0.15));
    root.add(rounded(0.6, 0.62, 0.16, 0.07, seat, x, floor + 0.8, 0.45));
  }
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.03, 6, 16), frame);
  wheel.position.set(-0.45, floor + 0.95, -0.35);
  wheel.rotation.x = -0.9;
  root.add(wheel);
  // Gunner's platform at the back: a raised round deck with a hand rail.
  root.add(at(cylinder(0.62, 0.12, frame, 'y', 20), 0, h / 2 - 0.06, 1.3));
  const railRing = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.035, 6, 20), accent);
  railRing.rotation.x = Math.PI / 2;
  railRing.position.set(0, h / 2 + 0.7, 1.3);
  root.add(railRing);
  for (const a of [0.8, 2.35, 3.9, 5.45]) root.add(bar(v(Math.cos(a) * 0.62, h / 2, 1.3 + Math.sin(a) * 0.62), v(Math.cos(a) * 0.62, h / 2 + 0.7, 1.3 + Math.sin(a) * 0.62), 0.03, frame));
  root.add(bar(v(0, floor + 0.4, 1.3), v(0, h / 2 - 0.06, 1.3), 0.12, frame));
  // Roll cage over the seats, in the accent color.
  const top = h / 2 + 0.35;
  const fx = w / 2 - 0.25;
  const corners = [v(-fx, floor + 0.4, -0.55), v(fx, floor + 0.4, -0.55), v(-fx, floor + 0.4, 0.65), v(fx, floor + 0.4, 0.65)];
  const tops = [v(-fx + 0.18, top, -0.25), v(fx - 0.18, top, -0.25), v(-fx + 0.18, top, 0.6), v(fx - 0.18, top, 0.6)];
  corners.forEach((c, i) => root.add(bar(c, tops[i], 0.06, accent)));
  root.add(bar(tops[0], tops[1], 0.06, accent), bar(tops[2], tops[3], 0.06, accent), bar(tops[0], tops[2], 0.06, accent), bar(tops[1], tops[3], 0.06, accent));
  // Twin exhausts, a spare tire on the back, a whip antenna with a pennant.
  for (const x of [-0.75, 0.75]) root.add(bar(v(x, floor + 0.15, l / 2 - 0.3), v(x * 1.05, floor + 0.85, l / 2 + 0.05), 0.07, rim));
  const spare = at(cylinder(0.38, 0.22, tire, 'z', 18), 0, floor + 0.45, l / 2 + 0.05);
  root.add(spare, at(cylinder(0.18, 0.24, rim, 'z', 10), 0, floor + 0.45, l / 2 + 0.05));
  root.add(bar(v(fx - 0.1, top, 0.6), v(fx - 0.1, top + 1.3, 0.75), 0.015, frame));
  const pennant = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.4, 3).rotateZ(-Math.PI / 2), accent);
  pennant.position.set(fx + 0.08, top + 1.2, 0.74);
  root.add(pennant);

  const wheels: THREE.Object3D[] = [];
  const steering: THREE.Object3D[] = [];
  for (const z of [-l / 2 + 0.75, l / 2 - 0.75]) {
    for (const x of [-w / 2, w / 2]) {
      // Arched fender over each wheel.
      const fender = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.55, 16, 1, true, -Math.PI / 2, Math.PI).rotateZ(Math.PI / 2), frame);
      fender.material = body;
      fender.position.set(x * 0.98, -h / 2 + WHEEL_RADIUS - 0.1, z);
      fender.castShadow = true;
      root.add(fender);
      const knuckle = new THREE.Group();
      knuckle.position.set(x, -h / 2 + WHEEL_RADIUS - 0.15, z);
      const spinner = cylinder(WHEEL_RADIUS, 0.45, tire, 'x', 20);
      // Tread blocks round the tire, a chrome rim and a colored hub cap.
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2;
        const block = new THREE.Mesh(new THREE.BoxGeometry(0.47, 0.08, 0.14), tire);
        block.position.set(0, Math.cos(a) * WHEEL_RADIUS, Math.sin(a) * WHEEL_RADIUS);
        block.rotation.x = a;
        spinner.add(block);
      }
      spinner.add(cylinder(0.3, 0.47, rim, 'x', 14));
      spinner.add(at(cylinder(0.12, 0.5, accent, 'x', 10), 0, 0, 0));
      knuckle.add(spinner);
      root.add(knuckle);
      wheels.push(spinner);
      if (z < 0) steering.push(knuckle);
    }
  }
  return { root, wheels, steering, rotor: null, tailRotor: null, spin: 0 };
}

function buildHeli(): Model {
  const root = new THREE.Group();
  const [w, h, l] = HELI.size;
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  // An egg-shaped cabin with a white belly, and a big bubble canopy over the nose.
  const cabin = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), heliBody);
  cabin.scale.set(w / 2, h * 0.42, l * 0.36);
  cabin.position.set(0, 0.05, 0.2);
  cabin.castShadow = true;
  const underside = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, Math.PI * 0.55, Math.PI * 0.45), belly);
  underside.scale.set(w / 2 + 0.01, h * 0.42 + 0.01, l * 0.36 + 0.01);
  underside.position.copy(cabin.position);
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.6), glass);
  canopy.scale.set(w * 0.42, h * 0.38, 1.25);
  canopy.rotation.x = -Math.PI / 2 + 0.25;
  canopy.position.set(0, 0.1, -l / 2 + 1.45);
  root.add(cabin, underside, canopy);
  // Engine housing and exhaust on top, a stripe down each side.
  root.add(rounded(w * 0.7, 0.45, l * 0.45, 0.18, heliBody, 0, h * 0.42, 0.45));
  root.add(at(cylinder(0.16, 0.5, frame, 'z', 12, 0.2), 0, h * 0.45, 1.6));
  for (const x of [-1, 1]) root.add(rounded(0.04, 0.18, l * 0.5, 0.02, accent, x * (w / 2 - 0.05), 0.15, 0.4));
  // A tapering tail boom, fin, tail plane and tail rotor.
  const boom = cylinder(0.18, 5, heliBody, 'z', 14, 0.36);
  boom.position.set(0, 0.35, l / 2 + 1.9);
  root.add(boom);
  const fin = rounded(0.12, 1.5, 0.9, 0.05, heliBody, 0, 1.0, l / 2 + 4.2);
  fin.rotation.x = -0.3;
  root.add(fin, rounded(1.8, 0.08, 0.5, 0.03, heliBody, 0, 0.45, l / 2 + 3.9));
  root.add(rounded(0.06, 0.5, 0.35, 0.02, accent, 0, 1.5, l / 2 + 4.45));
  const tailRotor = new THREE.Group();
  tailRotor.position.set(0.2, 1.0, l / 2 + 4.3);
  tailRotor.add(rounded(0.05, 1.5, 0.15, 0.02, blade), rounded(0.05, 0.15, 1.5, 0.02, blade), at(cylinder(0.08, 0.12, frame, 'x', 10), 0, 0, 0));
  root.add(tailRotor);
  // Main rotor: mast, hub and four blades with yellow tips.
  const rotor = new THREE.Group();
  rotor.position.set(0, h * 0.42 + 0.55, 0.1);
  rotor.add(at(cylinder(0.12, 0.45, frame, 'y', 10), 0, -0.1, 0), at(cylinder(0.24, 0.12, frame, 'y', 12), 0, 0.12, 0));
  for (let i = 0; i < 4; i++) {
    const arm = new THREE.Group();
    arm.rotation.y = (i * Math.PI) / 2;
    arm.add(rounded(5.2, 0.05, 0.34, 0.02, blade, 2.75, 0.15, 0), rounded(0.5, 0.055, 0.35, 0.02, yellow, 5.15, 0.15, 0));
    rotor.add(arm);
  }
  root.add(rotor);
  // Skids on struts.
  for (const x of [-w / 2 + 0.15, w / 2 - 0.15]) {
    root.add(bar(v(x, -h / 2 + 0.05, -l / 2 + 0.8), v(x, -h / 2 + 0.05, l / 2 - 0.5), 0.07, frame));
    root.add(bar(v(x, -h / 2 + 0.05, -l / 2 + 0.8), v(x, -h / 2 + 0.25, -l / 2 + 0.45), 0.07, frame));
    root.add(bar(v(x, -h / 2 + 0.05, -0.8), v(x * 0.75, -h * 0.25, -0.8), 0.06, frame));
    root.add(bar(v(x, -h / 2 + 0.05, 1.2), v(x * 0.75, -h * 0.25, 1.2), 0.06, frame));
  }
  // The gunner's step on the right side.
  root.add(rounded(0.7, 0.08, 1.2, 0.03, frame, w / 2 + 0.25, -0.95, 0.2));
  // Stub wings with rocket pods, where the sim fires them from.
  root.add(rounded(3.4 + w, 0.12, 0.7, 0.05, frame, 0, -0.55, -1.2));
  for (const side of [-1, 1]) {
    const pod = cylinder(0.28, 1.3, frame, 'z', 14);
    pod.position.set(side * 1.7, -0.7, -1.3);
    root.add(pod);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.35, 14).rotateX(-Math.PI / 2), accent);
    nose.position.set(side * 1.7, -0.7, -2.12);
    root.add(nose);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      const tube = new THREE.Mesh(new THREE.CircleGeometry(0.06, 8), new THREE.MeshBasicMaterial({ color: 0x050505 }));
      tube.position.set(side * 1.7 + Math.cos(a) * 0.15, -0.7 + Math.sin(a) * 0.15, -1.98);
      tube.rotation.y = Math.PI;
      root.add(tube);
    }
  }
  // Navigation lights: red on the left, green on the right, and a landing light under the nose.
  root.add(at(new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), taillight), -(3.4 + w) / 2, -0.55, -1.2));
  root.add(at(new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), navGreen), (3.4 + w) / 2, -0.55, -1.2));
  root.add(at(new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), headlight), 0, -h * 0.4, -l / 2 + 0.9));
  return { root, wheels: [], steering: [], rotor, tailRotor, spin: 0 };
}

const lerpAngle = (a: number, b: number, t: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
const _pos = new THREE.Vector3();

export class VehicleView {
  private readonly models: Model[];

  constructor(scene: THREE.Scene, private readonly vehicles: readonly VehicleSim[]) {
    this.models = vehicles.map((v) => {
      const model = v.kind === 'car' ? buildCar() : buildHeli();
      model.root.rotation.order = 'YXZ';
      scene.add(model.root);
      return model;
    });
  }

  /** Where a vehicle is drawn this frame (between its last two ticks, like the player's camera). */
  position(index: number, alpha: number, out: THREE.Vector3): THREE.Vector3 {
    const v = this.vehicles[index];
    return out.lerpVectors(v.prevPos, v.pos, alpha);
  }

  yaw(index: number, alpha: number): number {
    const v = this.vehicles[index];
    return lerpAngle(v.prevYaw, v.yaw, alpha);
  }

  /** A seat's position as drawn this frame. */
  seatPosition(index: number, seat: number, alpha: number, out: THREE.Vector3): THREE.Vector3 {
    const v = this.vehicles[index];
    const [x, y, z] = v.config.seats[seat].offset;
    const yaw = this.yaw(index, alpha);
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    return this.position(index, alpha, out).add(_pos.set(x * c + z * s, y, -x * s + z * c));
  }

  update(alpha: number, dt: number) {
    this.vehicles.forEach((v, i) => {
      const m = this.models[i];
      m.root.visible = v.alive;
      if (!v.alive) {
        m.spin = 0;
        return;
      }
      this.position(i, alpha, m.root.position);
      m.root.rotation.set(v.pitch, this.yaw(i, alpha), v.roll);

      // Wheels roll with the speed along the heading; the front ones turn with the steering.
      const speed = v.vel.x * -Math.sin(v.yaw) + v.vel.z * -Math.cos(v.yaw);
      for (const wheel of m.wheels) wheel.rotation.x -= (speed / WHEEL_RADIUS) * dt;
      for (const knuckle of m.steering) knuckle.rotation.y += (-v.steer * 0.45 - knuckle.rotation.y) * Math.min(1, dt * 10);

      // Rotors spin up while someone's flying it and wind down after.
      if (m.rotor) {
        const target = v.driver ? ROTOR_SPEED : 0;
        m.spin += (target - m.spin) * Math.min(1, dt * (v.driver ? 1.5 : 0.5));
        m.rotor.rotation.y += m.spin * dt;
        m.tailRotor!.rotation.x += m.spin * 1.6 * dt;
      }
    });
  }
}
