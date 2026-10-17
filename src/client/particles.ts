import * as THREE from 'three';

// CPU-simulated particles drawn as a single THREE.Points per blend mode. Cheap enough for
// thousands of particles; sizes are in world units and shrink with distance like real objects.

export interface ParticleSpec {
  pos: THREE.Vector3;
  vel?: THREE.Vector3;
  life: number;
  size: [number, number]; // start, end
  color: [number, number]; // start, end (hex)
  alpha?: number; // peak opacity
  gravity?: number; // m/s² downward (negative = rises)
  drag?: number; // fraction of velocity lost per second (exponential)
}

const VERT = /* glsl */ `
  attribute float size;
  attribute vec4 color;
  uniform float scale;
  varying vec4 vColor;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * scale / -mv.z;
    gl_Position = projectionMatrix * mv;
    vColor = color;
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D map;
  varying vec4 vColor;
  void main() {
    float a = texture2D(map, gl_PointCoord).a * vColor.a;
    if (a < 0.003) discard;
    gl_FragColor = vec4(vColor.rgb, a);
    // Same output transform as built-in materials, so particle colors match the rest of the scene.
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function softDot(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.6)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

const sharedTexture = { tex: null as THREE.Texture | null };
const _a = new THREE.Color();
const _b = new THREE.Color();

export class ParticleSystem {
  readonly points: THREE.Points;
  private readonly material: THREE.ShaderMaterial;
  private count = 0;

  // Structure-of-arrays storage, compacted in place as particles die.
  private readonly position: Float32Array;
  private readonly velocity: Float32Array;
  private readonly sizes: Float32Array;
  private readonly colors: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly size0: Float32Array;
  private readonly size1: Float32Array;
  private readonly color0: Float32Array;
  private readonly color1: Float32Array;
  private readonly alpha: Float32Array;
  private readonly gravity: Float32Array;
  private readonly drag: Float32Array;

  constructor(
    private readonly max: number,
    blending: THREE.Blending,
  ) {
    this.position = new Float32Array(max * 3);
    this.velocity = new Float32Array(max * 3);
    this.sizes = new Float32Array(max);
    this.colors = new Float32Array(max * 4);
    this.age = new Float32Array(max);
    this.life = new Float32Array(max);
    this.size0 = new Float32Array(max);
    this.size1 = new Float32Array(max);
    this.color0 = new Float32Array(max * 3);
    this.color1 = new Float32Array(max * 3);
    this.alpha = new Float32Array(max);
    this.gravity = new Float32Array(max);
    this.drag = new Float32Array(max);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.position, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage));

    sharedTexture.tex ??= softDot();
    this.material = new THREE.ShaderMaterial({
      uniforms: { map: { value: sharedTexture.tex }, scale: { value: 500 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      blending,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
  }

  /** Call on resize: converts world-unit sizes into pixels for the current viewport. */
  setViewport(heightPx: number, fovDeg: number) {
    this.material.uniforms.scale.value = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
  }

  emit(s: ParticleSpec) {
    if (this.count >= this.max) return;
    const i = this.count++;
    const p = i * 3;
    this.position[p] = s.pos.x;
    this.position[p + 1] = s.pos.y;
    this.position[p + 2] = s.pos.z;
    this.velocity[p] = s.vel?.x ?? 0;
    this.velocity[p + 1] = s.vel?.y ?? 0;
    this.velocity[p + 2] = s.vel?.z ?? 0;
    this.age[i] = 0;
    this.life[i] = s.life;
    this.size0[i] = s.size[0];
    this.size1[i] = s.size[1];
    _a.setHex(s.color[0]);
    _b.setHex(s.color[1]);
    this.color0[p] = _a.r;
    this.color0[p + 1] = _a.g;
    this.color0[p + 2] = _a.b;
    this.color1[p] = _b.r;
    this.color1[p + 1] = _b.g;
    this.color1[p + 2] = _b.b;
    this.alpha[i] = s.alpha ?? 1;
    this.gravity[i] = s.gravity ?? 0;
    this.drag[i] = s.drag ?? 0;
  }

  update(dt: number) {
    let i = 0;
    while (i < this.count) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this.moveParticle(--this.count, i);
        continue;
      }
      const t = this.age[i] / this.life[i];
      const p = i * 3;
      const damp = Math.exp(-this.drag[i] * dt);
      this.velocity[p] *= damp;
      this.velocity[p + 1] = this.velocity[p + 1] * damp - this.gravity[i] * dt;
      this.velocity[p + 2] *= damp;
      this.position[p] += this.velocity[p] * dt;
      this.position[p + 1] += this.velocity[p + 1] * dt;
      this.position[p + 2] += this.velocity[p + 2] * dt;

      this.sizes[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * Math.sqrt(t);
      const c = i * 4;
      for (let k = 0; k < 3; k++) {
        this.colors[c + k] = this.color0[p + k] + (this.color1[p + k] - this.color0[p + k]) * t;
      }
      // Quick fade-in, long fade-out.
      this.colors[c + 3] = this.alpha[i] * Math.min(1, t * 12) * (1 - t) * (1 - t);
      i++;
    }

    const geo = this.points.geometry;
    geo.setDrawRange(0, this.count);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.size.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  }

  private moveParticle(from: number, to: number) {
    if (from === to) return;
    this.position.copyWithin(to * 3, from * 3, from * 3 + 3);
    this.velocity.copyWithin(to * 3, from * 3, from * 3 + 3);
    this.color0.copyWithin(to * 3, from * 3, from * 3 + 3);
    this.color1.copyWithin(to * 3, from * 3, from * 3 + 3);
    this.colors.copyWithin(to * 4, from * 4, from * 4 + 4);
    this.sizes[to] = this.sizes[from];
    this.age[to] = this.age[from];
    this.life[to] = this.life[from];
    this.size0[to] = this.size0[from];
    this.size1[to] = this.size1[from];
    this.alpha[to] = this.alpha[from];
    this.gravity[to] = this.gravity[from];
    this.drag[to] = this.drag[from];
  }
}
