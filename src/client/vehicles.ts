import * as THREE from 'three';
import { CAR, HELI } from '../shared/config';
import type { VehicleSim } from '../shared/vehicle';

// Vehicle models, built from primitives like everything else, and synced to the sim each frame.
// Both face -Z with the collider's center at the origin. The buggy is an open frame on four wheels
// with a deck at the back for a gunner to stand on; the helicopter has a cabin, a tail boom, rocket
// pods on stub wings and an open side door for its gunner.

const body = new THREE.MeshStandardMaterial({ color: 0x4c6a3e, roughness: 0.7 });
const heliBody = new THREE.MeshStandardMaterial({ color: 0x46566b, roughness: 0.6, metalness: 0.2 });
const frame = new THREE.MeshStandardMaterial({ color: 0x2c3138, roughness: 0.5, metalness: 0.4 });
const tire = new THREE.MeshStandardMaterial({ color: 0x1c1c1e, roughness: 0.95 });
const glass = new THREE.MeshStandardMaterial({ color: 0x223040, roughness: 0.1, metalness: 0.6, transparent: true, opacity: 0.7 });
const accent = new THREE.MeshStandardMaterial({ color: 0xd96c4a, roughness: 0.5 });
const blade = new THREE.MeshStandardMaterial({ color: 0x24272c, roughness: 0.6 });

const WHEEL_RADIUS = 0.5;
const ROTOR_SPEED = 28; // radians per second at full power

function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}

function cylinder(r: number, len: number, mat: THREE.Material, axis: 'x' | 'y' | 'z', segments = 16): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(r, r, len, segments);
  if (axis === 'x') geo.rotateZ(Math.PI / 2);
  if (axis === 'z') geo.rotateX(Math.PI / 2);
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  return m;
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
  const floor = -h / 2 + 0.35;
  root.add(box(w - 0.2, 0.35, l - 0.4, body, 0, floor + 0.175, 0)); // tub
  root.add(box(w - 0.4, 0.4, 1.2, body, 0, floor + 0.55, -l / 2 + 0.8)); // hood
  root.add(box(w - 0.3, 0.12, 1.5, frame, 0, floor + 0.42, l / 2 - 0.85)); // gunner's deck
  root.add(box(0.5, 0.1, 0.4, accent, -w / 2 + 0.5, floor + 0.65, -l / 2 + 0.5)); // headlight bar
  root.add(box(0.5, 0.1, 0.4, accent, w / 2 - 0.5, floor + 0.65, -l / 2 + 0.5));
  // Seats
  root.add(box(0.7, 0.5, 0.6, frame, -0.45, floor + 0.55, 0.3));
  root.add(box(0.7, 0.5, 0.6, frame, 0.45, floor + 0.55, 0.3));
  // Roll cage, with a hoop the gunner leans on
  const top = h / 2 + 0.25;
  const fx = w / 2 - 0.25;
  const corners = [new THREE.Vector3(-fx, floor + 0.35, -0.6), new THREE.Vector3(fx, floor + 0.35, -0.6), new THREE.Vector3(-fx, floor + 0.35, 0.8), new THREE.Vector3(fx, floor + 0.35, 0.8)];
  const tops = [new THREE.Vector3(-fx + 0.15, top, -0.3), new THREE.Vector3(fx - 0.15, top, -0.3), new THREE.Vector3(-fx + 0.15, top, 0.75), new THREE.Vector3(fx - 0.15, top, 0.75)];
  corners.forEach((c, i) => root.add(bar(c, tops[i], 0.06, frame)));
  root.add(bar(tops[0], tops[1], 0.06, frame), bar(tops[2], tops[3], 0.06, frame), bar(tops[0], tops[2], 0.06, frame), bar(tops[1], tops[3], 0.06, frame));

  const wheels: THREE.Object3D[] = [];
  const steering: THREE.Object3D[] = [];
  for (const z of [-l / 2 + 0.75, l / 2 - 0.75]) {
    for (const x of [-w / 2, w / 2]) {
      const knuckle = new THREE.Group();
      knuckle.position.set(x, -h / 2 + WHEEL_RADIUS - 0.15, z);
      const wheel = cylinder(WHEEL_RADIUS, 0.45, tire, 'x', 18);
      wheel.add(cylinder(0.22, 0.47, frame, 'x', 10)); // hub
      knuckle.add(wheel);
      root.add(knuckle);
      wheels.push(wheel);
      if (z < 0) steering.push(knuckle);
    }
  }
  return { root, wheels, steering, rotor: null, tailRotor: null, spin: 0 };
}

function buildHeli(): Model {
  const root = new THREE.Group();
  const [w, h, l] = HELI.size;
  root.add(box(w, h * 0.75, l * 0.62, heliBody, 0, 0, 0.1)); // cabin
  root.add(box(w * 0.8, h * 0.55, 1.2, glass, 0, 0.05, -l / 2 + 0.55)); // windscreen nose
  root.add(box(w * 0.75, 0.35, l * 0.5, heliBody, 0, h * 0.45, 0.2)); // engine housing
  // Tail boom, fin and tail rotor
  root.add(box(0.45, 0.45, 5, heliBody, 0, 0.35, l / 2 + 2.2));
  root.add(box(0.12, 1.4, 0.9, heliBody, 0, 0.95, l / 2 + 4.4));
  const tailRotor = new THREE.Group();
  tailRotor.position.set(0.2, 0.95, l / 2 + 4.4);
  tailRotor.add(box(0.05, 1.5, 0.15, blade), box(0.05, 0.15, 1.5, blade));
  root.add(tailRotor);
  // Main rotor
  const rotor = new THREE.Group();
  rotor.position.set(0, h * 0.45 + 0.45, 0.1);
  rotor.add(cylinder(0.18, 0.4, frame, 'y', 10));
  for (let i = 0; i < 4; i++) {
    const b = box(5.2, 0.05, 0.32, blade, 2.7, 0.15, 0);
    const arm = new THREE.Group();
    arm.rotation.y = (i * Math.PI) / 2;
    arm.add(b);
    rotor.add(arm);
  }
  root.add(rotor);
  // Skids
  for (const x of [-w / 2 + 0.2, w / 2 - 0.2]) {
    root.add(bar(new THREE.Vector3(x, -h / 2 + 0.05, -l / 2 + 0.6), new THREE.Vector3(x, -h / 2 + 0.05, l / 2 - 0.6), 0.07, frame));
    root.add(bar(new THREE.Vector3(x, -h / 2 + 0.05, -0.8), new THREE.Vector3(x * 0.8, -h * 0.3, -0.8), 0.06, frame));
    root.add(bar(new THREE.Vector3(x, -h / 2 + 0.05, 1.2), new THREE.Vector3(x * 0.8, -h * 0.3, 1.2), 0.06, frame));
  }
  // Stub wings with rocket pods, where the sim fires them from
  root.add(box(3.4 + w, 0.1, 0.7, frame, 0, -0.55, -1.2));
  for (const side of [-1, 1]) {
    const pod = cylinder(0.28, 1.4, frame, 'z', 12);
    pod.position.set(side * 1.7, -0.7, -1.3);
    root.add(pod);
    const tip = cylinder(0.2, 0.05, accent, 'z', 12);
    tip.position.set(side * 1.7, -0.7, -2.02);
    root.add(tip);
  }
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
