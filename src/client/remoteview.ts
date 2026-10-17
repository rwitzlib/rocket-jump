import * as THREE from 'three';
import { PLAYER } from '../shared/config';
import type { RemotePlayer } from './net/netclient';

// Stand-in models for other players: a capsule with a visor showing where they look,
// a straight rope line while they're grappling, and a glowing shell during spawn protection.

const COLORS = [0x4fa3e0, 0xe0b04f, 0xb86fe0, 0x5fd08a, 0xe06f8a, 0x6fd6d6];

interface Entry {
  root: THREE.Group;
  head: THREE.Object3D;
  rope: THREE.Line;
  shell: THREE.Mesh;
}

export class RemotePlayersView {
  private readonly entries = new Map<string, Entry>();
  private readonly bodyGeo = new THREE.CapsuleGeometry(PLAYER.radius, PLAYER.halfHeight * 2, 4, 12);
  private readonly visorGeo = new THREE.BoxGeometry(0.5, 0.14, 0.12);
  private readonly visorMat = new THREE.MeshStandardMaterial({ color: 0x1a1d24, roughness: 0.2, metalness: 0.6 });
  private readonly ropeMat = new THREE.LineBasicMaterial({ color: 0x2a2a2a });
  private readonly shellGeo = new THREE.CapsuleGeometry(PLAYER.radius + 0.15, PLAYER.halfHeight * 2, 4, 16);
  private readonly shellMat = new THREE.MeshBasicMaterial({
    color: 0x7ce0ff,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  private readonly bodyMats = COLORS.map((color) => new THREE.MeshStandardMaterial({ color, roughness: 0.6 }));

  constructor(private readonly scene: THREE.Scene) {}

  /** Shows one dummy player so its shaders compile behind the start menu (see Effects.setWarmup). */
  setWarmup(on: boolean) {
    if (on) {
      const e = this.entryFor('__warmup');
      e.rope.visible = e.shell.visible = true;
    }
    else this.remove('__warmup');
  }

  sync(remotes: ReadonlyMap<string, RemotePlayer>) {
    for (const r of remotes.values()) {
      const e = this.entryFor(r.id);
      e.root.position.copy(r.pos);
      e.root.rotation.y = r.yaw;
      e.head.rotation.x = r.pitch;
      e.root.visible = r.alive;
      e.shell.visible = r.protected;
      e.rope.visible = r.alive && !!r.anchor;
      if (e.rope.visible && r.anchor) {
        const pos = e.rope.geometry.attributes.position as THREE.BufferAttribute;
        pos.setXYZ(0, r.pos.x, r.pos.y + PLAYER.eyeOffset - 0.3, r.pos.z);
        pos.setXYZ(1, r.anchor.x, r.anchor.y, r.anchor.z);
        pos.needsUpdate = true;
        e.rope.geometry.computeBoundingSphere();
      }
    }
    for (const id of this.entries.keys()) {
      if (!remotes.has(id) && id !== '__warmup') this.remove(id);
    }
  }

  private entryFor(id: string): Entry {
    let e = this.entries.get(id);
    if (e) return e;
    let hash = 0;
    for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
    const body = new THREE.Mesh(this.bodyGeo, this.bodyMats[Math.abs(hash) % COLORS.length]);
    body.castShadow = true;
    const head = new THREE.Group();
    head.position.y = PLAYER.eyeOffset;
    const visor = new THREE.Mesh(this.visorGeo, this.visorMat);
    visor.position.z = -PLAYER.radius + 0.02;
    head.add(visor);
    const shell = new THREE.Mesh(this.shellGeo, this.shellMat);
    shell.visible = false;
    const root = new THREE.Group().add(body, head, shell);
    const rope = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3)), this.ropeMat);
    rope.frustumCulled = false;
    rope.visible = false;
    this.scene.add(root, rope);
    e = { root, head, rope, shell };
    this.entries.set(id, e);
    return e;
  }

  private remove(id: string) {
    const e = this.entries.get(id);
    if (!e) return;
    this.scene.remove(e.root, e.rope);
    e.rope.geometry.dispose();
    this.entries.delete(id);
  }
}
