// ---------------------------------------------------------------------------
// Math helpers, deterministic RNG, canvas/texture helpers, geometry merging.
// ---------------------------------------------------------------------------
import * as THREE from 'three';

export const TAU = Math.PI * 2;

export function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
export function lerp(a, b, t) { return a + (b - a) * t; }

export function angNorm(a) {
  a = a % TAU;
  if (a > Math.PI) a -= TAU;
  if (a < -Math.PI) a += TAU;
  return a;
}

// Deterministic RNG so tracks always generate identically.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function fmtTime(sec) {
  if (sec == null || !isFinite(sec)) return "--'--\"---";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec * 1000) % 1000);
  return m + "'" + String(s).padStart(2, '0') + '"' + String(ms).padStart(3, '0');
}

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function suffix(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

// --- splines ---------------------------------------------------------------

// Catmull-Rom through 3D control points [x, y, z].
function catmull3(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  const f = (a, b, c, d) =>
    0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1]), f(p0[2], p1[2], p2[2], p3[2])];
}

export function sampleClosedSpline3(cps, perSegment) {
  const n = cps.length, out = [];
  for (let i = 0; i < n; i++) {
    const p0 = cps[(i - 1 + n) % n], p1 = cps[i], p2 = cps[(i + 1) % n], p3 = cps[(i + 2) % n];
    for (let s = 0; s < perSegment; s++) out.push(catmull3(p0, p1, p2, p3, s / perSegment));
  }
  return out;
}

// --- canvas / textures -----------------------------------------------------

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export function canvasTexture(canvas, { repeat = false, srgb = true, aniso = 0 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  if (repeat) { t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.RepeatWrapping; }
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (aniso) t.anisotropy = aniso;
  return t;
}

// --- geometry merging ------------------------------------------------------

// Merge a list of {geometry, matrix, color} into a single vertex-colored
// BufferGeometry so a whole forest is one draw call.
//
// An optional `ao: {base, height, dark}` bakes occlusion into those vertex
// colors, darkening toward the object's base. It costs nothing at runtime and
// is the difference between scenery that sits on the ground and scenery that
// hovers a few centimetres above it.
export function mergeParts(parts) {
  const pos = [], nor = [], col = [], idx = [];
  let off = 0;
  const c = new THREE.Color();
  for (const p of parts) {
    const g = p.geometry.clone().applyMatrix4(p.matrix);
    const gp = g.attributes.position, gn = g.attributes.normal;
    c.set(p.color);
    const ao = p.ao;
    const aoDark = ao ? (ao.dark == null ? 0.55 : ao.dark) : 1;
    const aoH = ao ? Math.max(0.001, ao.height) : 1;
    for (let i = 0; i < gp.count; i++) {
      const y = gp.getY(i);
      pos.push(gp.getX(i), y, gp.getZ(i));
      nor.push(gn.getX(i), gn.getY(i), gn.getZ(i));
      if (ao) {
        const k = aoDark + (1 - aoDark) * clamp((y - ao.base) / aoH, 0, 1);
        col.push(c.r * k, c.g * k, c.b * k);
      } else {
        col.push(c.r, c.g, c.b);
      }
    }
    const gi = g.index;
    if (gi) for (let i = 0; i < gi.count; i++) idx.push(gi.getX(i) + off);
    else for (let i = 0; i < gp.count; i++) idx.push(i + off);
    off += gp.count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}

// Compose a Matrix4 from position / euler-y / scale in one call.
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
export function mat4(x, y, z, ry = 0, s = 1, rz = 0, rx = 0) {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z), _q.clone(), new THREE.Vector3(s, s, s));
}
