import * as THREE from 'three';

// First-person weapons, rendered in their own scene after the world so they never clip into walls.

const LEFT_HAND = new THREE.Vector3(-0.42, -0.34, -0.95);
const GRAPPLE_TIP_Z = -0.22;
const RIGHT_HAND = new THREE.Vector3(0.4, -0.36, -0.9);

export class ViewModel {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private launcher = new THREE.Group();
  private grappler = new THREE.Group();
  private flash: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private recoil = 0;
  private grappleKick = 0;
  private bob = 0;

  constructor(fov: number) {
    this.camera = new THREE.PerspectiveCamera(fov, 1, 0.01, 10);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 2));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(1, 2, 1);
    this.scene.add(key);

    const metal = new THREE.MeshStandardMaterial({ color: 0x6a7484, metalness: 0.4, roughness: 0.4 });
    const accent = new THREE.MeshStandardMaterial({ color: 0xd96c4a, roughness: 0.5 });
    const green = new THREE.MeshStandardMaterial({ color: 0x7cf0a0, emissive: 0x1e6a3a });

    // Rocket launcher: a fat tube with a grip.
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.1, 0.7, 16).rotateX(Math.PI / 2), metal);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.105, 0.08, 16).rotateX(Math.PI / 2), accent);
    band.position.z = -0.25;
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.08), metal);
    grip.position.set(0, -0.12, 0.1);
    this.flash = new THREE.Mesh(
      new THREE.SphereGeometry(0.14, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xffc070, transparent: true, opacity: 0 }),
    );
    this.flash.position.z = -0.42;
    this.launcher.add(tube, band, grip, this.flash);
    this.launcher.position.copy(RIGHT_HAND);

    // Grapple gauntlet: a box with a glowing hook tip.
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.35), metal);
    const tip = new THREE.Mesh(new THREE.OctahedronGeometry(0.06), green);
    tip.position.z = GRAPPLE_TIP_Z;
    this.grappler.add(body, tip);
    this.grappler.position.copy(LEFT_HAND);

    this.camera.add(this.launcher, this.grappler);
    this.scene.add(this.camera);
  }

  fire() {
    this.recoil = 1;
  }

  fireGrapple() {
    this.grappleKick = 1;
  }

  update(dt: number, speed: number, grounded: boolean, grappling: boolean) {
    this.recoil = Math.max(0, this.recoil - dt * 5);
    this.grappleKick = Math.max(0, this.grappleKick - dt * 7);
    this.bob += dt * (grounded ? Math.min(speed, 10) : 0);
    const bobX = Math.sin(this.bob) * 0.012;
    const bobY = Math.abs(Math.cos(this.bob)) * 0.012;

    this.launcher.position.set(RIGHT_HAND.x + bobX, RIGHT_HAND.y + bobY, RIGHT_HAND.z + this.recoil * 0.12);
    this.launcher.rotation.x = this.recoil * 0.25;
    this.flash.material.opacity = this.recoil > 0.7 ? (this.recoil - 0.7) / 0.3 : 0;

    const reach = grappling ? -0.08 : 0;
    this.grappler.position.set(LEFT_HAND.x - bobX, LEFT_HAND.y + bobY, LEFT_HAND.z + reach + this.grappleKick * 0.07);
    this.grappler.rotation.x = this.grappleKick * 0.2;
  }

  /**
   * Where the grapple tip appears on screen, expressed in the *world* camera's local space
   * (the two cameras have different FOVs, so the same screen point maps to different coordinates).
   */
  ropeOrigin(worldFov: number, out: THREE.Vector3): THREE.Vector3 {
    const scale = Math.tan((worldFov * Math.PI) / 360) / Math.tan((this.camera.fov * Math.PI) / 360);
    const p = this.grappler.position;
    const z = p.z + GRAPPLE_TIP_Z;
    return out.set(p.x * scale, p.y * scale, z);
  }

  resize(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
