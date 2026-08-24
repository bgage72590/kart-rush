// ---------------------------------------------------------------------------
// Procedural track builder.
//
// A track is a closed Catmull-Rom spline with elevation. From it we bake:
//   - a terrain heightfield (gaussian splat of road heights + rolling noise)
//   - ground, road, kerb, boost-pad and start-line meshes
//   - merged low-poly scenery (one draw call per deco type)
//   - sky dome, sun, lights, mountains — everything themed per track
//   - waypoints, item boxes and a minimap for the game layer
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CFG, TRACK_DEFS } from './config.js';
import {
  TAU, clamp, lerp, angNorm, mulberry32, sampleClosedSpline3,
  makeCanvas, canvasTexture, mergeParts, mat4,
} from './util.js';

const cache = {};

export function buildTrack(index) {
  return buildTrackFromDef(TRACK_DEFS[index], 'std:' + index);
}

// Drop a cached track and free its GPU resources (used by the editor).
export function invalidateTrack(key) {
  const t = cache[key];
  if (!t) return;
  t.group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m.map) m.map.dispose();
        m.dispose();
      }
    }
  });
  delete cache[key];
}

// Evict every stale revision of the player's custom track.
export function invalidateCustomExcept(keepKey) {
  for (const k of Object.keys(cache)) {
    if (k.startsWith('custom:') && k !== keepKey) invalidateTrack(k);
  }
}

export function buildTrackFromDef(def, key) {
  if (cache[key]) return cache[key];

  const T = def.theme;
  const rng = mulberry32(def.seed);
  const S = CFG.worldScale;
  const halfW = CFG.roadWidth / 2;
  const kerbW = CFG.kerbWidth;
  const LIFT = CFG.roadLift;
  const E = CFG.gridE, GN = CFG.gridN;

  const group = new THREE.Group();

  // --- centreline ------------------------------------------------------------

  const elev = def.points.map(() => (rng() * 2 - 1) * def.elevAmp);
  elev[0] = 0;
  elev[1] *= 0.4;
  elev[elev.length - 1] *= 0.4;
  const cps = def.points.map((p, i) => [(p[0] - 0.5) * S, elev[i], (p[1] - 0.5) * S]);
  const raw = sampleClosedSpline3(cps, CFG.samplesPerSeg);

  const N = raw.length;
  const samples = new Array(N);
  let cum = 0;
  for (let i = 0; i < N; i++) {
    const p = raw[i], q = raw[(i + 1) % N], b = raw[(i - 1 + N) % N];
    let tx = q[0] - b[0], tz = q[2] - b[2];
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    if (i > 0) cum += Math.hypot(p[0] - raw[i - 1][0], p[2] - raw[i - 1][2]);
    samples[i] = { x: p[0], y: p[1], z: p[2], tx, tz, cum, curve: 0 };
  }
  const length = cum + Math.hypot(raw[0][0] - raw[N - 1][0], raw[0][2] - raw[N - 1][2]);
  for (let i = 0; i < N; i++) {
    const a = samples[(i - 2 + N) % N], b = samples[(i + 2) % N];
    samples[i].curve = Math.abs(angNorm(Math.atan2(b.tz, b.tx) - Math.atan2(a.tz, a.tx)));
  }

  // --- heightfield -------------------------------------------------------------

  const num = new Float32Array(GN * GN);
  const den = new Float32Array(GN * GN);
  const cell = (2 * E) / (GN - 1);
  const SIG = 26, R = SIG * 3;
  for (const s of samples) {
    const gx0 = Math.max(0, Math.floor((s.x - R + E) / cell));
    const gx1 = Math.min(GN - 1, Math.ceil((s.x + R + E) / cell));
    const gz0 = Math.max(0, Math.floor((s.z - R + E) / cell));
    const gz1 = Math.min(GN - 1, Math.ceil((s.z + R + E) / cell));
    for (let gz = gz0; gz <= gz1; gz++) {
      const wz = -E + gz * cell - s.z;
      for (let gx = gx0; gx <= gx1; gx++) {
        const wx = -E + gx * cell - s.x;
        const d2 = wx * wx + wz * wz;
        if (d2 > R * R) continue;
        const w = Math.exp(-d2 / (2 * SIG * SIG));
        const gi = gz * GN + gx;
        num[gi] += w * s.y;
        den[gi] += w;
      }
    }
  }

  const ph = [rng() * TAU, rng() * TAU, rng() * TAU, rng() * TAU];
  const noiseAt = (x, z) =>
    -7 +
    5.5 * Math.sin(x * 0.008 + ph[0]) * Math.cos(z * 0.0095 + ph[1]) +
    4.0 * Math.sin((x + z) * 0.005 + ph[2]) +
    3.0 * Math.cos(x * 0.013 + z * 0.007 + ph[3]);

  const H = new Float32Array(GN * GN);
  for (let gz = 0; gz < GN; gz++) {
    for (let gx = 0; gx < GN; gx++) {
      const gi = gz * GN + gx;
      const w = den[gi] / (den[gi] + 0.06);
      const splat = den[gi] > 0 ? num[gi] / den[gi] : 0;
      H[gi] = splat * w + noiseAt(-E + gx * cell, -E + gz * cell) * (1 - w);
    }
  }

  // How close a world point is to the road, 0..1 — read straight off the
  // gaussian splat weights the heightfield already built, so it costs one
  // bilinear sample rather than a search through the centreline.
  function nearRoad(x, z) {
    if (x < -E || x > E || z < -E || z > E) return 0;
    const fx = (x + E) / cell, fz = (z + E) / cell;
    const ix = clamp(Math.floor(fx), 0, GN - 2);
    const iz = clamp(Math.floor(fz), 0, GN - 2);
    const ax = fx - ix, az = fz - iz;
    const d = lerp(
      lerp(den[iz * GN + ix], den[iz * GN + ix + 1], ax),
      lerp(den[(iz + 1) * GN + ix], den[(iz + 1) * GN + ix + 1], ax), az);
    return d / (d + 0.06);
  }

  function heightAt(x, z) {
    if (x < -E || x > E || z < -E || z > E) return noiseAt(x, z);
    const fx = (x + E) / cell, fz = (z + E) / cell;
    const ix = clamp(Math.floor(fx), 0, GN - 2);
    const iz = clamp(Math.floor(fz), 0, GN - 2);
    const ax = fx - ix, az = fz - iz;
    const h00 = H[iz * GN + ix], h10 = H[iz * GN + ix + 1];
    const h01 = H[(iz + 1) * GN + ix], h11 = H[(iz + 1) * GN + ix + 1];
    return lerp(lerp(h00, h10, ax), lerp(h01, h11, ax), az);
  }

  // The gaussian splat smooths the raw spline elevation, so re-base every
  // centreline sample on the baked field — road, karts and terrain then all
  // share one height source and grass can never rise through the asphalt.
  for (const s of samples) s.y = heightAt(s.x, s.z);

  // --- ground ------------------------------------------------------------------

  {
    const seg = 190;
    const geo = new THREE.PlaneGeometry(2600, 2600, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const col = new Float32Array(pos.count * 3);
    const cA = new THREE.Color(T.grassA), cB = new THREE.Color(T.grassB);
    // scuffed dirt right at the roadside, fading out to clean ground
    const dust = new THREE.Color(T.grassB).lerp(new THREE.Color(T.road), 0.45);
    const cc = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      pos.setY(i, heightAt(x, z) - 0.05);
      const n = (Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1;
      const t = Math.abs(n);
      cc.copy(cA).lerp(cB, t);
      const w = nearRoad(x, z);
      if (w > 0.1) cc.lerp(dust, clamp((w - 0.1) / 0.55, 0, 1) * 0.6);
      col[i * 3] = cc.r; col[i * 3 + 1] = cc.g; col[i * 3 + 2] = cc.b;
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();
    const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.96, metalness: 0,
    }));
    ground.receiveShadow = true;
    group.add(ground);
  }

  // --- ribbons (road, kerbs, pads, start line) ----------------------------------

  // Build a ribbon along [i0..i1] (inclusive, wrapping) between lateral offsets
  // offA→offB. yA/yB are added to the terrain centreline height.
  function buildRibbon(i0, i1, offA, offB, yA, yB, vScale, colorFn) {
    const pos = [], uv = [], idx = [], col = colorFn ? [] : null;
    const count = ((i1 - i0 + N) % N) + 1;
    // full loops: quantise the repeat so the texture phase matches at the seam
    if (count === N) vScale = length / Math.max(1, Math.round(length / vScale));
    for (let k = 0; k <= count; k++) {
      const i = (i0 + k) % N;
      const s = samples[i];
      const sx = -s.tz, sz = s.tx;
      pos.push(
        s.x + sx * offA, s.y + yA, s.z + sz * offA,
        s.x + sx * offB, s.y + yB, s.z + sz * offB,
      );
      const v = (k === count && i === i0 ? length : s.cum - samples[i0].cum + (k > 0 && s.cum < samples[i0].cum ? length : 0)) / vScale;
      uv.push(0, v, 1, v);
      if (col) {
        const c = colorFn(s);
        col.push(c[0], c[1], c[2], c[0], c[1], c[2]);
      }
    }
    for (let k = 0; k < count; k++) {
      const a = k * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    if (col) geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  const maxAniso = 8;

  // road
  {
    const c = makeCanvas(128, 128);
    const g = c.getContext('2d');
    g.fillStyle = T.road;
    g.fillRect(0, 0, 128, 128);
    const rr = mulberry32(def.seed ^ 99);
    for (let i = 0; i < 900; i++) {
      g.fillStyle = rr() < 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.09)';
      g.fillRect(rr() * 128, rr() * 128, 1 + rr() * 2, 1 + rr() * 2);
    }

    // Wear, under the markings so those stay crisp. U runs across the road, so
    // this is a polished band where karts actually drive, grit at the edges,
    // and a few patch repairs.
    const lane = g.createLinearGradient(0, 0, 128, 0);
    lane.addColorStop(0.00, 'rgba(0,0,0,0)');
    lane.addColorStop(0.22, 'rgba(0,0,0,0.10)');
    lane.addColorStop(0.50, 'rgba(0,0,0,0.13)');
    lane.addColorStop(0.78, 'rgba(0,0,0,0.10)');
    lane.addColorStop(1.00, 'rgba(0,0,0,0)');
    g.fillStyle = lane;
    g.fillRect(0, 0, 128, 128);
    const grit = g.createLinearGradient(0, 0, 128, 0);
    grit.addColorStop(0.00, 'rgba(200,190,170,0.16)');
    grit.addColorStop(0.14, 'rgba(200,190,170,0)');
    grit.addColorStop(0.86, 'rgba(200,190,170,0)');
    grit.addColorStop(1.00, 'rgba(200,190,170,0.16)');
    g.fillStyle = grit;
    g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 5; i++) {
      g.fillStyle = rr() < 0.5 ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.07)';
      g.fillRect(rr() * 100, rr() * 100, 14 + rr() * 26, 10 + rr() * 22);
    }

    g.fillStyle = 'rgba(245,245,250,0.85)';
    g.fillRect(2, 0, 5, 128);
    g.fillRect(121, 0, 5, 128);
    g.fillStyle = 'rgba(255,215,80,0.8)';
    g.fillRect(61, 0, 6, 54);
    const tex = canvasTexture(c, { repeat: true, aniso: maxAniso });
    tex.repeat.set(1, 1);
    const geo = buildRibbon(0, N - 1, -halfW, halfW, LIFT, LIFT, 12);
    const road = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      map: tex, roughness: 0.62, metalness: 0.05,
    }));
    road.receiveShadow = true;
    group.add(road);
  }

  // kerbs
  {
    const c = makeCanvas(16, 64);
    const g = c.getContext('2d');
    g.fillStyle = '#e23c34'; g.fillRect(0, 0, 16, 32);
    g.fillStyle = '#f2f2f4'; g.fillRect(0, 32, 16, 32);
    const tex = canvasTexture(c, { repeat: true });
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, vertexColors: true });
    // tight corners get hotter, more worn kerbs — the places karts actually clip
    const kerbTint = (sm) => {
      const k = clamp(sm.curve * 6, 0, 1);
      return [1, 1 - k * 0.22, 1 - k * 0.38];
    };
    for (const g2 of [
      buildRibbon(0, N - 1, halfW, halfW + kerbW, LIFT, 0.04, 5.6, kerbTint),
      buildRibbon(0, N - 1, -halfW - kerbW, -halfW, 0.04, LIFT, 5.6, kerbTint),
    ]) {
      const m = new THREE.Mesh(g2, mat);
      m.receiveShadow = true;
      group.add(m);
    }
  }

  // glowing edge strips (neon / lava themes)
  if (T.glowEdges) {
    const gc = T.glowColors || [0x18e0ff, 0xff4fd8];
    const matC = new THREE.MeshBasicMaterial({ color: gc[0], toneMapped: false });
    const matM = new THREE.MeshBasicMaterial({ color: gc[1], toneMapped: false });
    group.add(new THREE.Mesh(buildRibbon(0, N - 1, halfW - 0.9, halfW - 0.15, LIFT + 0.02, LIFT + 0.02, 10), matC));
    group.add(new THREE.Mesh(buildRibbon(0, N - 1, -halfW + 0.15, -halfW + 0.9, LIFT + 0.02, LIFT + 0.02, 10), matM));
  }

  // start line + gate
  {
    const c = makeCanvas(64, 64);
    const g = c.getContext('2d');
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) {
        g.fillStyle = (x + y) % 2 ? '#15151c' : '#f4f4f6';
        g.fillRect(x * 16, y * 16, 16, 16);
      }
    const tex = canvasTexture(c, { repeat: true });
    tex.repeat.set(3.5, 1);
    const geo = buildRibbon(1, 3, -halfW, halfW, LIFT + 0.03, LIFT + 0.03, 8);
    group.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex })));

    const s2 = samples[2];
    const gate = new THREE.Group();
    gate.position.set(s2.x, s2.y, s2.z);
    gate.rotation.y = -Math.atan2(s2.tz, s2.tx);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x8b93a4, roughness: 0.5, metalness: 0.4 });
    for (const zz of [halfW + 2.4, -halfW - 2.4]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.62, 15, 10), postMat);
      post.position.set(0, 7.5, zz);
      gate.add(post);
    }
    const bc = makeCanvas(1024, 96);
    const bg = bc.getContext('2d');
    const grad = bg.createLinearGradient(0, 0, 0, 96);
    grad.addColorStop(0, '#20263c'); grad.addColorStop(1, '#101322');
    bg.fillStyle = grad;
    bg.fillRect(0, 0, 1024, 96);
    bg.fillStyle = '#ffd94d';
    bg.font = 'italic 900 62px "Avenir Next", Helvetica, sans-serif';
    bg.textAlign = 'center';
    bg.textBaseline = 'middle';
    bg.fillText('K A R T   R U S H', 512, 52);
    const btex = canvasTexture(bc);
    const bmat = new THREE.MeshBasicMaterial({ map: btex });
    const bside = new THREE.MeshStandardMaterial({ color: 0x141826 });
    const banner = new THREE.Mesh(
      new THREE.BoxGeometry(1.1, 3.4, (halfW + 2.4) * 2 + 1),
      [bmat, bmat, bside, bside, bside, bside]
    );
    // box depth spans the road, so its ±X faces already look up/down the track
    banner.position.set(0, 14.2, 0);
    gate.add(banner);
    // countdown lamps hanging under the banner
    var gateLamps = [];
    const lampGeo = new THREE.SphereGeometry(0.62, 12, 10);
    for (const zz of [-3.4, 0, 3.4]) {
      const lm = new THREE.Mesh(lampGeo, new THREE.MeshStandardMaterial({
        color: 0x23232b, emissive: 0x000000, roughness: 0.35,
      }));
      lm.position.set(0, 12.1, zz);
      gate.add(lm);
      gateLamps.push(lm);
    }
    group.add(gate);
  }

  // find the start of a low-curvature stretch near a track fraction
  function findStraight(frac, len) {
    let base = Math.floor(frac * N), best = base, bestC = 1e9;
    for (let k = 0; k < 70; k++) {
      const j = (base + k) % N;
      let mx = 0;
      for (let m = 0; m < len; m++) mx = Math.max(mx, samples[(j + m) % N].curve);
      if (mx < bestC) { bestC = mx; best = j; }
      if (mx < 0.03) { best = j; break; }
    }
    return best;
  }

  // boost pads
  const boostPads = [];
  {
    const c = makeCanvas(64, 64);
    const g = c.getContext('2d');
    g.fillStyle = '#ff9020';
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#ffe9b0';
    g.beginPath();
    g.moveTo(8, 12); g.lineTo(32, 34); g.lineTo(56, 12);
    g.lineTo(56, 26); g.lineTo(32, 48); g.lineTo(8, 26);
    g.closePath(); g.fill();
    const tex = canvasTexture(c, { repeat: true });
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.95 });
    for (const frac of [0.3, 0.55, 0.8]) {
      const best = findStraight(frac, 12);
      const geo = buildRibbon(best, (best + 9) % N, -halfW * 0.72, halfW * 0.72, LIFT + 0.025, LIFT + 0.025, 6);
      const mesh = new THREE.Mesh(geo, mat);
      group.add(mesh);
      boostPads.push({ s0: best, s1: (best + 9) % N, latMax: halfW * 0.72 });
    }
  }

  // jump ramps: a wedge across the middle of the road on two long straights
  const ramps = [];
  {
    const rc = makeCanvas(64, 64);
    const rg = rc.getContext('2d');
    rg.fillStyle = '#e8b820';
    rg.fillRect(0, 0, 64, 64);
    rg.fillStyle = '#3a3440';
    for (let i = 0; i < 4; i++) rg.fillRect(0, i * 16, 64, 7);
    const rtex = canvasTexture(rc, { repeat: true });
    rtex.repeat.set(3, 1);
    const rmat = new THREE.MeshStandardMaterial({ map: rtex, roughness: 0.7 });
    for (const frac of [0.46, 0.92]) {
      const j = (findStraight(frac, 26) + 4) % N;
      const s = samples[(j + 1) % N];
      const wedge = new THREE.Mesh(new THREE.BoxGeometry(7.2, 0.5, 13), rmat);
      const wrap = new THREE.Group();
      wrap.position.set(s.x, s.y + LIFT, s.z);
      wrap.rotation.y = -Math.atan2(s.tz, s.tx);
      wedge.rotation.z = 0.3;
      wedge.position.set(0, 0.95, 0);
      wrap.add(wedge);
      group.add(wrap);
      ramps.push({ s0: j, s1: (j + 2) % N, latMax: 6.2 });
    }
  }

  // planar distance from (x,z) to the nearest centreline sample
  const minRoadDistLite = (x, z) => {
    let best = 1e9;
    for (let i = 0; i < N; i += 3) {
      const dx = samples[i].x - x, dz = samples[i].z - z;
      const d = dx * dx + dz * dz;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  };

  // --- themed hazards -------------------------------------------------------------

  const lavaPools = [], geysers = [], icePatches = [], snowmen = [];
  if (def.hazard === 'lava') {
    const poolMat = new THREE.MeshBasicMaterial({ color: 0xff5a10 });
    const poolRim = new THREE.MeshBasicMaterial({ color: 0x8a1c04 });
    for (let k = 0; k < 9; k++) {
      const i = Math.floor((k / 9) * N + 20);
      const s = samples[i % N];
      const side = k % 2 ? 1 : -1;
      const off = halfW + kerbW + 9 + rng() * 14;
      const x = s.x + (-s.tz) * side * off, z = s.z + s.tx * side * off;
      const r = 6 + rng() * 4;
      // custom/twisty layouts: never let a pool bleed onto another road section
      if (minRoadDistLite(x, z) < halfW + kerbW + r + 2) continue;
      const y = heightAt(x, z);
      const rim = new THREE.Mesh(new THREE.CircleGeometry(r + 1.6, 22), poolRim);
      rim.rotation.x = -Math.PI / 2;
      rim.position.set(x, y + 0.09, z);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 22), poolMat);
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(x, y + 0.14, z);
      group.add(rim); group.add(disc);
      lavaPools.push({ x, z, r });
    }
    const gMat = new THREE.MeshBasicMaterial({ color: 0xff8a40, transparent: true, opacity: 0.85 });
    for (let k = 0; k < 5; k++) {
      const i = Math.floor(((k + 0.5) / 5) * N);
      const s = samples[i % N];
      const side = k % 2 ? 1 : -1;
      const lat = side * (halfW - 3);
      const x = s.x + (-s.tz) * lat, z = s.z + s.tx * lat;
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 2.6, 15, 10), gMat);
      mesh.position.set(x, s.y + LIFT, z);
      mesh.scale.y = 0.03;
      group.add(mesh);
      geysers.push({ x, z, r: 3.4, phase: rng() * TAU, mesh, baseY: s.y + LIFT });
    }
  }
  if (def.hazard === 'ice') {
    const iceMat = new THREE.MeshBasicMaterial({
      color: 0xcfeeff, transparent: true, opacity: 0.5, depthWrite: false,
    });
    for (let k = 0; k < 8; k++) {
      const i = Math.floor(((k + 0.3) / 8) * N);
      const s = samples[i % N];
      const lat = (rng() * 2 - 1) * halfW * 0.5;
      const x = s.x + (-s.tz) * lat, z = s.z + s.tx * lat;
      const r = 5.5 + rng() * 2.5;
      const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 20), iceMat);
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(x, s.y + LIFT + 0.035, z);
      disc.renderOrder = 1;
      group.add(disc);
      icePatches.push({ x, z, r });
    }
    const snowMat = new THREE.MeshStandardMaterial({ color: 0xf4fafd, roughness: 0.9 });
    const carrotMat = new THREE.MeshStandardMaterial({ color: 0xe8842b, roughness: 0.8 });
    const hatMat = new THREE.MeshStandardMaterial({ color: 0x22242e, roughness: 0.9 });
    for (let k = 0; k < 16; k++) {
      const i = Math.floor((k / 16) * N + 8);
      const s = samples[i % N];
      const side = k % 2 ? 1 : -1;
      const off = halfW + kerbW + 5 + rng() * 16;
      const x = s.x + (-s.tz) * side * off, z = s.z + s.tx * side * off;
      if (minRoadDistLite(x, z) < halfW + 3) continue;
      const y = heightAt(x, z);
      const sm = new THREE.Group();
      const b1 = new THREE.Mesh(new THREE.SphereGeometry(1.15, 10, 8), snowMat);
      b1.position.y = 1.0;
      const b2 = new THREE.Mesh(new THREE.SphereGeometry(0.85, 10, 8), snowMat);
      b2.position.y = 2.5;
      const b3 = new THREE.Mesh(new THREE.SphereGeometry(0.6, 10, 8), snowMat);
      b3.position.y = 3.7;
      const nose = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.8, 8), carrotMat);
      nose.rotation.x = Math.PI / 2;
      nose.position.set(0, 3.7, 0.85);
      const hat = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.6, 10), hatMat);
      hat.position.y = 4.35;
      sm.add(b1, b2, b3, nose, hat);
      sm.position.set(x, y, z);
      sm.rotation.y = rng() * TAU;
      group.add(sm);
      snowmen.push({ x, z, group: sm, alive: true });
    }
  }

  // --- item boxes ----------------------------------------------------------------

  // Materials the game layer pulses each frame so pickups read as pickups.
  // They are shared across every instance, so this is a couple of property
  // writes per frame rather than any per-object work.
  const shine = {};

  const itemBoxes = [];
  {
    const qc = makeCanvas(64, 64);
    const qg = qc.getContext('2d');
    qg.fillStyle = '#fff8c0';
    qg.font = '900 46px Helvetica';
    qg.textAlign = 'center';
    qg.textBaseline = 'middle';
    qg.shadowColor = 'rgba(0,0,0,0.6)';
    qg.shadowBlur = 6;
    qg.fillText('?', 32, 34);
    const qTex = canvasTexture(qc);
    const boxGeo = new THREE.BoxGeometry(2.1, 2.1, 2.1);
    const edgeGeo = new THREE.EdgesGeometry(boxGeo);
    // pushed past 1.0 so the bloom threshold catches them and they glow
    const boxMat = new THREE.MeshBasicMaterial({
      color: 0x9fe0ff, transparent: true, opacity: 0.4, depthWrite: false,
    });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0xf4ffff, transparent: true, opacity: 1 });
    shine.box = boxMat;
    shine.edge = edgeMat;
    for (const frac of [0.16, 0.38, 0.62, 0.84]) {
      const i = Math.floor(frac * N);
      const s = samples[i];
      const sx = -s.tz, sz = s.tx;
      for (let k = -2; k <= 2; k++) {
        const lat = k * (halfW * 2 / 6);
        const bx = s.x + sx * lat, bz = s.z + sz * lat;
        const by = s.y + LIFT + 1.5;
        const bg = new THREE.Group();
        const cube = new THREE.Mesh(boxGeo, boxMat);
        cube.renderOrder = 4;
        const edges = new THREE.LineSegments(edgeGeo, edgeMat);
        cube.add(edges);
        const q = new THREE.Sprite(new THREE.SpriteMaterial({
          map: qTex, transparent: true, depthWrite: false,
        }));
        q.scale.set(1.5, 1.5, 1);
        bg.add(cube); bg.add(q);
        bg.position.set(bx, by, bz);
        group.add(bg);
        itemBoxes.push({ x: bx, y: by, z: bz, group: bg, cube, cooldown: 0, phase: rng() * TAU });
      }
    }
  }

  // --- coins -------------------------------------------------------------------

  const coins = [];
  {
    const coinGeo = new THREE.CylinderGeometry(0.85, 0.85, 0.16, 14).rotateX(Math.PI / 2);
    const coinMat = new THREE.MeshStandardMaterial({
      color: 0xffd94d, metalness: 0.65, roughness: 0.25, emissive: 0x5a4400,
    });
    shine.coin = coinMat;
    for (const [gi, frac] of [0.07, 0.26, 0.47, 0.56, 0.71, 0.93].entries()) {
      const base = Math.floor(frac * N);
      const lat = [-0.45, 0.45, 0, -0.45, 0.45, 0][gi] * halfW;
      for (let k = 0; k < 5; k++) {
        const s = samples[(base + k * 3) % N];
        const x = s.x + (-s.tz) * lat, z = s.z + s.tx * lat;
        const y = s.y + LIFT + 1.15;
        const mesh = new THREE.Mesh(coinGeo, coinMat);
        mesh.position.set(x, y, z);
        group.add(mesh);
        coins.push({ x, z, y, mesh, taken: false });
      }
    }
  }

  // --- scenery ---------------------------------------------------------------------

  {
    const parts = [], glowParts = [];
    const trunkGeo = new THREE.CylinderGeometry(0.32, 0.46, 3, 6);
    const cone1 = new THREE.ConeGeometry(2.3, 4.6, 8);
    const cone2 = new THREE.ConeGeometry(1.7, 3.4, 8);
    const palmTrunk = new THREE.CylinderGeometry(0.26, 0.42, 7.5, 6);
    const leafGeo = new THREE.BoxGeometry(3.6, 0.14, 0.95);
    const cocoGeo = new THREE.SphereGeometry(0.32, 8, 6);
    const pyBase = new THREE.BoxGeometry(1.5, 10.5, 1.5);
    const pyCap = new THREE.BoxGeometry(1.95, 0.5, 1.95);
    const pyStrip = new THREE.BoxGeometry(0.22, 9.5, 0.12);
    const ringGeo = new THREE.TorusGeometry(1.7, 0.13, 8, 20);

    const fogCol = new THREE.Color(T.fog);
    // Distance haze baked into the vertex colours. Scene fog already handles
    // camera distance; this adds the depth cue fog cannot, because it varies
    // with how far a thing sits from the track rather than from the camera.
    const hazed = (base, haze) => new THREE.Color(base).lerp(fogCol, haze);

    for (let i = 0; i < N; i += 8) {
      for (const side of [-1, 1]) {
        if (rng() < 0.35) continue;
        const s = samples[i];
        const off = halfW + kerbW + 7 + rng() * 60;
        const x = s.x + (-s.tz) * side * off;
        const z = s.z + s.tx * side * off;
        const roadDist = minRoadDistLite(x, z);
        if (roadDist < halfW + kerbW + 4) continue;
        const y = heightAt(x, z);
        const sc = 0.9 + rng() * 0.8;
        const haze = clamp((roadDist - 60) / 240, 0, 1) * 0.4;
        const ao = { base: y, height: 5.5 * sc, dark: 0.5 };

        if (def.deco === 'pine') {
          const g1 = 0.16 + rng() * 0.1;
          parts.push({ geometry: trunkGeo, matrix: mat4(x, y + 1.5 * sc, z, 0, sc), color: hazed(0x6b4a2b, haze), ao });
          parts.push({ geometry: cone1, matrix: mat4(x, y + 5.0 * sc, z, rng() * TAU, sc), color: hazed(new THREE.Color(0.13, 0.32 + g1, 0.16), haze), ao });
          parts.push({ geometry: cone2, matrix: mat4(x, y + 7.7 * sc, z, rng() * TAU, sc), color: hazed(new THREE.Color(0.16, 0.38 + g1, 0.19), haze), ao });
        } else if (def.deco === 'snowpine') {
          const wt = 0.9 + rng() * 0.08;
          parts.push({ geometry: trunkGeo, matrix: mat4(x, y + 1.5 * sc, z, 0, sc), color: hazed(0x5a4433, haze), ao });
          parts.push({ geometry: cone1, matrix: mat4(x, y + 5.0 * sc, z, rng() * TAU, sc), color: hazed(new THREE.Color(0.3, 0.42, 0.38), haze), ao });
          parts.push({ geometry: cone2, matrix: mat4(x, y + 7.7 * sc, z, rng() * TAU, sc), color: hazed(new THREE.Color(wt, wt + 0.03, 1), haze), ao });
        } else if (def.deco === 'spire') {
          const rock = new THREE.Color(0.14 + rng() * 0.05, 0.09, 0.1);
          parts.push({ geometry: cone1, matrix: mat4(x, y + 4.4 * sc, z, rng() * TAU, sc * 1.5, (rng() - 0.5) * 0.24), color: hazed(rock, haze), ao });
          parts.push({ geometry: cone2, matrix: mat4(x + 2.2 * sc, y + 2.6 * sc, z + 1.2 * sc, rng() * TAU, sc, (rng() - 0.5) * 0.3), color: hazed(rock, haze), ao });
          if (rng() < 0.45) {
            glowParts.push({ geometry: pyStrip, matrix: mat4(x, y + 2.6 * sc, z, rng() * TAU, sc * 0.55), color: 0xff5a18 });
          }
        } else if (def.deco === 'palm') {
          const tiltZ = (rng() - 0.5) * 0.3;
          parts.push({ geometry: palmTrunk, matrix: mat4(x, y + 3.7 * sc, z, rng() * TAU, sc, tiltZ), color: hazed(0x8a6136, haze), ao });
          const hx = x - Math.sin(tiltZ) * 7 * sc * 0.5, hy = y + 7.3 * sc;
          for (let L = 0; L < 6; L++) {
            const a = (L / 6) * TAU + rng() * 0.4;
            parts.push({
              geometry: leafGeo,
              matrix: mat4(hx + Math.cos(a) * 1.5 * sc, hy, z + Math.sin(a) * 1.5 * sc, -a, sc, -0.4),
              color: hazed(new THREE.Color(0.16, 0.5 + rng() * 0.14, 0.24), haze),
              ao,
            });
          }
          parts.push({ geometry: cocoGeo, matrix: mat4(hx + 0.4, hy - 0.5, z, 0, sc), color: hazed(0xc8892f, haze), ao });
        } else {
          // neon pylon
          parts.push({ geometry: pyBase, matrix: mat4(x, y + 5.25 * sc, z, rng() * 0.6, sc), color: hazed(0x171730, haze), ao });
          parts.push({ geometry: pyCap, matrix: mat4(x, y + 10.6 * sc, z, rng() * 0.6, sc), color: hazed(0x20204a, haze), ao });
          const neon = rng() < 0.5 ? 0x18e0ff : 0xff4fd8;
          glowParts.push({ geometry: pyStrip, matrix: mat4(x + 0.82 * sc, y + 5.25 * sc, z, 0, sc), color: neon });
          glowParts.push({ geometry: pyStrip, matrix: mat4(x - 0.82 * sc, y + 5.25 * sc, z, 0, sc), color: neon });
          if (rng() < 0.4) {
            glowParts.push({ geometry: ringGeo, matrix: mat4(x, y + 12.4 * sc, z, 0, sc, 0, Math.PI / 2), color: neon });
          }
        }
      }
    }

    if (parts.length) {
      const mesh = new THREE.Mesh(mergeParts(parts), new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.85,
      }));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    if (glowParts.length) {
      const mesh = new THREE.Mesh(mergeParts(glowParts), new THREE.MeshBasicMaterial({
        vertexColors: true,
      }));
      group.add(mesh);
    }
  }

  // --- trackside dressing ------------------------------------------------------
  // Guard rails on the corners (where run-off actually matters, and where the
  // track otherwise reads as empty), flag poles at intervals, and pockets of
  // crowd. All merged into one mesh: one extra draw call for the whole lot.
  {
    const parts = [];
    const drng = mulberry32(def.seed ^ 0xd3c0);
    const railGeo = new THREE.BoxGeometry(6.2, 1.05, 0.45);
    const postGeo = new THREE.BoxGeometry(0.3, 1.5, 0.3);
    const poleGeo = new THREE.CylinderGeometry(0.14, 0.18, 7.5, 6);
    const flagGeo = new THREE.BoxGeometry(2.5, 1.5, 0.09);
    const headGeo = new THREE.SphereGeometry(0.4, 6, 5);
    const bodyGeo = new THREE.CylinderGeometry(0.34, 0.4, 1.1, 6);
    const railCol = new THREE.Color(0xdfe3ec);
    const railWarn = new THREE.Color(0xe23c34);

    const lateral = (sm, lat) => [sm.x + (-sm.tz) * lat, sm.z + sm.tx * lat];
    const railLat = halfW + kerbW + 1.5;

    // guard rails hug the corners
    for (let i = 0; i < N; i += 2) {
      const sm = samples[i];
      if (sm.curve < 0.05) continue;
      const yaw = -Math.atan2(sm.tz, sm.tx);
      for (const side of [-1, 1]) {
        const [bx, bz] = lateral(sm, side * railLat);
        const by = sm.y + LIFT;
        const alt = (i >> 1) % 2 === 0;
        parts.push({
          geometry: railGeo, matrix: mat4(bx, by + 1.0, bz, yaw),
          color: alt ? railCol : railWarn,
          ao: { base: by, height: 1.6, dark: 0.45 },
        });
        parts.push({
          geometry: postGeo, matrix: mat4(bx, by + 0.75, bz, yaw),
          color: 0x6b7280, ao: { base: by, height: 1.6, dark: 0.4 },
        });
      }
    }

    // flag poles, evenly spaced right around the lap
    const flagEvery = Math.max(8, Math.floor(N / 16));
    for (let i = 0; i < N; i += flagEvery) {
      const sm = samples[i];
      const yaw = -Math.atan2(sm.tz, sm.tx);
      const side = (i / flagEvery) % 2 === 0 ? 1 : -1;
      const [px, pz] = lateral(sm, side * (railLat + 3.2));
      const py = heightAt(px, pz);
      const hue = drng();
      parts.push({
        geometry: poleGeo, matrix: mat4(px, py + 3.75, pz, 0),
        color: 0xb9bfcc, ao: { base: py, height: 5, dark: 0.5 },
      });
      parts.push({
        geometry: flagGeo,
        matrix: mat4(px + 1.25 * -Math.sin(yaw), py + 6.4, pz + 1.25 * Math.cos(yaw), yaw + Math.PI / 2),
        color: new THREE.Color().setHSL(hue, 0.85, 0.55),
      });
    }

    // pockets of crowd behind the rails, thickest near the start line
    const stands = [0.02, 0.2, 0.44, 0.63, 0.85];
    for (const frac of stands) {
      const base = Math.floor(frac * N);
      const side = drng() < 0.5 ? 1 : -1;
      for (let row = 0; row < 3; row++) {
        for (let k = 0; k < 7; k++) {
          const sm = samples[(base + k * 2) % N];
          const lat = side * (railLat + 3 + row * 1.6);
          const [cx2, cz2] = lateral(sm, lat);
          const cy = heightAt(cx2, cz2) + row * 0.55;
          if (minRoadDistLite(cx2, cz2) < halfW + kerbW) continue;
          const shirt = new THREE.Color().setHSL(drng(), 0.7, 0.45 + drng() * 0.2);
          const bob = drng() * 0.25;
          parts.push({
            geometry: bodyGeo, matrix: mat4(cx2, cy + 0.55 + bob, cz2, drng() * TAU),
            color: shirt, ao: { base: cy, height: 1.4, dark: 0.45 },
          });
          parts.push({
            geometry: headGeo, matrix: mat4(cx2, cy + 1.35 + bob, cz2, 0),
            color: new THREE.Color().setHSL(0.08, 0.35, 0.55 + drng() * 0.25),
          });
        }
      }
    }

    if (parts.length) {
      const mesh = new THREE.Mesh(mergeParts(parts), new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.8,
      }));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }

  // mountains ring
  {
    const parts = [];
    const mCol = new THREE.Color(T.mountain);
    for (let i = 0; i < 22; i++) {
      const a = (i / 22) * TAU + rng() * 0.2;
      const rad = 800 + rng() * 280;
      const h = 100 + rng() * 170;
      const w = 80 + rng() * 90;
      const cc = mCol.clone().offsetHSL(0, 0, (rng() - 0.5) * 0.05);
      parts.push({
        geometry: new THREE.ConeGeometry(w, h, 6),
        matrix: mat4(Math.cos(a) * rad, h / 2 - 30, Math.sin(a) * rad, rng() * TAU),
        color: cc,
      });
    }
    const mesh = new THREE.Mesh(mergeParts(parts), new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 1,
    }));
    group.add(mesh);
  }

  // --- sky, sun, lights ---------------------------------------------------------

  {
    // The sky was a 4px-wide gradient stretched around the whole dome. It is
    // now a real 512x512 painting: same one draw call, same one upload, drawn
    // once when the track is built — clouds cost nothing per frame.
    const SKY = 512;
    const c = makeCanvas(SKY, SKY);
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, SKY);
    grad.addColorStop(0, T.skyTop);
    grad.addColorStop(0.42, T.skyMid);
    grad.addColorStop(0.52, T.horizon);
    grad.addColorStop(0.56, T.fog);
    grad.addColorStop(1, T.fog);
    g.fillStyle = grad;
    g.fillRect(0, 0, SKY, SKY);

    const srng = mulberry32(def.seed ^ 0x5c10);
    const hz = new THREE.Color(T.horizon);
    const rgb = (col, a) => 'rgba(' + Math.round(col.r * 255) + ',' + Math.round(col.g * 255) +
      ',' + Math.round(col.b * 255) + ',' + a + ')';

    // a warm lift just above the horizon, where the light actually comes from
    const glowBand = g.createLinearGradient(0, SKY * 0.30, 0, SKY * 0.53);
    glowBand.addColorStop(0, rgb(hz, 0));
    glowBand.addColorStop(1, rgb(hz, 0.5));
    g.fillStyle = glowBand;
    g.fillRect(0, SKY * 0.30, SKY, SKY * 0.23);

    // Clouds, lit from the horizon colour so they belong to their theme. Each
    // is drawn three times so nothing seams where the texture wraps.
    const cloudCol = hz.clone().lerp(new THREE.Color(0xffffff), T.stars ? 0.1 : 0.55);
    const puff = (cx, cy, rw, rh, a) => {
      for (const off of [-SKY, 0, SKY]) {
        g.save();
        g.translate(cx + off, cy);
        g.scale(1, rh / rw);
        const rad = g.createRadialGradient(0, 0, 0, 0, 0, rw);
        rad.addColorStop(0, rgb(cloudCol, a));
        rad.addColorStop(0.5, rgb(cloudCol, a * 0.5));
        rad.addColorStop(1, rgb(cloudCol, 0));
        g.fillStyle = rad;
        g.beginPath();
        g.arc(0, 0, rw, 0, TAU);
        g.fill();
        g.restore();
      }
    };
    const bankCount = T.stars ? 5 : 13;
    for (let i = 0; i < bankCount; i++) {
      // lower banks are smaller and fainter: cheap aerial perspective in the sky
      const t = srng();
      const cy = SKY * (0.10 + t * 0.34);
      const near = 1 - t;
      const cx = srng() * SKY;
      const rw = SKY * (0.05 + near * 0.09);
      const a = (T.stars ? 0.12 : 0.3) * (0.45 + near * 0.55);
      const lobes = 3 + Math.floor(srng() * 3);
      for (let k = 0; k < lobes; k++) {
        puff(cx + (k - lobes / 2) * rw * 0.85 + (srng() - 0.5) * rw * 0.5,
             cy + (srng() - 0.5) * rw * 0.28,
             rw * (0.6 + srng() * 0.6), rw * (0.26 + srng() * 0.2), a);
      }
    }

    const skyTex = canvasTexture(c, { repeat: true });
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(1650, 32, 20),
      new THREE.MeshBasicMaterial({
        map: skyTex, side: THREE.BackSide, fog: false, depthWrite: false,
      })
    );
    dome.renderOrder = -10;
    dome.frustumCulled = false;
    group.add(dome);

    // sun
    const sc = makeCanvas(128, 128);
    const sg = sc.getContext('2d');
    const sgr = sg.createRadialGradient(64, 64, 4, 64, 64, 62);
    sgr.addColorStop(0, T.sun);
    sgr.addColorStop(0.3, T.sun + 'cc');
    sgr.addColorStop(1, 'rgba(255,255,255,0)');
    sg.fillStyle = sgr;
    sg.fillRect(0, 0, 128, 128);
    const sun = new THREE.Sprite(new THREE.SpriteMaterial({
      map: canvasTexture(sc), transparent: true, fog: false, depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    const sd = new THREE.Vector3(...T.sunDir).normalize();
    sun.position.copy(sd).multiplyScalar(1450);
    sun.scale.set(T.sunScale, T.sunScale, 1);
    sun.renderOrder = -9;
    group.add(sun);

    if (T.stars) {
      const starPos = [];
      for (let i = 0; i < 450; i++) {
        const a = rng() * TAU, e2 = rng() * Math.PI * 0.48 + 0.05;
        starPos.push(
          Math.cos(a) * Math.cos(e2) * 1500,
          Math.sin(e2) * 1500,
          Math.sin(a) * Math.cos(e2) * 1500,
        );
      }
      const sgeo = new THREE.BufferGeometry();
      sgeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
      const stars = new THREE.Points(sgeo, new THREE.PointsMaterial({
        color: 0xffffff, size: 2.6, sizeAttenuation: false, fog: false,
        transparent: true, opacity: 0.85,
      }));
      group.add(stars);
    }

    // Ambient fill only — the key light is the shared shadow-casting sun in
    // render.js, which follows the player so its shadow map stays sharp.
    const hemi = new THREE.HemisphereLight(
      new THREE.Color(T.hemiSky), new THREE.Color(T.hemiGround), T.hemiInt * 0.85);
    group.add(hemi);
  }

  // --- game-layer data ------------------------------------------------------------

  const wps = [];
  for (let i = 0; i < N; i += CFG.wpStride) {
    const s = samples[i];
    wps.push({ x: s.x, z: s.z, tx: s.tx, tz: s.tz, y: s.y, curve: 0, sIdx: i });
  }
  for (let i = 0; i < wps.length; i++) {
    const a = wps[i], b = wps[(i + 3) % wps.length];
    a.curve = Math.abs(angNorm(Math.atan2(b.tz, b.tx) - Math.atan2(a.tz, a.tx)));
  }

  // nearest-centreline query with a per-caller hint
  function query(x, z, hint) {
    let best = hint | 0, bestD = Infinity;
    for (let k = -16; k <= 20; k++) {
      const i = ((hint + k) % N + N) % N;
      const dx = samples[i].x - x, dz = samples[i].z - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (bestD > 6400) {
      for (let i = 0; i < N; i += 2) {
        const dx = samples[i].x - x, dz = samples[i].z - z;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    const s = samples[best];
    const lat = (x - s.x) * (-s.tz) + (z - s.z) * s.tx;
    const roadY = s.y + LIFT;
    const absLat = Math.abs(lat);
    let groundY;
    if (absLat <= halfW + kerbW) groundY = roadY;
    else {
      const t = clamp((absLat - halfW - kerbW) / 12, 0, 1);
      groundY = lerp(roadY, heightAt(x, z), t);
    }
    return {
      sIdx: best, lat, dist: Math.sqrt(bestD), roadY, groundY,
      tx: s.tx, tz: s.tz, curve: s.curve,
      onRoad: absLat <= halfW + kerbW,
    };
  }

  // --- minimap ----------------------------------------------------------------------

  const minimap = makeCanvas(180, 180);
  {
    const g = minimap.getContext('2d');
    const toMap = (x, z) => [(x + E) / (2 * E) * 164 + 8, (z + E) / (2 * E) * 164 + 8];
    g.beginPath();
    for (let i = 0; i < N; i += 4) {
      const [mx, my] = toMap(samples[i].x, samples[i].z);
      if (i === 0) g.moveTo(mx, my); else g.lineTo(mx, my);
    }
    g.closePath();
    g.strokeStyle = 'rgba(0,0,0,0.6)';
    g.lineWidth = 11;
    g.lineJoin = 'round';
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.92)';
    g.lineWidth = 5.5;
    g.stroke();
    // start tick
    const [sx0, sy0] = toMap(samples[0].x, samples[0].z);
    g.fillStyle = '#ffd94d';
    g.beginPath();
    g.arc(sx0, sy0, 4.5, 0, TAU);
    g.fill();
  }
  const worldToMap = (x, z) => [(x + E) / (2 * E) * 164 + 8, (z + E) / (2 * E) * 164 + 8];

  const startAngle = Math.atan2(samples[0].tz, samples[0].tx);

  const track = {
    def, theme: T, key, laps: def.laps,
    group, samples, N, length, wps,
    heightAt, query,
    itemBoxes, boostPads, ramps, coins, gateLamps, shine,
    lavaPools, geysers, icePatches, snowmen,
    minimap, worldToMap,
    halfW, kerbW,
    startPose: { x: samples[0].x, z: samples[0].z, angle: startAngle },
    spacing: length / N,
  };
  cache[key] = track;
  return track;
}
