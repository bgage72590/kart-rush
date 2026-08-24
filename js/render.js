// ---------------------------------------------------------------------------
// Render pipeline: filmic tone mapping, IBL environment, soft shadow maps,
// MSAA render target and a selective bloom pass.
//
// The look we're chasing is console-kart: crisp edges, saturated but not
// blown-out colour, glossy toy-plastic paint, soft contact shadows, and a
// gentle glow on the things that are actually emissive.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { EffectComposer } from './vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from './vendor/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from './vendor/jsm/postprocessing/ShaderPass.js';
import { RoomEnvironment } from './vendor/jsm/environments/RoomEnvironment.js';

// Final grade: saturation, contrast and a vignette — plus the game's screen
// effects, which live here rather than in passes of their own. This pass
// already runs on every pixel, so folding boost, impact, final-lap and heat
// haze into it costs a handful of ALU ops instead of another full-screen pass.
//
// The extra texture taps sit behind `if (uniform > 0.0)`. A branch on a uniform
// is coherent across the whole draw — every fragment takes the same side — so
// the cost is only paid while the effect is actually on screen.
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    saturation: { value: 1.14 },
    contrast: { value: 1.06 },
    vignette: { value: 0.28 },
    boost: { value: 0 },        // 0..1, speed smear + tunnel vignette
    punch: { value: 0 },        // 0..1, impact flash
    rush: { value: 0 },         // 0..1, final-lap colour push
    shimmer: { value: 0 },      // 0..1, heat haze (lava tracks)
    time: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float saturation;
    uniform float contrast;
    uniform float vignette;
    uniform float boost;
    uniform float punch;
    uniform float rush;
    uniform float shimmer;
    uniform float time;
    varying vec2 vUv;

    void main() {
      vec2 uv = vUv;
      vec2 d = uv - 0.5;

      // heat rising off the ground: strongest along the bottom of the frame
      if (shimmer > 0.0) {
        float band = smoothstep(0.5, 0.0, uv.y);
        uv.x += sin(uv.y * 64.0 + time * 4.5) * 0.0022 * shimmer * band;
        uv.y += cos(uv.x * 48.0 + time * 3.1) * 0.0011 * shimmer * band;
      }

      vec4 c;
      if (boost > 0.0) {
        // pull the channels apart along the radius: reads as speed without
        // the cost of a real radial blur
        float amt = boost * 0.007;
        c.r = texture2D(tDiffuse, uv - d * amt).r;
        c.g = texture2D(tDiffuse, uv).g;
        c.b = texture2D(tDiffuse, uv + d * amt).b;
        c.a = 1.0;
      } else {
        c = texture2D(tDiffuse, uv);
      }

      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      float sat = saturation + rush * 0.18 - punch * 0.55;
      c.rgb = mix(vec3(l), c.rgb, max(sat, 0.0));
      c.rgb = (c.rgb - 0.5) * (contrast + rush * 0.06) + 0.5;
      c.rgb += punch * 0.30;

      // the vignette closes in while boosting, so speed feels like a tunnel
      float vig = vignette + boost * 0.55;
      c.rgb *= 1.0 - vig * dot(d, d) * 1.6;

      gl_FragColor = vec4(clamp(c.rgb, 0.0, 1.0), c.a);
    }`,
};

export class Renderer {
  constructor(canvas) {
    const gl = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    // Phones lose more to fill rate than to anything else here: a 3x device
    // pixel ratio means rendering nine times the pixels through MSAA and bloom.
    // Start conservatively on touch hardware; the adaptive scaler earns it back.
    this.maxRatio = Math.min(devicePixelRatio, 2);
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    this.ratio = coarse ? Math.min(devicePixelRatio, 1.25) : this.maxRatio;
    gl.setPixelRatio(this.ratio);
    gl.outputColorSpace = THREE.SRGBColorSpace;
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.15;
    gl.shadowMap.enabled = true;
    gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.gl = gl;

    // image-based lighting: soft studio bounce so metals/clearcoat have
    // something to reflect instead of reading flat
    const pmrem = new THREE.PMREMGenerator(gl);
    pmrem.compileEquirectangularShader();
    this.envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    this.composer = null;
    this.bloom = null;
    this.grade = null;
    this.enabled = true;
  }

  // Build the composer once we know the scene/camera.
  attach(scene, camera) {
    const size = new THREE.Vector2();
    this.gl.getSize(size);
    const target = new THREE.WebGLRenderTarget(
      size.x * this.gl.getPixelRatio(), size.y * this.gl.getPixelRatio(), {
        type: THREE.HalfFloatType,
        samples: 4,                 // hardware MSAA — the crisp-edge workhorse
        colorSpace: THREE.LinearSRGBColorSpace,
      });
    const composer = new EffectComposer(this.gl, target);
    composer.setPixelRatio(this.gl.getPixelRatio());
    composer.setSize(size.x, size.y);
    composer.addPass(new RenderPass(scene, camera));

    // low strength + high threshold: only genuinely bright things glow, so the
    // scene stays crisp instead of turning into a haze
    const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.3, 0.5, 0.92);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());          // tone map + colour space
    const grade = new ShaderPass(GradeShader);
    composer.addPass(grade);

    this.composer = composer;
    this.bloom = bloom;
    this.grade = grade;
    this.fx = grade.uniforms;
    this.scene = scene;
    this.camera = camera;
  }

  setSize(w, h) {
    this.w = w; this.h = h;
    this.gl.setSize(w, h, false);
    if (this.composer) {
      this.composer.setSize(w, h);
      this.bloom.setSize(w, h);
    }
  }

  // Re-render at a different device-pixel ratio. Everything downstream of the
  // renderer keeps its CSS size; only the buffers change.
  setRatio(r) {
    r = Math.max(1, Math.min(this.maxRatio, r));
    if (Math.abs(r - this.ratio) < 0.01) return false;
    this.ratio = r;
    this.gl.setPixelRatio(r);
    if (this.composer) this.composer.setPixelRatio(r);
    if (this.w) this.setSize(this.w, this.h);
    return true;
  }

  render() {
    if (this.enabled && this.composer) this.composer.render();
    else this.gl.render(this.scene, this.camera);
  }

  get info() { return this.gl.info; }
}

// A sun that follows the player so the shadow map stays tight and sharp.
export class SunShadow {
  constructor(scene, dirVec) {
    const light = new THREE.DirectionalLight(0xffffff, 0);   // colour set per track
    light.castShadow = true;
    light.shadow.mapSize.set(2048, 2048);
    const S = 46;                       // half-extent of the shadow box
    const c = light.shadow.camera;
    c.left = -S; c.right = S; c.top = S; c.bottom = -S;
    c.near = 1; c.far = 320;
    c.updateProjectionMatrix();         // without this the frustum stays 10x10
    light.shadow.bias = -0.0004;
    light.shadow.normalBias = 0.6;
    scene.add(light);
    scene.add(light.target);
    this.light = light;
    this.dir = dirVec.clone().normalize();
    this.offset = this.dir.clone().multiplyScalar(120);
  }

  // The themes' sun directions are chosen for where the sun *sprite* sits on
  // the horizon, which is far too low to cast a usable shadow — a grazing sun
  // smears self-shadowing acne across the whole ground plane. Keep the light's
  // compass bearing but lift it to a steep angle for the shadow pass.
  setTheme(color, intensity, dirArr) {
    this.light.color.set(color);
    this.light.intensity = intensity;
    const v = this.dir.set(dirArr[0], dirArr[1], dirArr[2]).normalize();
    const horiz = Math.hypot(v.x, v.z);
    const minY = horiz * 1.4;                       // ≈54° elevation
    if (v.y < minY) { v.y = minY; v.normalize(); }
    this.offset.copy(v).multiplyScalar(110);
  }

  follow(x, y, z) {
    this.light.target.position.set(x, y, z);
    this.light.position.set(x + this.offset.x, y + this.offset.y, z + this.offset.z);
    this.light.target.updateMatrixWorld();
  }
}
