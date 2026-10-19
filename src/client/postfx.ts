import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

// The frame after the scene is drawn: soft ink outlines where the depth breaks or creases (the
// cartoon look, faded out with distance so far geometry doesn't turn to noise), then the
// first-person weapons on top, then bloom on anything brighter than a lit surface (fire, glow
// strips, the sun), then tone mapping to the screen. "Low" graphics skips all of it and draws
// straight to the screen like before.

const OUTLINE_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const OUTLINE_FRAG = /* glsl */ `
  #include <packing>
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform vec2 texel;
  uniform float near;
  uniform float far;
  uniform float fadeStart;
  uniform float fadeEnd;
  uniform vec3 ink;
  varying vec2 vUv;

  // 1 / view distance: linear in screen space across any flat surface, so its Laplacian is zero on
  // planes and spikes at creases and silhouettes.
  float invDepth(vec2 uv) {
    float z = texture2D(tDepth, uv).x;
    return 1.0 / max(-perspectiveDepthToViewZ(z, near, far), near);
  }

  void main() {
    vec4 color = texture2D(tColor, vUv);
    // One NaN or infinite pixel (a shader slip somewhere) would be smeared over the whole screen
    // by the bloom: drop it here.
    if (any(isnan(color.rgb)) || any(isinf(color.rgb))) color.rgb = vec3(0.0);
    color.rgb = min(color.rgb, vec3(64.0));
    float c = invDepth(vUv);
    float l = invDepth(vUv - vec2(texel.x, 0.0));
    float r = invDepth(vUv + vec2(texel.x, 0.0));
    float d = invDepth(vUv - vec2(0.0, texel.y));
    float u = invDepth(vUv + vec2(0.0, texel.y));
    // The nearer side of an edge draws it, so lines stay one pixel wide and hug the object in front.
    float nearest = max(max(l, r), max(d, u));
    float crease = abs(l + r + d + u - 4.0 * c) / c;
    float silhouette = (nearest - c) / nearest;
    float edge = max(smoothstep(0.06, 0.18, crease), smoothstep(0.08, 0.3, silhouette));
    float dist = 1.0 / max(nearest, c);
    edge *= 1.0 - smoothstep(fadeStart, fadeEnd, dist);
    gl_FragColor = vec4(mix(color.rgb, color.rgb * ink, edge * 0.85), color.a);
  }
`;

export type Quality = 'high' | 'low';

export class PostFX {
  quality: Quality = 'high';
  /** Outlines thin out to nothing between these distances (meters); set per map. */
  outlineFade: [number, number] = [40, 110];

  private readonly sceneTarget: THREE.WebGLRenderTarget;
  private readonly finalTarget: THREE.WebGLRenderTarget;
  private readonly outline: FullScreenQuad;
  private readonly outlineMat: THREE.ShaderMaterial;
  private readonly bloom: UnrealBloomPass;
  private readonly output = new OutputPass();
  private readonly size = new THREE.Vector2();

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    const options = { type: THREE.HalfFloatType, samples: 4 };
    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, { ...options, depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType) });
    this.finalTarget = new THREE.WebGLRenderTarget(1, 1, options);
    this.outlineMat = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: this.sceneTarget.texture },
        tDepth: { value: this.sceneTarget.depthTexture },
        texel: { value: new THREE.Vector2() },
        near: { value: 0.05 },
        far: { value: 500 },
        fadeStart: { value: 40 },
        fadeEnd: { value: 110 },
        ink: { value: new THREE.Color(0x1a1420) },
      },
      vertexShader: OUTLINE_VERT,
      fragmentShader: OUTLINE_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.outline = new FullScreenQuad(this.outlineMat);
    // Strength, radius, threshold: only things brighter than a sunlit wall glow.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.35, 0.3, 1.6);
    this.setSize(window.innerWidth, window.innerHeight);
  }

  setSize(w: number, h: number) {
    const ratio = this.renderer.getPixelRatio();
    const pw = Math.max(1, Math.floor(w * ratio));
    const ph = Math.max(1, Math.floor(h * ratio));
    if (this.size.x === pw && this.size.y === ph) return;
    this.size.set(pw, ph);
    this.sceneTarget.setSize(pw, ph);
    this.finalTarget.setSize(pw, ph);
    this.bloom.setSize(pw, ph);
    // Outlines a constant width in CSS pixels, so a high-DPI screen doesn't make them hairlines.
    const px = Math.max(1, Math.round(ratio * 0.9));
    this.outlineMat.uniforms.texel.value.set(px / pw, px / ph);
  }

  /** Draws the world, then (if given) an overlay scene such as the first-person weapons on top of it. */
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, overlay?: { scene: THREE.Scene; camera: THREE.Camera } | null) {
    const r = this.renderer;
    if (this.quality === 'low') {
      r.setRenderTarget(null);
      r.clear();
      r.render(scene, camera);
      if (overlay) {
        r.clearDepth();
        r.render(overlay.scene, overlay.camera);
      }
      return;
    }
    r.getDrawingBufferSize(_size);
    this.setSize(_size.x / r.getPixelRatio(), _size.y / r.getPixelRatio());

    r.setRenderTarget(this.sceneTarget);
    r.clear();
    r.render(scene, camera);

    const u = this.outlineMat.uniforms;
    u.near.value = camera.near;
    u.far.value = camera.far;
    u.fadeStart.value = this.outlineFade[0];
    u.fadeEnd.value = this.outlineFade[1];
    r.setRenderTarget(this.finalTarget);
    this.outline.render(r);

    if (overlay) {
      r.clearDepth();
      r.render(overlay.scene, overlay.camera);
    }

    this.bloom.render(r, null!, this.finalTarget, 0, false);
    this.output.renderToScreen = true;
    this.output.render(r, null!, this.finalTarget, 0, false);
  }

  dispose() {
    this.sceneTarget.depthTexture?.dispose();
    this.sceneTarget.dispose();
    this.finalTarget.dispose();
    this.outlineMat.dispose();
    this.outline.dispose();
    this.bloom.dispose();
    this.output.dispose();
  }
}

const _size = new THREE.Vector2();
