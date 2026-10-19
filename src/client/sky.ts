import * as THREE from 'three';
import type { Theme } from './themes';

// A painted sky: a gradient dome from zenith to horizon, a sun with a soft halo, and flat-bottomed
// cartoon clouds drifting across it. It's a sphere that follows the camera, drawn behind everything,
// and its horizon color is the fog color, so the far end of the map melts into it.

const VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww; // on the far plane
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 top;
  uniform vec3 horizon;
  uniform vec3 bottom;
  uniform vec3 sunColor;
  uniform vec3 sunDir;
  uniform float sunSize;
  uniform vec3 cloudColor;
  uniform vec3 cloudShade;
  uniform float cloudCover;
  uniform float time;
  varying vec3 vDir;

  float hash(vec2 p) {
    return fract(sin(dot(mod(p, 289.0), vec2(127.1, 311.7))) * 43758.5453);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * noise(p);
      p = p * 2.03 + vec2(1.7, 9.2);
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec3 dir = normalize(vDir);
    float h = dir.y;
    vec3 col = h > 0.0 ? mix(horizon, top, pow(smoothstep(0.0, 0.65, h), 0.8)) : mix(horizon, bottom, smoothstep(0.0, 0.25, -h));

    float sun = dot(dir, sunDir);
    col += sunColor * pow(max(sun, 0.0), 12.0) * 0.35; // wide warm glow around it
    col = mix(col, sunColor * 3.0, smoothstep(1.0 - sunSize, 1.0 - sunSize * 0.7, sun)); // the disc, bright enough to bloom

    // Clouds on a flat ceiling: the direction projected up onto a plane, so they shrink toward the horizon.
    if (h > 0.02 && cloudCover > 0.0) {
      vec2 uv = dir.xz / (h + 0.08) * 0.9 + vec2(time * 0.006, time * 0.002);
      float n = fbm(uv);
      float shape = smoothstep(1.0 - cloudCover, 1.0 - cloudCover + 0.12, n);
      // Lit from above: brighter on top of the puff, shaded along the flat bottom.
      float lit = smoothstep(0.0, 0.25, n - (1.0 - cloudCover)) ;
      vec3 cloud = mix(cloudShade, cloudColor, lit);
      cloud += sunColor * pow(max(sun, 0.0), 6.0) * 0.4 * shape;
      col = mix(col, cloud, shape * smoothstep(0.02, 0.2, h));
    }
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class Sky {
  readonly mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;

  constructor(theme: Theme) {
    const s = theme.sky;
    const material = new THREE.ShaderMaterial({
      uniforms: {
        top: { value: new THREE.Color(s.top) },
        horizon: { value: new THREE.Color(s.horizon) },
        bottom: { value: new THREE.Color(s.bottom) },
        sunColor: { value: new THREE.Color(s.sunColor) },
        sunDir: { value: new THREE.Vector3(...theme.sunDir).normalize() },
        sunSize: { value: s.sunSize },
        cloudColor: { value: new THREE.Color(s.cloudColor) },
        cloudShade: { value: new THREE.Color(s.cloudShade) },
        cloudCover: { value: s.clouds },
        time: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.matrixAutoUpdate = false;
    // Always centered on whoever is looking at it.
    this.mesh.onBeforeRender = (_r, _s, camera) => {
      this.mesh.position.setFromMatrixPosition(camera.matrixWorld);
      this.mesh.updateMatrix();
      this.mesh.matrixWorld.copy(this.mesh.matrix);
      this.mesh.modelViewMatrix.multiplyMatrices(camera.matrixWorldInverse, this.mesh.matrixWorld);
    };
  }

  update(dt: number) {
    this.mesh.material.uniforms.time.value += dt;
  }
}
