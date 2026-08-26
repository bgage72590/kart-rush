// ---------------------------------------------------------------------------
// DOM HUD: lap/time/position panels, item slot, minimap, speedometer,
// menus, pause and results screens.
// ---------------------------------------------------------------------------
import { CFG, TRACK_DEFS, CHARACTERS, charStats, MODES } from './config.js';
import { clamp, fmtTime, ordinal, suffix, TAU, makeCanvas } from './util.js';
import { G, getBestForDef, curClass } from './race.js';
import { Garage, PARTS, PAINTS } from './garage.js';
import { getTrackDef } from './tracklab.js';
import { showTouchControls } from './touch.js';

const $ = (id) => document.getElementById(id);

const MAP_U = 180;      // minimap authoring units
const SPD_U = 160;      // speedometer authoring units

const el = {};
let itemCtx = null, mapCtx = null, spdCtx = null;
let lastCountdownText = '';

// --- item icons (drawn once) --------------------------------------------------
//
// Drawn into offscreen bitmaps at boot and blitted from then on, so detail here
// is free at runtime. They are authored in a 76-unit space and rasterised at
// device resolution: at 76px on a 3x phone the old bitmaps were being upscaled
// into mush.
//
// Small-icon rules: commit to the silhouette first, then a rim light, then at
// most a couple of interior details. Anything finer turns to noise at the 54px
// the HUD uses on a phone.

// Certification: graphics "MUST NOT be blurry, pixelated, or stretched". A
// canvas whose backing store is authored at CSS size is exactly that on any
// device with a pixel ratio above 1, so every HUD canvas is rasterised at
// device resolution and its context scaled back into authoring units.
const HUD_DPR = Math.min(3, Math.max(1, Math.ceil(devicePixelRatio || 1)));

const ICONS = {};
const ICON_U = 76;                                   // authoring units
const ICON_PX = ICON_U * HUD_DPR;

function drawIcons() {
  const mk = (fn) => {
    const c = makeCanvas(ICON_PX, ICON_PX);
    const g = c.getContext('2d');
    g.scale(ICON_PX / ICON_U, ICON_PX / ICON_U);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    // a soft drop shadow lifts every icon off the translucent slot behind it
    g.shadowColor = 'rgba(0,0,0,0.55)';
    g.shadowBlur = 3.5;
    g.shadowOffsetY = 1.6;
    fn(g);
    return c;
  };

  // stroke an already-built path as a dark keyline, shadow suppressed so the
  // outline stays tight instead of smearing
  const keyline = (g, w, color) => {
    const sb = g.shadowBlur, so = g.shadowOffsetY;
    g.shadowBlur = 0; g.shadowOffsetY = 0;
    g.strokeStyle = color || 'rgba(28,22,32,0.7)';
    g.lineWidth = w == null ? 2.4 : w;
    g.stroke();
    g.shadowBlur = sb; g.shadowOffsetY = so;
  };
  const noShadow = (g, fn) => {
    const sb = g.shadowBlur, so = g.shadowOffsetY;
    g.shadowBlur = 0; g.shadowOffsetY = 0;
    fn();
    g.shadowBlur = sb; g.shadowOffsetY = so;
  };
  // the glossy sweep that sells moulded plastic
  const gloss = (g, cx, cy, rx, ry, rot, a) => noShadow(g, () => {
    g.save();
    g.globalAlpha = a == null ? 0.5 : a;
    g.fillStyle = '#fff';
    g.beginPath();
    g.ellipse(cx, cy, rx, ry, rot || 0, 0, TAU);
    g.fill();
    g.restore();
  });

  ICONS.mushroom = mk((g) => {
    // stem, tapered with a shaded underside
    const stem = g.createLinearGradient(26, 40, 50, 40);
    stem.addColorStop(0, '#d9c8a6');
    stem.addColorStop(0.42, '#f7ead0');
    stem.addColorStop(1, '#c9b591');
    g.fillStyle = stem;
    g.beginPath();
    g.moveTo(29, 40); g.lineTo(47, 40);
    g.quadraticCurveTo(49, 60, 45, 66);
    g.quadraticCurveTo(38, 69, 31, 66);
    g.quadraticCurveTo(27, 60, 29, 40);
    g.closePath(); g.fill();
    keyline(g, 2.2);

    const cap = g.createRadialGradient(28, 22, 3, 38, 40, 30);
    cap.addColorStop(0, '#ff7a6e');
    cap.addColorStop(0.45, '#ec4b41');
    cap.addColorStop(1, '#b52c26');
    g.fillStyle = cap;
    g.beginPath(); g.arc(38, 40, 27, Math.PI, TAU); g.fill();
    g.beginPath(); g.moveTo(11, 40); g.lineTo(65, 40); g.arc(38, 40, 27, 0, Math.PI, true);
    g.closePath(); keyline(g, 2.4);

    noShadow(g, () => {
      const spot = (x, y, r) => {
        const sg = g.createRadialGradient(x - r * 0.3, y - r * 0.3, 1, x, y, r);
        sg.addColorStop(0, '#ffffff');
        sg.addColorStop(1, '#e6e0d2');
        g.fillStyle = sg;
        g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
      };
      spot(27, 27, 7.5);
      spot(49, 30, 6);
      spot(38, 19, 4.2);
      // shadow the cap sits into the stem
      g.fillStyle = 'rgba(0,0,0,0.18)';
      g.beginPath(); g.ellipse(38, 41, 19, 3.2, 0, 0, TAU); g.fill();
    });
    gloss(g, 26, 24, 8, 4.5, -0.6, 0.45);
  });

  ICONS.banana = mk((g) => {
    // A thin crescent vanishes at 54px. Give it real thickness and let it fill
    // the badge corner to corner.
    const body = g.createLinearGradient(14, 16, 54, 60);
    body.addColorStop(0, '#fff4a0');
    body.addColorStop(0.42, '#f4d341');
    body.addColorStop(1, '#b98f12');
    g.fillStyle = body;
    g.beginPath();
    g.moveTo(11, 44);
    g.quadraticCurveTo(30, 6, 64, 34);          // outer curve
    g.quadraticCurveTo(69, 40, 62, 46);         // round the tip
    g.quadraticCurveTo(36, 24, 22, 60);         // inner curve back
    g.quadraticCurveTo(13, 57, 11, 44);
    g.closePath();
    g.fill();
    keyline(g, 2.6);

    noShadow(g, () => {
      g.strokeStyle = 'rgba(255,255,255,0.6)';
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(17, 42); g.quadraticCurveTo(32, 14, 58, 36);
      g.stroke();
      g.strokeStyle = 'rgba(120,88,10,0.38)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(20, 52); g.quadraticCurveTo(35, 30, 56, 44);
      g.stroke();
    });

    // stalk at the bottom, dark tip at the top
    g.fillStyle = '#5f4a0e';
    g.beginPath();
    g.moveTo(10, 52); g.lineTo(20, 58); g.lineTo(17, 68); g.lineTo(8, 62);
    g.closePath(); g.fill();
    keyline(g, 2);
    g.fillStyle = '#4a3a0b';
    g.beginPath(); g.arc(64, 40, 4.2, 0, TAU); g.fill();
    keyline(g, 1.6);
  });

  const shell = (light, mid, dark) => (g) => {
    // white underbelly
    const belly = g.createLinearGradient(0, 46, 0, 66);
    belly.addColorStop(0, '#fffdf2');
    belly.addColorStop(1, '#ded4bb');
    g.fillStyle = belly;
    g.beginPath(); g.ellipse(38, 53, 28, 14, 0, 0, TAU); g.fill();
    keyline(g, 2.4);

    const dome = g.createRadialGradient(27, 22, 2, 38, 40, 32);
    dome.addColorStop(0, light);
    dome.addColorStop(0.42, mid);
    dome.addColorStop(1, dark);
    g.fillStyle = dome;
    g.beginPath(); g.arc(38, 41, 28, Math.PI, TAU); g.fill();
    g.beginPath(); g.moveTo(10, 41); g.lineTo(66, 41); g.arc(38, 41, 28, 0, Math.PI, true);
    g.closePath(); keyline(g, 2.6);

    noShadow(g, () => {
      // shell segments radiating from the crown
      g.strokeStyle = 'rgba(0,0,0,0.26)';
      g.lineWidth = 1.7;
      for (const a of [-2.45, -1.95, -1.44, -0.94, -0.44]) {
        g.beginPath();
        g.moveTo(38 + Math.cos(a) * 9, 41 + Math.sin(a) * 9);
        g.lineTo(38 + Math.cos(a) * 27, 41 + Math.sin(a) * 27);
        g.stroke();
      }
      g.beginPath(); g.arc(38, 41, 13, Math.PI, TAU); g.stroke();
      // the pale rim band between dome and belly
      g.fillStyle = '#f6efdc';
      g.fillRect(10, 39, 56, 6);
      g.strokeStyle = 'rgba(28,22,32,0.55)';
      g.lineWidth = 1.6;
      g.strokeRect(10, 39, 56, 6);
    });
    gloss(g, 26, 25, 9, 5, -0.62, 0.5);
  };
  ICONS.green = mk(shell('#8ff0a0', '#3fa84f', '#1d6b2c'));
  ICONS.red = mk(shell('#ff9187', '#d63b34', '#8d1f1a'));

  ICONS.star = mk((g) => {
    noShadow(g, () => {
      const halo = g.createRadialGradient(38, 39, 6, 38, 39, 36);
      halo.addColorStop(0, 'rgba(255,236,140,0.55)');
      halo.addColorStop(1, 'rgba(255,225,77,0)');
      g.fillStyle = halo;
      g.beginPath(); g.arc(38, 39, 36, 0, TAU); g.fill();
    });

    const body = g.createLinearGradient(20, 12, 52, 64);
    body.addColorStop(0, '#fff7c2');
    body.addColorStop(0.45, '#ffe14d');
    body.addColorStop(1, '#e0a412');
    g.fillStyle = body;
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? 30 : 13.5;
      const a = -Math.PI / 2 + i * Math.PI / 5;
      const x = 38 + Math.cos(a) * r, y = 39 + Math.sin(a) * r;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath(); g.fill();
    keyline(g, 2.6, 'rgba(150,96,8,0.85)');

    noShadow(g, () => {
      g.fillStyle = '#3d3527';
      g.beginPath(); g.ellipse(31, 37, 2.9, 3.6, 0, 0, TAU); g.fill();
      g.beginPath(); g.ellipse(45, 37, 2.9, 3.6, 0, 0, TAU); g.fill();
      g.fillStyle = '#fff';
      g.beginPath(); g.arc(30, 35.6, 1.1, 0, TAU); g.fill();
      g.beginPath(); g.arc(44, 35.6, 1.1, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(198,120,10,0.55)';
      g.lineWidth = 2;
      g.beginPath(); g.arc(38, 45, 6.5, 0.25, Math.PI - 0.25); g.stroke();
    });
    gloss(g, 31, 20, 7, 3.4, -0.5, 0.6);
  });

  ICONS.shield = mk((g) => {
    const orb = g.createRadialGradient(29, 29, 3, 38, 39, 31);
    orb.addColorStop(0, 'rgba(240,252,255,0.95)');
    orb.addColorStop(0.45, 'rgba(140,214,255,0.62)');
    orb.addColorStop(0.85, 'rgba(74,150,224,0.34)');
    orb.addColorStop(1, 'rgba(60,130,210,0.5)');
    g.fillStyle = orb;
    g.beginPath(); g.arc(38, 39, 30, 0, TAU); g.fill();
    g.beginPath(); g.arc(38, 39, 30, 0, TAU);
    keyline(g, 2.6, 'rgba(180,236,255,0.9)');

    noShadow(g, () => {
      // faint hex facets, so it reads as a field rather than a bubble
      g.strokeStyle = 'rgba(226,248,255,0.32)';
      g.lineWidth = 1.3;
      for (const [cx, cy] of [[38, 26], [27, 44], [49, 44]]) {
        g.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = -Math.PI / 2 + i * Math.PI / 3;
          const x = cx + Math.cos(a) * 8.5, y = cy + Math.sin(a) * 8.5;
          if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.closePath(); g.stroke();
      }
      g.strokeStyle = 'rgba(255,255,255,0.9)';
      g.lineWidth = 4;
      g.beginPath(); g.arc(38, 39, 22, -2.25, -1.15); g.stroke();
      g.globalAlpha = 0.5;
      g.lineWidth = 2.2;
      g.beginPath(); g.arc(38, 39, 26, -0.5, 0.35); g.stroke();
      g.globalAlpha = 1;
    });
  });

  ICONS.oil = mk((g) => {
    // Near-black on a dark HUD is a hole, not a slick. Lift the body and let
    // the iridescent sheen do the identifying.
    const pool = g.createRadialGradient(30, 46, 2, 38, 54, 30);
    pool.addColorStop(0, '#454b66');
    pool.addColorStop(0.55, '#282d40');
    pool.addColorStop(1, '#141722');
    g.fillStyle = pool;
    g.beginPath();
    g.moveTo(9, 53);
    g.bezierCurveTo(12, 42, 27, 40, 38, 43);
    g.bezierCurveTo(51, 40, 66, 45, 67, 55);
    g.bezierCurveTo(64, 66, 42, 70, 29, 66);
    g.bezierCurveTo(16, 64, 8, 60, 9, 53);
    g.closePath(); g.fill();
    keyline(g, 2.6, 'rgba(12,14,20,0.9)');

    noShadow(g, () => {
      // sheen: the one cue that reads "oil" rather than "pit"
      g.globalAlpha = 0.75;
      g.fillStyle = '#8ea0ff';
      g.beginPath(); g.ellipse(25, 51, 11, 4.4, -0.3, 0, TAU); g.fill();
      g.fillStyle = '#5fe0c6';
      g.beginPath(); g.ellipse(49, 58, 10, 3.8, 0.26, 0, TAU); g.fill();
      g.fillStyle = '#e07ad0';
      g.beginPath(); g.ellipse(38, 48, 7, 2.6, 0.1, 0, TAU); g.fill();
      g.globalAlpha = 0.35;
      g.fillStyle = '#ffffff';
      g.beginPath(); g.ellipse(30, 60, 8, 2.4, 0.15, 0, TAU); g.fill();
      g.globalAlpha = 1;
    });

    // the drip, bright enough to separate from the pool behind it
    const drop = g.createLinearGradient(30, 6, 46, 42);
    drop.addColorStop(0, '#7f88ad');
    drop.addColorStop(0.55, '#3c4258');
    drop.addColorStop(1, '#1b1f2c');
    g.fillStyle = drop;
    g.beginPath();
    g.moveTo(38, 6);
    g.quadraticCurveTo(54, 28, 38, 43);
    g.quadraticCurveTo(22, 28, 38, 6);
    g.closePath(); g.fill();
    keyline(g, 2.4, 'rgba(10,12,18,0.9)');
    gloss(g, 34, 21, 3, 6, -0.16, 0.75);
  });

  ICONS.emp = mk((g) => {
    noShadow(g, () => {
      const halo = g.createRadialGradient(38, 38, 4, 38, 38, 34);
      halo.addColorStop(0, 'rgba(127,208,255,0.4)');
      halo.addColorStop(1, 'rgba(127,208,255,0)');
      g.fillStyle = halo;
      g.beginPath(); g.arc(38, 38, 34, 0, TAU); g.fill();
    });

    g.strokeStyle = '#7fd0ff';
    g.lineWidth = 4;
    g.beginPath(); g.arc(38, 38, 28, 0, TAU); g.stroke();
    noShadow(g, () => {
      g.globalAlpha = 0.6;
      g.lineWidth = 2.6;
      g.beginPath(); g.arc(38, 38, 20, 0, TAU); g.stroke();
      g.globalAlpha = 0.32;
      g.lineWidth = 1.8;
      g.beginPath(); g.arc(38, 38, 12.5, 0, TAU); g.stroke();
      g.globalAlpha = 1;
    });

    const bolt = g.createLinearGradient(30, 12, 46, 64);
    bolt.addColorStop(0, '#fffbd0');
    bolt.addColorStop(0.5, '#ffe14d');
    bolt.addColorStop(1, '#f0a516');
    g.fillStyle = bolt;
    g.beginPath();
    g.moveTo(44, 11); g.lineTo(27, 41); g.lineTo(37, 41);
    g.lineTo(32, 66); g.lineTo(51, 33); g.lineTo(40, 33);
    g.closePath(); g.fill();
    keyline(g, 2.2, 'rgba(120,70,6,0.8)');
  });

  ICONS.comet = mk((g) => {
    noShadow(g, () => {
      // tail: three streaks, fattest through the middle
      const streak = (x1, y1, x2, y2, w, a) => {
        const lg = g.createLinearGradient(x1, y1, x2, y2);
        lg.addColorStop(0, 'rgba(159,216,255,0)');
        lg.addColorStop(1, 'rgba(210,240,255,' + a + ')');
        g.strokeStyle = lg;
        g.lineWidth = w;
        g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
      };
      streak(6, 6, 44, 44, 6, 0.85);
      streak(20, 4, 48, 32, 3.4, 0.5);
      streak(4, 22, 32, 50, 3.4, 0.5);

      const halo = g.createRadialGradient(48, 48, 2, 48, 48, 24);
      halo.addColorStop(0, 'rgba(255,255,255,0.95)');
      halo.addColorStop(0.35, 'rgba(159,216,255,0.6)');
      halo.addColorStop(1, 'rgba(58,120,200,0)');
      g.fillStyle = halo;
      g.beginPath(); g.arc(48, 48, 24, 0, TAU); g.fill();
    });

    const core = g.createRadialGradient(44, 44, 1, 48, 48, 15);
    core.addColorStop(0, '#ffffff');
    core.addColorStop(0.4, '#bfe6ff');
    core.addColorStop(1, '#3f86d4');
    g.fillStyle = core;
    g.beginPath(); g.arc(48, 48, 14, 0, TAU); g.fill();
    keyline(g, 2, 'rgba(20,50,90,0.65)');
    gloss(g, 43, 43, 4.4, 2.6, -0.7, 0.85);
  });

  ICONS.grapple = mk((g) => {
    // One big hook beats a hook plus a launcher plus a rope. Give the shape
    // the whole badge and keep the rope as a single readable diagonal.
    g.strokeStyle = '#a8842a';
    g.lineWidth = 7;
    g.beginPath();
    g.moveTo(12, 66); g.quadraticCurveTo(26, 56, 36, 44);
    g.stroke();
    noShadow(g, () => {
      g.strokeStyle = 'rgba(255,244,190,0.85)';
      g.lineWidth = 2.2;
      g.setLineDash([3.5, 4.5]);
      g.beginPath();
      g.moveTo(12, 66); g.quadraticCurveTo(26, 56, 36, 44);
      g.stroke();
      g.setLineDash([]);
    });

    const hook = g.createLinearGradient(28, 8, 64, 46);
    hook.addColorStop(0, '#fff6c4');
    hook.addColorStop(0.45, '#ffe14d');
    hook.addColorStop(1, '#b8830c');
    g.strokeStyle = hook;
    g.lineWidth = 9;
    g.beginPath(); g.arc(45, 27, 17, -0.5, 2.75); g.stroke();

    // barb
    g.fillStyle = '#ffe14d';
    g.beginPath();
    g.moveTo(60, 18); g.lineTo(68, 30); g.lineTo(56, 32);
    g.closePath(); g.fill();
    keyline(g, 2);

    noShadow(g, () => {
      g.strokeStyle = 'rgba(255,255,255,0.55)';
      g.lineWidth = 2.4;
      g.beginPath(); g.arc(45, 27, 17, -0.35, 0.85); g.stroke();
    });

    // eyelet where the rope meets the hook
    g.fillStyle = '#c9a63a';
    g.beginPath(); g.arc(36, 43, 5.4, 0, TAU); g.fill();
    keyline(g, 2);
    noShadow(g, () => {
      g.fillStyle = '#2b2411';
      g.beginPath(); g.arc(36, 43, 2, 0, TAU); g.fill();
    });
  });
}

const ICON_ORDER = ['mushroom', 'green', 'red', 'banana', 'star', 'shield', 'oil', 'emp', 'comet', 'grapple'];

// --- init -----------------------------------------------------------------------

export function initHUD() {
  ['hud', 'menu', 'pauseMenu', 'resultsScreen', 'loading', 'lapNum', 'raceTime',
    'posNum', 'posSuf', 'itemIcon', 'minimap', 'speedo', 'driftbar', 'driftfill',
    'centerMsg', 'lapTimeMsg', 'wrongway', 'countdown', 'mTrack', 'mClass', 'mBest',
    'resultsTitle', 'resultsSub', 'resultsTable',
  ].forEach((id) => { el[id] = $(id); });
  // device-resolution backing stores; CSS keeps every one at its layout size
  el.itemIcon.width = ICON_PX;
  el.itemIcon.height = ICON_PX;
  itemCtx = el.itemIcon.getContext('2d');

  el.minimap.width = MAP_U * HUD_DPR;
  el.minimap.height = MAP_U * HUD_DPR;
  mapCtx = el.minimap.getContext('2d');
  mapCtx.scale(HUD_DPR, HUD_DPR);

  el.speedo.width = SPD_U * HUD_DPR;
  el.speedo.height = SPD_U * HUD_DPR;
  spdCtx = el.speedo.getContext('2d');
  spdCtx.scale(HUD_DPR, HUD_DPR);
  drawIcons();
}

export function showScreen(name) {
  for (const s of ['hud', 'menu', 'charSel', 'garage', 'editorScreen', 'pauseMenu', 'resultsScreen']) {
    const node = el[s] || $(s);
    node.classList.toggle('hidden', s !== name && !(name === 'pauseMenu' && s === 'hud'));
  }
  if (name === 'pauseMenu') el.hud.classList.remove('hidden');
  // the driving controls belong to the race only — the pause menu shows the
  // HUD behind it, but must not leave a live gas pedal under the dialog
  showTouchControls(name === 'hud');
}

export function hideLoading() { el.loading.classList.add('hidden'); }
export function setLoading(on) { el.loading.classList.toggle('hidden', !on); }

// --- menu -----------------------------------------------------------------------

export function updateMenu(sel) {
  document.querySelectorAll('#menuRows .menuRow').forEach((row) => {
    row.classList.toggle('sel', parseInt(row.dataset.row, 10) === sel);
  });
  $('mMode').textContent = MODES[G.mode];
  const tdef = getTrackDef(G.trackIndex);
  el.mTrack.textContent = G.mode === 1 ? 'Rush Cup — all 5 tracks' : tdef.name;
  document.querySelector('.menuRow[data-row="1"]').classList.toggle('dim', G.mode === 1);
  el.mClass.textContent = curClass().name;
  $('mGarage').textContent = '🪙 ' + Garage.coins + '  ·  customize kart';
  $('mStart').textContent = ['START RACE', 'START CUP', 'START TIME TRIAL'][G.mode];
  const best = getBestForDef(tdef);
  el.mBest.textContent = G.mode === 1 ? '5 races · points decide the champion'
    : 'Best lap  ' + (best ? fmtTime(best) : '—');
}

// --- garage ---------------------------------------------------------------------

const PART_KEYS = ['engine', 'tires', 'spoiler'];

export function renderGarage(sel) {
  $('gCoins').textContent = '🪙 ' + Garage.coins;
  const rows = [];
  PART_KEYS.forEach((key, ri) => {
    const part = PARTS[key];
    const cells = part.tiers.map((tname, ti) => {
      const owned = Garage.owned[key][ti];
      const equipped = Garage.equipped[key] === ti;
      const selHere = sel.row === ri && sel.col === ti;
      const cls = 'gTier' + (owned ? ' owned' : ' locked') +
        (equipped ? ' equipped' : '') + (selHere ? ' sel' : '');
      const cost = owned ? (equipped ? 'EQUIPPED' : 'owned') : '🪙 ' + part.cost[ti];
      return '<div class="' + cls + '" data-row="' + ri + '" data-col="' + ti + '">' +
        tname + '<span class="cost">' + cost + '</span></div>';
    }).join('');
    rows.push('<div class="gRow"><span class="gLabel">' + part.label + '</span>' + cells + '</div>');
  });
  const swatches = PAINTS.map((p, pi) => {
    const equipped = (p === -1 && Garage.paint === -1) || (p !== -1 && Garage.paint === p);
    const selHere = sel.row === 3 && sel.col === pi;
    const cls = 'gSwatch' + (p === -1 ? ' auto' : '') +
      (equipped ? ' equipped' : '') + (selHere ? ' sel' : '');
    const style = p === -1 ? '' : ' style="background:#' + p.toString(16).padStart(6, '0') + '"';
    return '<div class="' + cls + '" data-row="3" data-col="' + pi + '"' + style + '></div>';
  }).join('');
  rows.push('<div class="gRow"><span class="gLabel">PAINT</span>' + swatches + '</div>');
  $('gRows').innerHTML = rows.join('');
}

export function bindGarageClicks(onCell) {
  $('gRows').addEventListener('click', (e) => {
    const cell = e.target.closest('[data-row]');
    if (!cell) return;
    onCell(parseInt(cell.dataset.row, 10), parseInt(cell.dataset.col, 10));
  });
}

export function garageColCount(row) {
  return row === 3 ? PAINTS.length : 3;
}

export function bindMenuClicks(onRow, onArrow) {
  // scoped to #menuRows: #charGo also carries .menuRow but has no data-row
  document.querySelectorAll('#menuRows .menuRow').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.classList.contains('arrow')) return;
      onRow(parseInt(row.dataset.row, 10));
    });
  });
  document.querySelectorAll('#menuRows .menuRow .arrow').forEach((ar) => {
    ar.addEventListener('click', () => {
      onArrow(parseInt(ar.closest('.menuRow').dataset.row, 10), parseInt(ar.dataset.dir, 10));
    });
  });
}

export function bindScreenButtons({ onBack, onResultsAgain, onResultsMenu, onPodiumDone }) {
  for (const id of ['charBack', 'garageBack', 'edBack']) {
    $(id).addEventListener('click', () => onBack(id));
  }
  $('resAgain').addEventListener('click', () => onResultsAgain());
  $('resMenu').addEventListener('click', () => onResultsMenu());
  $('podiumDone').addEventListener('click', () => onPodiumDone());
}

export function bindPauseClicks(onRow) {
  document.querySelectorAll('.pauseRow').forEach((row) => {
    row.addEventListener('click', () => onRow(parseInt(row.dataset.row, 10)));
  });
}

export function updatePause(sel) {
  document.querySelectorAll('.pauseRow').forEach((row) => {
    row.classList.toggle('sel', parseInt(row.dataset.row, 10) === sel);
  });
}

// --- character select --------------------------------------------------------------

const statRange = (key) => {
  const vals = CHARACTERS.map((c) => charStats(c)[key]);
  return [Math.min(...vals), Math.max(...vals)];
};

export function updateCharSel() {
  const c = CHARACTERS[G.playerChar];
  const s = charStats(c);
  $('charName').textContent = c.name;
  $('charTag').textContent = c.tag;
  const setBar = (id, key, invert) => {
    const [lo, hi] = statRange(key);
    let t = hi === lo ? 0.5 : (s[key] - lo) / (hi - lo);
    if (invert) t = 1 - t;
    $(id).style.width = (18 + t * 82) + '%';
  };
  setBar('stSpeed', 'top', false);
  setBar('stAccel', 'accel', false);
  setBar('stSteer', 'steer', false);
  setBar('stMass', 'accel', true);        // weight reads as the inverse of accel
}

export function bindCharSelClicks(onDir, onConfirm) {
  $('charPrev').addEventListener('click', () => onDir(-1));
  $('charNext').addEventListener('click', () => onDir(1));
  $('charGo').addEventListener('click', () => onConfirm());
}

// --- countdown --------------------------------------------------------------------

export function setCountdown(text) {
  if (text === lastCountdownText) return;
  lastCountdownText = text;
  const c = el.countdown;
  if (!text) { c.classList.add('hidden'); return; }
  c.classList.remove('hidden');
  c.textContent = text;
  c.classList.toggle('go', text === 'GO!');
  c.classList.remove('pop');
  void c.offsetWidth;              // restart the pop animation
  c.classList.add('pop');
}

// --- per-frame HUD ------------------------------------------------------------------

const _last = { lap: '', pos: 0, msg: '' };

export function updateHUD() {
  const p = G.racers[0];
  const track = G.track;
  if (!p || !track) return;

  const lapText = Math.min(p.lap, track.laps) + '/' + track.laps;
  if (_last.lap !== lapText) {
    _last.lap = lapText;
    el.lapNum.textContent = lapText;
  }
  el.raceTime.textContent = fmtTime(G.time);

  if (_last.coins !== Garage.coins) {
    _last.coins = Garage.coins;
    $('coinCount').textContent = Garage.coins;
  }

  if (_last.pos !== p.place) {
    _last.pos = p.place;
    el.posNum.textContent = p.place;
    el.posNum.classList.toggle('first', p.place === 1);
    el.posSuf.textContent = suffix(p.place);
    const pp = $('posPanel');
    pp.classList.remove('pop');
    void pp.offsetWidth;
    pp.classList.add('pop');
  }

  // item slot
  itemCtx.clearRect(0, 0, ICON_PX, ICON_PX);
  if (p.itemRoll > 0) {
    itemCtx.globalAlpha = 0.9;
    itemCtx.drawImage(ICONS[ICON_ORDER[Math.floor(p.rollIcon) % ICON_ORDER.length]], 0, 0);
    itemCtx.globalAlpha = 1;
    _last.rolling = true;
  } else if (p.item) {
    itemCtx.drawImage(ICONS[p.item], 0, 0);
    if (_last.rolling) {
      _last.rolling = false;
      const slot = $('itemSlot');
      slot.classList.remove('pop');
      void slot.offsetWidth;
      slot.classList.add('pop');
    }
  }

  // minimap
  mapCtx.clearRect(0, 0, MAP_U, MAP_U);
  mapCtx.drawImage(track.minimap, 0, 0, MAP_U, MAP_U);
  for (let i = G.racers.length - 1; i >= 0; i--) {
    const r = G.racers[i];
    const [mx, my] = track.worldToMap(r.x, r.z);
    mapCtx.fillStyle = '#' + CHARACTERS[r.charIdx].palette.body.toString(16).padStart(6, '0');
    mapCtx.beginPath();
    mapCtx.arc(mx, my, r.isPlayer ? 6.5 : 5, 0, TAU);
    mapCtx.fill();
    mapCtx.lineWidth = r.isPlayer ? 2.5 : 1.5;
    mapCtx.strokeStyle = r.isPlayer ? '#fff' : 'rgba(0,0,0,0.65)';
    mapCtx.stroke();
  }

  // speedometer
  const S = SPD_U, cx = S / 2, cy = S / 2 + 6, rad = 58;
  spdCtx.clearRect(0, 0, S, S);
  spdCtx.fillStyle = 'rgba(8,10,22,0.55)';
  spdCtx.beginPath();
  spdCtx.arc(cx, cy, rad + 14, 0, TAU);
  spdCtx.fill();
  spdCtx.lineWidth = 9;
  spdCtx.lineCap = 'round';
  spdCtx.strokeStyle = 'rgba(255,255,255,0.18)';
  spdCtx.beginPath();
  spdCtx.arc(cx, cy, rad, Math.PI * 0.75, Math.PI * 2.25);
  spdCtx.stroke();
  const sr = clamp(Math.abs(p.speed) / (G.tune.topSpeed * 1.55), 0, 1);
  spdCtx.strokeStyle = p.boost > 0 ? '#ff8a2b' : '#5bd5ff';
  spdCtx.beginPath();
  spdCtx.arc(cx, cy, rad, Math.PI * 0.75, Math.PI * (0.75 + sr * 1.5));
  spdCtx.stroke();
  spdCtx.fillStyle = '#fff';
  spdCtx.font = '800 30px "Avenir Next", Helvetica, sans-serif';
  spdCtx.textAlign = 'center';
  spdCtx.fillText(String(Math.round(Math.abs(p.speed) * 2.2)), cx, cy + 10);
  spdCtx.fillStyle = 'rgba(255,255,255,0.6)';
  spdCtx.font = '700 12px "Avenir Next", Helvetica, sans-serif';
  spdCtx.fillText('KPH', cx, cy + 28);

  // drift bar
  const driftOn = p.drift !== 0;
  el.driftbar.classList.toggle('on', driftOn);
  if (driftOn) {
    // the mini-turbo thresholds are class-scaled, so the bar has to read them
    // off the tune or it fills against the wrong target
    const t1 = G.tune.driftT1, t2 = G.tune.driftT2;
    const c = clamp(p.driftCharge / t2, 0, 1);
    el.driftfill.style.width = (c * 100) + '%';
    el.driftfill.style.background =
      p.driftCharge >= t2 ? '#ff8a2b' : (p.driftCharge >= t1 ? '#5bd5ff' : '#ffffff');
  }

  // messages
  el.centerMsg.style.opacity = (G.msgTime > 0 && G.msg) ? String(clamp(G.msgTime, 0, 1)) : '0';
  if (G.msg && _last.msg !== G.msg) {
    _last.msg = G.msg;
    el.centerMsg.textContent = G.msg;
  }

  if (p.lastLap != null && G.time - p.lapStart < 2.5 && p.lap > 1 && !p.finished) {
    el.lapTimeMsg.style.opacity = '1';
    el.lapTimeMsg.textContent = 'LAP ' + (p.lap - 1) + '   ' + fmtTime(p.lastLap) +
      (p.bestLap === p.lastLap ? '  ★' : '');
    el.lapTimeMsg.style.color = p.bestLap === p.lastLap ? '#5bd5ff' : '#fff';
  } else {
    el.lapTimeMsg.style.opacity = '0';
  }

  // the slot lights up while something is actually loaded, so a glance at the
  // edge of the screen tells you whether you have a weapon
  const armed = !!p.item && p.itemRoll <= 0;
  if (_last.armed !== armed) {
    _last.armed = armed;
    $('itemSlot').classList.toggle('ready', armed);
  }

  el.wrongway.classList.toggle('hidden', !p.wrongWay);
}

// --- results --------------------------------------------------------------------------

export function renderCupStandings(targetId) {
  const gp = G.gp;
  const box = $(targetId);
  if (!gp) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const order = gp.points
    .map((pts, id) => ({ pts, id }))
    .sort((a, b) => b.pts - a.pts);
  box.innerHTML = order.map((e, i) => {
    const charIdx = gp.cast[e.id];
    const col = '#' + CHARACTERS[charIdx].palette.body.toString(16).padStart(6, '0');
    return '<div class="standChip' + (i === 0 ? ' leader' : '') + '">' +
      '<span class="chip" style="background:' + col + ';width:14px;height:14px;border-radius:4px"></span>' +
      CHARACTERS[charIdx].name + (e.id === 0 ? ' (you)' : '') +
      ' <span class="pts">' + e.pts + '</span></div>';
  }).join('');
}

export function showPodium() {
  const gp = G.gp;
  const order = gp.points.map((pts, id) => ({ pts, id })).sort((a, b) => b.pts - a.pts);
  const champIdx = gp.cast[order[0].id];
  $('podiumTitle').textContent = 'RUSH CUP ' + (order[0].id === 0 ? 'CHAMPION!' : 'RESULTS');
  $('podiumName').textContent = CHARACTERS[champIdx].name + (order[0].id === 0 ? ' — YOU!' : '');
  renderCupStandings('podiumTable');
  $('podiumTable').classList.remove('hidden');
  for (const s of ['hud', 'menu', 'charSel', 'garage', 'pauseMenu', 'resultsScreen']) {
    $(s).classList.add('hidden');
  }
  $('podiumScreen').classList.remove('hidden');
  return order.slice(0, 3).map((e) => gp.cast[e.id]);   // top-3 character indices
}

export function hidePodium() { $('podiumScreen').classList.add('hidden'); }

export function showResults() {
  const me = G.racers[0];
  if (G.mode === 2) {
    el.resultsTitle.textContent = G.newGhost ? 'NEW RECORD!' : 'TIME TRIAL DONE';
    el.resultsSub.textContent =
      G.track.def.name + '  ·  total ' + fmtTime(me.finishTime) +
      (G.ghostBest && !G.newGhost ? '  ·  ghost ' + fmtTime(G.ghostBest.total) : '') +
      (G.newGhost ? '  ·  ghost saved' : '');
  } else {
    el.resultsTitle.textContent =
      me.place === 1 ? 'YOU WIN!' : (me.place <= 3 ? 'PODIUM!' : 'FINISHED');
    el.resultsSub.textContent =
      G.track.def.name + '  ·  ' + curClass().name +
      '  ·  earned 🪙 ' + ((G.lastPayout || 0) + (G.coinsThisRace || 0)) +
      ' (wallet ' + Garage.coins + ')';
  }
  // points are awarded before this renders, so gp.race is already incremented
  if (G.mode === 1 && G.gp) {
    const last = G.gp.race >= 5;
    $('resultsHelp').innerHTML = last
      ? '<b>Enter</b> — podium ceremony'
      : '<b>Enter</b> — next race (' + (G.gp.race + 1) + '/5) · <b>Esc</b> abandon cup';
    $('resAgain').textContent = last ? 'PODIUM' : 'NEXT RACE (' + (G.gp.race + 1) + '/5)';
    $('resMenu').textContent = 'ABANDON CUP';
  } else {
    $('resultsHelp').innerHTML = '<b>Enter</b> race again · <b>Esc</b> menu';
    $('resAgain').textContent = 'RACE AGAIN';
    $('resMenu').textContent = 'MENU';
  }
  renderCupStandings('cupStandings');
  el.resultsTable.innerHTML = '';
  G.results.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'resRow' + (r.isPlayer ? ' me' : '');
    row.style.animationDelay = (i * 0.07) + 's';
    const fin = r.finishTime != null ? fmtTime(r.finishTime)
      : (r.projected != null ? '+' + (r.projected - G.time).toFixed(1) + 's' : '—');
    row.innerHTML =
      '<span class="place">' + ordinal(i + 1) + '</span>' +
      '<span class="chip" style="background:#' + CHARACTERS[r.charIdx].palette.body.toString(16).padStart(6, '0') + '"></span>' +
      '<span class="name">' + r.name + (r.id === G.rivalId ? ' ⚔' : '') + (r.isPlayer ? ' (you)' : '') + '</span>' +
      '<span class="best">' + (r.bestLap != null ? 'best ' + fmtTime(r.bestLap) : '') + '</span>' +
      '<span class="total">' + fin + '</span>';
    el.resultsTable.appendChild(row);
  });
}
