import * as THREE from 'three';
import type { InstancedInterleavedBuffer } from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

// Grapple rope visuals. The simulation attaches instantly; this fakes a short "shoot out" so the
// hook visibly travels, adds a wobble when it bites, and retracts the rope when released.

const SEGMENTS = 24;
const SHOOT_TIME = 0.09;
const RETRACT_TIME = 0.12;
const WOBBLE_TIME = 0.5;

const _dir = new THREE.Vector3();
const _side = new THREE.Vector3();
const _up = new THREE.Vector3();
const _tip = new THREE.Vector3();
const _p = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);

type State =
  | { kind: 'idle' }
  | { kind: 'attached'; anchor: THREE.Vector3; normal: THREE.Vector3; age: number }
  | { kind: 'retracting'; from: THREE.Vector3; age: number };

export class Rope {
  private readonly line: Line2;
  private readonly geometry = new LineGeometry();
  private readonly material: LineMaterial;
  private readonly hook = new THREE.Group();
  // Segment buffer (start xyz, end xyz per segment) that we rewrite in place each frame.
  // Calling setPositions() per frame would allocate a new GPU buffer every time and leak the old one.
  private readonly segments: InstancedInterleavedBuffer;
  private state: State = { kind: 'idle' };

  constructor(scene: THREE.Scene) {
    this.geometry.setPositions(new Float32Array((SEGMENTS + 1) * 3));
    this.segments = (this.geometry.attributes.instanceStart as THREE.InterleavedBufferAttribute)
      .data as InstancedInterleavedBuffer;
    this.material = new LineMaterial({ color: 0x1f2328, linewidth: 0.045, worldUnits: true });
    this.line = new Line2(this.geometry, this.material);
    this.line.frustumCulled = false;

    // Hook: a glowing spike with three claws, modeled pointing down +Y into the surface.
    const metal = new THREE.MeshStandardMaterial({ color: 0x9aa4b2, metalness: 0.7, roughness: 0.3 });
    const glow = new THREE.MeshStandardMaterial({ color: 0x7cf0a0, emissive: 0x3cbf6a });
    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.3, 8), glow);
    spike.rotation.x = Math.PI; // tip points -Y
    for (let k = 0; k < 3; k++) {
      const claw = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.22, 0.03), metal);
      const a = (k / 3) * Math.PI * 2;
      claw.position.set(Math.cos(a) * 0.09, 0.02, Math.sin(a) * 0.09);
      claw.rotation.set(Math.sin(a) * 0.6, 0, -Math.cos(a) * 0.6);
      this.hook.add(claw);
    }
    this.hook.add(spike);

    this.line.visible = this.hook.visible = false;
    scene.add(this.line, this.hook);
  }

  /** See Effects.setWarmup: shows the rope and hook so their shaders compile at startup. */
  setWarmup(on: boolean) {
    this.line.visible = this.hook.visible = on;
    this.hook.traverse((o) => (o.frustumCulled = !on));
  }

  setResolution(width: number, height: number) {
    this.material.resolution.set(width, height);
  }

  attach(anchor: THREE.Vector3, normal: THREE.Vector3) {
    this.state = { kind: 'attached', anchor: anchor.clone(), normal: normal.clone(), age: 0 };
  }

  release() {
    if (this.state.kind !== 'attached') return;
    _tip.copy(this.state.anchor);
    this.state = { kind: 'retracting', from: _tip.clone(), age: 0 };
  }

  /** `hand` is where the rope leaves the gauntlet, in world space. */
  update(dt: number, hand: THREE.Vector3, camera: THREE.Camera) {
    const s = this.state;
    if (s.kind === 'idle') {
      this.line.visible = this.hook.visible = false;
      return;
    }
    s.age += dt;

    let wobble = 0;
    if (s.kind === 'attached') {
      const shoot = Math.min(s.age / SHOOT_TIME, 1);
      _tip.lerpVectors(hand, s.anchor, shoot);
      if (shoot >= 1) wobble = Math.max(0, 1 - (s.age - SHOOT_TIME) / WOBBLE_TIME);
      // Point the hook along its flight, then into the surface once it lands.
      _dir.subVectors(s.anchor, hand).normalize();
      this.hook.quaternion.setFromUnitVectors(Y, shoot < 1 ? _dir.negate() : s.normal);
    } else {
      const t = s.age / RETRACT_TIME;
      if (t >= 1) {
        this.state = { kind: 'idle' };
        this.line.visible = this.hook.visible = false;
        return;
      }
      _tip.lerpVectors(s.from, hand, t * t);
      _dir.subVectors(s.from, hand).normalize();
      this.hook.quaternion.setFromUnitVectors(Y, _dir.negate());
    }

    // Wobble sideways relative to the view so it always reads on screen.
    _dir.subVectors(_tip, hand);
    const length = _dir.length();
    _dir.divideScalar(length || 1);
    _up.setFromMatrixColumn(camera.matrixWorld, 1);
    _side.crossVectors(_dir, _up).normalize();
    const amp = wobble * wobble * Math.min(length * 0.04, 0.6);
    const phase = s.age * 40;

    const arr = this.segments.array as Float32Array;
    for (let i = 0; i <= SEGMENTS; i++) {
      const u = i / SEGMENTS;
      _p.lerpVectors(hand, _tip, u);
      const offset = amp * Math.sin(Math.PI * u) * Math.sin(u * Math.PI * 5 - phase);
      _p.addScaledVector(_side, offset).addScaledVector(_up, offset * 0.5);
      // Point i ends segment i-1 and starts segment i.
      if (i > 0) {
        arr[(i - 1) * 6 + 3] = _p.x;
        arr[(i - 1) * 6 + 4] = _p.y;
        arr[(i - 1) * 6 + 5] = _p.z;
      }
      if (i < SEGMENTS) {
        arr[i * 6] = _p.x;
        arr[i * 6 + 1] = _p.y;
        arr[i * 6 + 2] = _p.z;
      }
    }
    this.segments.needsUpdate = true;

    this.hook.position.copy(_tip);
    this.line.visible = this.hook.visible = true;
  }
}
