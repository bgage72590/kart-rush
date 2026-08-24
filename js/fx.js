// ---------------------------------------------------------------------------
// Visual effects: particle pools, skid marks, blob shadows.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { makeCanvas, canvasTexture } from './util.js';

// Soft round dot texture shared by the particle pools.
let _dotTex = null;
export function softDotTexture() {
  if (!_dotTex) _dotTex = dotTexture();
  return _dotTex;
}
function dotTexture() {
  const c = makeCanvas(64, 64);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return canvasTexture(c);
}

export class ParticlePool {
  constructor(scene, count, { size = 1.6, additive = false, gravity = -14 } = {}) {
    this.count = count;
    this.gravity = gravity;
    this.pos = new Float32Array(count * 3);
    this.col = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.max = new Float32Array(count);
    this.baseCol = new Float32Array(count * 3);
    this.head = 0;
    for (let i = 0; i < count; i++) this.pos[i * 3 + 1] = -9999;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    const mat = new THREE.PointsMaterial({
      size,
      map: dotTexture(),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      sizeAttenuation: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);
  }

  emit(x, y, z, vx, vy, vz, life, r, g, b) {
    const i = this.head;
    this.head = (this.head + 1) % this.count;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = life; this.max[i] = life;
    this.baseCol[i * 3] = r; this.baseCol[i * 3 + 1] = g; this.baseCol[i * 3 + 2] = b;
  }

  update(dt) {
    const n = this.count;
    let any = false;
    for (let i = 0; i < n; i++) {
      if (this.life[i] <= 0) continue;
      any = true;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.pos[i * 3 + 1] = -9999; continue; }
      const a = this.life[i] / this.max[i];
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.vel[i * 3 + 1] += this.gravity * dt;
      this.col[i * 3] = this.baseCol[i * 3] * a;
      this.col[i * 3 + 1] = this.baseCol[i * 3 + 1] * a;
      this.col[i * 3 + 2] = this.baseCol[i * 3 + 2] * a;
    }
    if (any) {
      this.points.geometry.attributes.position.needsUpdate = true;
      this.points.geometry.attributes.color.needsUpdate = true;
    }
  }

  clear() {
    this.life.fill(0);
    for (let i = 0; i < this.count; i++) this.pos[i * 3 + 1] = -9999;
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}

// Ring buffer of fading quads laid on the road behind drifting rear wheels.
export class SkidMarks {
  constructor(scene, maxQuads = 700) {
    this.max = maxQuads;
    this.head = 0;
    this.pos = new Float32Array(maxQuads * 4 * 3);
    this.col = new Float32Array(maxQuads * 4 * 4);
    this.alpha = new Float32Array(maxQuads);
    const idx = new Uint32Array(maxQuads * 6);
    for (let i = 0; i < maxQuads; i++) {
      const v = i * 4, o = i * 6;
      idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2;
      idx[o + 3] = v; idx[o + 4] = v + 2; idx[o + 5] = v + 3;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
  }

  // Add one quad from the previous wheel position to the current one.
  add(px, py, pz, cx, cy, cz, width) {
    const dx = cx - px, dz = cz - pz;
    const len = Math.hypot(dx, dz);
    if (len < 0.05) return;
    const sx = -dz / len * width / 2, sz = dx / len * width / 2;
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    const p = this.pos, o = i * 12;
    p[o] = px - sx; p[o + 1] = py; p[o + 2] = pz - sz;
    p[o + 3] = px + sx; p[o + 4] = py; p[o + 5] = pz + sz;
    p[o + 6] = cx + sx; p[o + 7] = cy; p[o + 8] = cz + sz;
    p[o + 9] = cx - sx; p[o + 10] = cy; p[o + 11] = cz - sz;
    this.alpha[i] = 0.55;
    const c = this.col, co = i * 16;
    for (let k = 0; k < 4; k++) {
      c[co + k * 4] = 0.05; c[co + k * 4 + 1] = 0.05; c[co + k * 4 + 2] = 0.06;
      c[co + k * 4 + 3] = 0.55;
    }
    this.dirty = true;
  }

  update(dt) {
    let any = false;
    for (let i = 0; i < this.max; i++) {
      if (this.alpha[i] <= 0) continue;
      this.alpha[i] -= dt * 0.09;
      const a = Math.max(0, this.alpha[i]);
      const co = i * 16;
      for (let k = 0; k < 4; k++) this.col[co + k * 4 + 3] = a;
      any = true;
    }
    // positions only change in add(); colors fade every frame while alive
    if (this.dirty) {
      this.mesh.geometry.attributes.position.needsUpdate = true;
      this.dirty = false;
    }
    if (any) this.mesh.geometry.attributes.color.needsUpdate = true;
  }

  clear() {
    this.alpha.fill(0);
    this.col.fill(0);
    this.mesh.geometry.attributes.color.needsUpdate = true;
  }
}

// Shared blob-shadow texture (dark radial gradient).
let _shadowTex = null;
export function shadowTexture() {
  if (_shadowTex) return _shadowTex;
  const c = makeCanvas(128, 128);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 6, 64, 64, 60);
  grad.addColorStop(0, 'rgba(0,0,0,0.55)');
  grad.addColorStop(0.7, 'rgba(0,0,0,0.35)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  _shadowTex = canvasTexture(c);
  return _shadowTex;
}

// Kept alongside real shadow maps as a soft contact-AO patch: it grounds the
// kart on frames where the shadow map's own resolution is too coarse to show
// the tight darkening right under the chassis.
export function makeBlobShadow(size) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size * 0.86),
    new THREE.MeshBasicMaterial({
      map: shadowTexture(),
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
    })
  );
  m.rotation.x = -Math.PI / 2;
  m.renderOrder = 3;
  return m;
}
