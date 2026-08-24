// ---------------------------------------------------------------------------
// Procedural kart model. Built facing +X; the root group carries yaw, the
// tilt node carries terrain pitch/roll, drift lean, and the hop.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { clamp, makeCanvas, canvasTexture } from './util.js';
import { makeBlobShadow } from './fx.js';
import { RoundedBoxGeometry } from './vendor/jsm/geometries/RoundedBoxGeometry.js';

const WHEEL_GEO_F = new THREE.CylinderGeometry(0.62, 0.62, 0.5, 24).rotateX(Math.PI / 2);
const WHEEL_GEO_R = new THREE.CylinderGeometry(0.78, 0.78, 0.62, 24).rotateX(Math.PI / 2);
const HUB_GEO_F = new THREE.CylinderGeometry(0.3, 0.3, 0.54, 18).rotateX(Math.PI / 2);
const HUB_GEO_R = new THREE.CylinderGeometry(0.38, 0.38, 0.66, 18).rotateX(Math.PI / 2);

// Chunky bevelled boxes: the single biggest cue that separates a "toy" kart
// from a pile of raw cubes — edges catch a highlight instead of going hard.
function rbox(w, h, d, r) {
  const rad = Math.min(r == null ? 0.12 : r, w / 2.05, h / 2.05, d / 2.05);
  return new RoundedBoxGeometry(w, h, d, 3, rad);
}

function flameTexture() {
  const c = makeCanvas(64, 64);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255,250,200,1)');
  grad.addColorStop(0.4, 'rgba(255,160,50,0.9)');
  grad.addColorStop(1, 'rgba(255,80,20,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return canvasTexture(c);
}
let _flameTex = null;

// A wheel turning at true road speed passes ~16 revolutions a second, which at
// 60Hz aliases into a strobe that reads as "spinning backwards slowly". Cap the
// visual rate: past this everything looks fast anyway, and only the strobe is
// actually perceptible.
const MAX_SPIN = 26;          // rad/s of visual wheel rotation
const BLUR_SPEED = 34;        // road speed where the blurred tyre takes over

// One shared blurred tyre for every kart on track: a soft band that smears the
// rim highlight instead of letting it flicker.
let _blurTireMat = null;
function blurTireMat() {
  if (_blurTireMat) return _blurTireMat;
  const c = makeCanvas(32, 32);
  const g = c.getContext('2d');
  g.fillStyle = '#1b1b21';
  g.fillRect(0, 0, 32, 32);
  const grad = g.createLinearGradient(0, 0, 0, 32);
  grad.addColorStop(0, 'rgba(120,124,140,0)');
  grad.addColorStop(0.5, 'rgba(120,124,140,0.34)');
  grad.addColorStop(1, 'rgba(120,124,140,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  _blurTireMat = new THREE.MeshStandardMaterial({
    map: canvasTexture(c, { repeat: true }), color: 0xffffff, roughness: 0.8,
  });
  return _blurTireMat;
}

export class KartVisual {
  constructor(palette, head = 'human') {
    const P = palette;
    // Clearcoat on the body/helmet reads as glossy moulded plastic under IBL.
    this.mats = {
      body: new THREE.MeshPhysicalMaterial({
        color: P.body, roughness: 0.34, metalness: 0.0,
        clearcoat: 1.0, clearcoatRoughness: 0.08,
      }),
      accent: new THREE.MeshPhysicalMaterial({
        color: P.accent, roughness: 0.4, clearcoat: 0.8, clearcoatRoughness: 0.15,
      }),
      suit: new THREE.MeshStandardMaterial({ color: P.suit, roughness: 0.72 }),
      helmet: new THREE.MeshPhysicalMaterial({
        color: P.helmet, roughness: 0.22, clearcoat: 1.0, clearcoatRoughness: 0.06,
      }),
      skin: new THREE.MeshStandardMaterial({ color: P.skin || P.helmet, roughness: 0.55 }),
      dark: new THREE.MeshStandardMaterial({ color: P.dark, roughness: 0.7, metalness: 0.15 }),
      tire: new THREE.MeshStandardMaterial({ color: 0x1b1b21, roughness: 0.88 }),
      hub: new THREE.MeshStandardMaterial({ color: 0xc6c6d2, roughness: 0.26, metalness: 0.85 }),
      visor: new THREE.MeshPhysicalMaterial({
        color: 0x141a28, roughness: 0.06, metalness: 0.2,
        clearcoat: 1.0, clearcoatRoughness: 0.03,
      }),
    };
    const M = this.mats;
    this.headType = head;

    this.group = new THREE.Group();
    this.tilt = new THREE.Group();
    this.group.add(this.tilt);

    const add = (geo, mat, x, y, z, ry = 0, rz = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.y = ry;
      m.rotation.z = rz;
      m.castShadow = true;
      this.tilt.add(m);
      return m;
    };
    const box = (a, b, c) => rbox(a, b, c, 0.1);

    // chassis
    add(rbox(4.6, 0.36, 2.7, 0.16), M.body, 0, 0.62, 0);
    add(rbox(1.5, 0.34, 1.5, 0.16), M.body, 2.55, 0.60, 0);    // nose
    add(box(0.5, 0.26, 2.15), M.accent, 2.1, 0.56, 0);         // bumper stripe
    add(rbox(1.2, 0.3, 0.6, 0.14), M.body, 3.15, 0.58, 0);     // nose tip
    add(box(0.9, 0.24, 2.9), M.dark, 0.2, 0.48, 0);            // side rails
    add(box(1.9, 0.32, 1.9), M.dark, -0.1, 0.86, 0);           // cockpit rim
    add(box(0.5, 1.05, 1.5), M.dark, -1.55, 1.22, 0);          // seat back
    add(box(1.1, 0.6, 1.6), M.dark, -1.95, 0.95, 0);           // engine block
    // spoiler
    this.wing = add(box(0.9, 0.12, 2.6), M.accent, -2.25, 1.78, 0);
    add(box(0.12, 0.5, 0.12), M.dark, -2.25, 1.5, 0.9);
    add(box(0.12, 0.5, 0.12), M.dark, -2.25, 1.5, -0.9);
    // exhausts
    const exGeo = new THREE.CylinderGeometry(0.15, 0.13, 0.7, 8).rotateZ(Math.PI / 2);
    this.exhausts = [
      add(exGeo, M.hub, -2.6, 1.1, 0.45),
      add(exGeo, M.hub, -2.6, 1.1, -0.45),
    ];

    // driver
    add(box(0.95, 0.95, 1.15), M.suit, -0.35, 1.4, 0);          // torso
    add(box(0.75, 0.28, 0.28), M.suit, 0.3, 1.5, 0.5, -0.55);   // arms
    add(box(0.75, 0.28, 0.28), M.suit, 0.3, 1.5, -0.5, 0.55);
    const wheelTorus = new THREE.TorusGeometry(0.34, 0.075, 8, 16).rotateY(Math.PI / 2);
    add(wheelTorus, M.dark, 0.72, 1.52, 0, 0, -0.35);           // steering wheel
    this._buildHead(head, add, M);

    // wheels: front pair steers, all four spin
    this.wheels = [];
    this.steerPivots = [];
    const mkWheel = (x, z, front) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, front ? 0.62 : 0.78, z);
      const tire = new THREE.Mesh(front ? WHEEL_GEO_F : WHEEL_GEO_R, M.tire);
      tire.castShadow = true;
      const hub = new THREE.Mesh(front ? HUB_GEO_F : HUB_GEO_R, M.hub);
      tire.add(hub);
      pivot.add(tire);
      this.tilt.add(pivot);
      this.wheels.push(tire);
      if (front) this.steerPivots.push(pivot);
    };
    mkWheel(1.6, 1.55, true);
    mkWheel(1.6, -1.55, true);
    mkWheel(-1.6, 1.62, false);
    mkWheel(-1.6, -1.62, false);

    // boost flames
    if (!_flameTex) _flameTex = flameTexture();
    this.flames = [0.45, -0.45].map((z) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: _flameTex,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }));
      s.position.set(-3.2, 1.1, z);
      s.scale.set(0.001, 0.001, 1);
      this.tilt.add(s);
      return s;
    });

    // star-power aura
    this.aura = new THREE.Sprite(new THREE.SpriteMaterial({
      map: _flameTex,
      color: 0xffe14d,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      opacity: 0.55,
    }));
    this.aura.position.set(0, 1.2, 0);
    this.aura.scale.set(0.001, 0.001, 1);
    this.tilt.add(this.aura);

    // shield bubble
    this.bubble = new THREE.Mesh(
      new THREE.SphereGeometry(3.1, 18, 14),
      new THREE.MeshBasicMaterial({
        color: 0x7fd0ff, transparent: true, opacity: 0.2, depthWrite: false,
      })
    );
    this.bubble.position.set(-0.2, 1.4, 0);
    this.bubble.visible = false;
    this.tilt.add(this.bubble);

    this.shadow = makeBlobShadow(6.2);

    this._lean = 0;
    this._steerVis = 0;
    this._spin = 0;
    this._pitchVis = 0;
    this._prevSpeed = 0;
    this._squash = 0;
    this._wasAir = false;
    this._blurred = false;
  }

  // Character heads sit around (-0.3, 2.05, 0), facing +X.
  _buildHead(type, add, M) {
    const HX = -0.3, HY = 2.05;
    const sphere = (r, s1, s2) => new THREE.SphereGeometry(r, s1 || 24, s2 || 18);
    const box = (a, b, c) => rbox(a, b, c, 0.09);

    if (type === 'robot') {
      add(box(0.95, 0.88, 0.95), M.helmet, HX, HY + 0.05, 0);
      add(box(0.18, 0.22, 0.66), M.visor, HX + 0.44, HY + 0.12, 0);
      add(new THREE.CylinderGeometry(0.045, 0.045, 0.5, 6), M.dark, HX, HY + 0.72, 0);
      add(sphere(0.13, 8, 6), M.accent, HX, HY + 0.98, 0);
    } else if (type === 'cat') {
      add(sphere(0.6), M.skin, HX, HY + 0.05, 0);
      add(new THREE.ConeGeometry(0.2, 0.42, 8), M.skin, HX - 0.08, HY + 0.6, 0.3);
      add(new THREE.ConeGeometry(0.2, 0.42, 8), M.skin, HX - 0.08, HY + 0.6, -0.3);
      add(sphere(0.09, 8, 6), M.visor, HX + 0.5, HY + 0.14, 0.2);
      add(sphere(0.09, 8, 6), M.visor, HX + 0.5, HY + 0.14, -0.2);
      add(sphere(0.14, 8, 6), M.accent, HX + 0.55, HY - 0.08, 0);
    } else if (type === 'skull') {
      const skull = add(sphere(0.58), M.skin, HX, HY + 0.1, 0);
      skull.scale.set(0.95, 1.05, 0.9);
      add(box(0.34, 0.24, 0.5), M.skin, HX + 0.14, HY - 0.42, 0);
      add(sphere(0.13, 8, 6), M.visor, HX + 0.46, HY + 0.16, 0.2);
      add(sphere(0.13, 8, 6), M.visor, HX + 0.46, HY + 0.16, -0.2);
    } else if (type === 'granny') {
      add(sphere(0.55), M.skin, HX, HY, 0);
      add(sphere(0.4, 12, 10), M.helmet, HX - 0.25, HY + 0.5, 0);
      add(sphere(0.26, 10, 8), M.helmet, HX - 0.3, HY + 0.85, 0);
      const rim = new THREE.TorusGeometry(0.15, 0.03, 6, 14).rotateY(Math.PI / 2);
      add(rim, M.dark, HX + 0.5, HY + 0.1, 0.2);
      add(rim, M.dark, HX + 0.5, HY + 0.1, -0.2);
    } else if (type === 'alien') {
      const dome = add(sphere(0.55), M.skin, HX, HY + 0.12, 0);
      dome.scale.set(0.9, 1.2, 0.9);
      const eye = sphere(0.19, 10, 8);
      const e1 = add(eye, M.visor, HX + 0.4, HY + 0.2, 0.22);
      const e2 = add(eye, M.visor, HX + 0.4, HY + 0.2, -0.22);
      e1.scale.set(0.6, 1.3, 1); e2.scale.set(0.6, 1.3, 1);
      for (const zz of [0.18, -0.18]) {
        add(new THREE.CylinderGeometry(0.035, 0.035, 0.45, 6), M.skin, HX - 0.1, HY + 0.85, zz);
        add(sphere(0.09, 8, 6), M.accent, HX - 0.1, HY + 1.1, zz);
      }
    } else if (type === 'duck') {
      add(sphere(0.55), M.skin, HX, HY + 0.05, 0);
      const bill = add(box(0.5, 0.16, 0.5), M.accent, HX + 0.55, HY - 0.05, 0);
      bill.material = new THREE.MeshStandardMaterial({ color: 0xe8842b, roughness: 0.6 });
      add(sphere(0.1, 8, 6), M.visor, HX + 0.4, HY + 0.28, 0.2);
      add(sphere(0.1, 8, 6), M.visor, HX + 0.4, HY + 0.28, -0.2);
    } else if (type === 'bear') {
      add(sphere(0.62), M.skin, HX, HY + 0.05, 0);
      add(sphere(0.2, 10, 8), M.skin, HX - 0.1, HY + 0.6, 0.4);
      add(sphere(0.2, 10, 8), M.skin, HX - 0.1, HY + 0.6, -0.4);
      const muz = add(sphere(0.3, 10, 8), M.accent, HX + 0.48, HY - 0.08, 0);
      muz.scale.set(0.8, 0.65, 0.9);
      add(sphere(0.11, 8, 6), M.visor, HX + 0.72, HY - 0.02, 0);
      add(sphere(0.1, 8, 6), M.visor, HX + 0.42, HY + 0.26, 0.22);
      add(sphere(0.1, 8, 6), M.visor, HX + 0.42, HY + 0.26, -0.22);
    } else {
      // human racer with helmet + visor
      add(sphere(0.62, 18, 14), M.helmet, HX, HY + 0.05, 0);
      const visor = new THREE.Mesh(new THREE.SphereGeometry(0.52, 14, 10), M.visor);
      visor.position.set(0.12, HY + 0.03, 0);
      visor.scale.set(0.55, 0.6, 0.85);
      this.tilt.add(visor);
    }
  }

  // Visual take on the equipped garage parts (player kart only).
  // tiers = {engine, tires, spoiler}; paint = hex or -1 for character default.
  applyMods(tiers, paint, defaultBody) {
    const t = tiers || { engine: 0, tires: 0, spoiler: 0 };
    this.wing.scale.set(1 + t.spoiler * 0.35, 1 + t.spoiler * 0.4, 1 + t.spoiler * 0.22);
    for (const ex of this.exhausts) {
      const s = 1 + t.engine * 0.35;
      ex.scale.set(s, s, s);
    }
    this.mats.hub.color.setHex([0xb9b9c4, 0xffd94d, 0xf2843d][t.tires] || 0xb9b9c4);
    this.mats.body.color.setHex(paint != null && paint >= 0 ? paint : defaultBody);
  }

  addTo(scene) { scene.add(this.group); scene.add(this.shadow); }
  removeFrom(scene) { scene.remove(this.group); scene.remove(this.shadow); }

  // r: racer physics state. groundY/pitch/roll come from the track query.
  update(r, dt, time) {
    this.group.position.set(r.x, r.groundY + (r.hopZ || 0), r.z);
    this.group.rotation.y = -r.visYaw;

    // terrain pitch/roll + drift lean, smoothed; airborne tricks barrel-roll.
    // The lean deepens as the mini-turbo charges, so the kart's posture tells
    // you how close the boost is without looking at the bar.
    const targetLean = (r.drift || 0) * (0.15 + Math.min(0.11, (r.driftCharge || 0) * 0.07));
    this._lean += (targetLean - this._lean) * Math.min(1, dt * 8);
    const trickRoll = (r.trickT != null && r.trickT >= 0)
      ? Math.min(1, r.trickT / 0.55) * Math.PI * 2 : 0;

    // weight transfer: the nose dives under braking and lifts under power
    const accel = dt > 0 ? (r.speed - this._prevSpeed) / dt : 0;
    this._prevSpeed = r.speed;
    this._pitchVis += (clamp(accel * 0.0009, -0.055, 0.055) - this._pitchVis) *
      Math.min(1, dt * 6);

    this.tilt.rotation.z = (r.pitch || 0) + this._pitchVis + (r.airY > 0 ? -0.12 : 0);
    this.tilt.rotation.x = (r.roll || 0) + this._lean + trickRoll;

    // landing squash: springs back over a few frames, so a jump lands with weight
    const airborne = (r.airY || 0) > 0.05;
    if (this._wasAir && !airborne) this._squash = 1;
    this._wasAir = airborne;
    if (this._squash > 0) {
      this._squash = Math.max(0, this._squash - dt * 4.5);
      const sq = Math.sin(this._squash * Math.PI) * 0.2;
      this.tilt.scale.set(1 + sq * 0.45, 1 - sq, 1 + sq * 0.45);
    } else if (this.tilt.scale.y !== 1) {
      this.tilt.scale.set(1, 1, 1);
    }

    // wheels
    this._spin += clamp(r.speed / 0.7, -MAX_SPIN, MAX_SPIN) * dt;
    for (const w of this.wheels) w.rotation.z = -this._spin;
    const fast = Math.abs(r.speed) > BLUR_SPEED;
    if (fast !== this._blurred) {
      this._blurred = fast;
      const m = fast ? blurTireMat() : this.mats.tire;
      for (const w of this.wheels) w.material = m;
    }
    this._steerVis += ((r.steerVis || 0) * 0.42 - this._steerVis) * Math.min(1, dt * 10);
    for (const p of this.steerPivots) p.rotation.y = -this._steerVis;

    // flames
    const boostOn = r.boost > 0;
    for (const f of this.flames) {
      if (boostOn) {
        const s = 1.1 + Math.random() * 0.7;
        f.scale.set(s, s * 0.8, 1);
      } else f.scale.set(0.001, 0.001, 1);
    }

    // star: rainbow emissive pulse
    if (r.star > 0) {
      const hue = (time * 1.6) % 1;
      this.mats.body.emissive.setHSL(hue, 0.95, 0.45);
      this.mats.accent.emissive.setHSL((hue + 0.33) % 1, 0.95, 0.4);
      const s = 7 + Math.sin(time * 18) * 1.2;
      this.aura.scale.set(s, s * 0.8, 1);
      this.aura.material.color.setHSL(hue, 0.9, 0.65);
    } else {
      this.mats.body.emissive.setRGB(0, 0, 0);
      this.mats.accent.emissive.setRGB(0, 0, 0);
      this.aura.scale.set(0.001, 0.001, 1);
    }

    // shield bubble
    this.bubble.visible = !!r.shield;
    if (r.shield) {
      const bs = 1 + Math.sin(time * 6) * 0.05;
      this.bubble.scale.set(bs, bs, bs);
    }

    // spin-out / EMP-stall flicker
    this.group.visible = !((r.spin > 0 || r.stall > 0) && Math.sin(time * 40) > 0.55);

    // blob shadow follows the ground even during hops
    this.shadow.position.set(r.x, r.groundY + 0.06, r.z);
    this.shadow.rotation.z = -r.visYaw;
    const sh = 1 - Math.min(0.45, (r.hopZ || 0) * 0.3);
    this.shadow.scale.set(sh, sh, 1);
  }
}
