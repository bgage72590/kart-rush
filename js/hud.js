// ---------------------------------------------------------------------------
// DOM HUD: lap/time/position panels, item slot, minimap, speedometer,
// menus, pause and results screens.
// ---------------------------------------------------------------------------
import { CFG, TRACK_DEFS, DIFFICULTIES, CHARACTERS, charStats, MODES } from './config.js';
import { clamp, fmtTime, ordinal, suffix, TAU, makeCanvas } from './util.js';
import { G, getBestForDef } from './race.js';
import { Garage, PARTS, PAINTS } from './garage.js';
import { getTrackDef } from './tracklab.js';

const $ = (id) => document.getElementById(id);

const el = {};
let itemCtx = null, mapCtx = null, spdCtx = null;
let lastCountdownText = '';

// --- item icons (drawn once) --------------------------------------------------

const ICONS = {};
function drawIcons() {
  const mk = (fn) => {
    const c = makeCanvas(76, 76);
    fn(c.getContext('2d'));
    return c;
  };
  ICONS.mushroom = mk((g) => {
    g.fillStyle = '#f7ead0'; g.fillRect(28, 40, 20, 26);
    g.fillStyle = '#e8443c';
    g.beginPath(); g.arc(38, 40, 26, Math.PI, TAU); g.fill();
    g.fillStyle = '#fff';
    g.beginPath(); g.arc(28, 28, 7, 0, TAU); g.fill();
    g.beginPath(); g.arc(48, 31, 6, 0, TAU); g.fill();
  });
  ICONS.banana = mk((g) => {
    g.fillStyle = '#f2d23d';
    g.beginPath();
    g.moveTo(12, 52);
    g.quadraticCurveTo(38, 8, 64, 52);
    g.quadraticCurveTo(38, 36, 12, 52);
    g.closePath(); g.fill();
    g.strokeStyle = '#a8871a'; g.lineWidth = 3; g.stroke();
    g.fillStyle = '#6b5410'; g.fillRect(60, 38, 7, 12);
  });
  const shell = (color) => (g) => {
    g.fillStyle = '#f6efdc';
    g.beginPath(); g.ellipse(38, 54, 28, 13, 0, 0, TAU); g.fill();
    const grad = g.createRadialGradient(30, 26, 4, 38, 38, 32);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.25, color);
    grad.addColorStop(1, color);
    g.fillStyle = grad;
    g.beginPath(); g.arc(38, 38, 28, Math.PI, TAU); g.fill();
    g.fillStyle = '#f6efdc'; g.fillRect(10, 36, 56, 8);
    g.strokeStyle = 'rgba(0,0,0,0.4)'; g.lineWidth = 3;
    g.beginPath(); g.arc(38, 38, 28, Math.PI, TAU); g.stroke();
  };
  ICONS.green = mk(shell('#3fa84f'));
  ICONS.red = mk(shell('#d63b34'));
  ICONS.star = mk((g) => {
    g.fillStyle = '#ffe14d';
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? 30 : 13;
      const a = -Math.PI / 2 + i * Math.PI / 5;
      const x = 38 + Math.cos(a) * r, y = 40 + Math.sin(a) * r;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath(); g.fill();
    g.strokeStyle = '#c99a15'; g.lineWidth = 3; g.stroke();
    g.fillStyle = '#3d3527';
    g.beginPath(); g.arc(31, 38, 2.6, 0, TAU); g.fill();
    g.beginPath(); g.arc(45, 38, 2.6, 0, TAU); g.fill();
  });
  ICONS.shield = mk((g) => {
    const grad = g.createRadialGradient(30, 30, 4, 38, 38, 30);
    grad.addColorStop(0, 'rgba(220,245,255,0.95)');
    grad.addColorStop(0.6, 'rgba(127,208,255,0.55)');
    grad.addColorStop(1, 'rgba(80,150,220,0.25)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(38, 38, 29, 0, TAU); g.fill();
    g.strokeStyle = '#bfe8ff'; g.lineWidth = 3;
    g.beginPath(); g.arc(38, 38, 29, 0, TAU); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 4;
    g.beginPath(); g.arc(38, 38, 21, -2.2, -1.1); g.stroke();
  });
  ICONS.oil = mk((g) => {
    g.fillStyle = '#1a1c26';
    g.beginPath(); g.ellipse(38, 52, 26, 12, 0, 0, TAU); g.fill();
    g.beginPath();
    g.moveTo(38, 8);
    g.quadraticCurveTo(54, 34, 38, 46);
    g.quadraticCurveTo(22, 34, 38, 8);
    g.fill();
    g.fillStyle = 'rgba(140,160,255,0.5)';
    g.beginPath(); g.ellipse(30, 50, 8, 3.5, -0.4, 0, TAU); g.fill();
  });
  ICONS.emp = mk((g) => {
    g.strokeStyle = '#7fd0ff'; g.lineWidth = 4;
    g.beginPath(); g.arc(38, 38, 27, 0, TAU); g.stroke();
    g.globalAlpha = 0.5;
    g.beginPath(); g.arc(38, 38, 18, 0, TAU); g.stroke();
    g.globalAlpha = 1;
    g.fillStyle = '#ffe14d';
    g.beginPath();
    g.moveTo(43, 12); g.lineTo(28, 40); g.lineTo(38, 40);
    g.lineTo(33, 64); g.lineTo(50, 34); g.lineTo(39, 34);
    g.closePath(); g.fill();
  });
  ICONS.comet = mk((g) => {
    g.strokeStyle = 'rgba(159,216,255,0.7)'; g.lineWidth = 5; g.lineCap = 'round';
    g.beginPath(); g.moveTo(12, 12); g.lineTo(40, 40); g.stroke();
    g.lineWidth = 3; g.globalAlpha = 0.5;
    g.beginPath(); g.moveTo(24, 8); g.lineTo(44, 28); g.stroke();
    g.beginPath(); g.moveTo(8, 26); g.lineTo(30, 46); g.stroke();
    g.globalAlpha = 1;
    const grad = g.createRadialGradient(46, 46, 2, 48, 48, 18);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.5, '#9fd8ff');
    grad.addColorStop(1, '#3a78c8');
    g.fillStyle = grad;
    g.beginPath(); g.arc(48, 48, 17, 0, TAU); g.fill();
  });
  ICONS.grapple = mk((g) => {
    g.strokeStyle = '#ffe14d'; g.lineWidth = 5; g.lineCap = 'round';
    g.beginPath(); g.moveTo(14, 62); g.lineTo(44, 30); g.stroke();
    g.lineWidth = 6;
    g.beginPath(); g.arc(48, 24, 12, -0.6, 2.6); g.stroke();
    g.fillStyle = '#ffe14d';
    g.beginPath(); g.arc(59, 31, 4.5, 0, TAU); g.fill();
    g.fillStyle = '#8b93a4';
    g.fillRect(8, 56, 14, 12);
  });
}
const ICON_ORDER = ['mushroom', 'green', 'red', 'banana', 'star', 'shield', 'oil', 'emp', 'comet', 'grapple'];

// --- init -----------------------------------------------------------------------

export function initHUD() {
  ['hud', 'menu', 'pauseMenu', 'resultsScreen', 'loading', 'lapNum', 'raceTime',
    'posNum', 'posSuf', 'itemIcon', 'minimap', 'speedo', 'driftbar', 'driftfill',
    'centerMsg', 'lapTimeMsg', 'wrongway', 'countdown', 'mTrack', 'mDiff', 'mBest',
    'resultsTitle', 'resultsSub', 'resultsTable',
  ].forEach((id) => { el[id] = $(id); });
  itemCtx = el.itemIcon.getContext('2d');
  mapCtx = el.minimap.getContext('2d');
  spdCtx = el.speedo.getContext('2d');
  drawIcons();
}

export function showScreen(name) {
  for (const s of ['hud', 'menu', 'charSel', 'garage', 'editorScreen', 'pauseMenu', 'resultsScreen']) {
    const node = el[s] || $(s);
    node.classList.toggle('hidden', s !== name && !(name === 'pauseMenu' && s === 'hud'));
  }
  if (name === 'pauseMenu') el.hud.classList.remove('hidden');
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
  document.querySelector('.menuRow[data-row="2"]').classList.toggle('dim', G.mode === 2);
  el.mDiff.textContent = DIFFICULTIES[G.difficulty].name;
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
  itemCtx.clearRect(0, 0, 76, 76);
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
  mapCtx.clearRect(0, 0, 180, 180);
  mapCtx.drawImage(track.minimap, 0, 0);
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
  const S = 160, cx = S / 2, cy = S / 2 + 6, rad = 58;
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
  const sr = clamp(Math.abs(p.speed) / (CFG.topSpeed * 1.55), 0, 1);
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
    const c = clamp(p.driftCharge / CFG.driftT2, 0, 1);
    el.driftfill.style.width = (c * 100) + '%';
    el.driftfill.style.background =
      p.driftCharge >= CFG.driftT2 ? '#ff8a2b' : (p.driftCharge >= CFG.driftT1 ? '#5bd5ff' : '#ffffff');
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
      G.track.def.name + '  ·  ' + DIFFICULTIES[G.difficulty].name +
      '  ·  earned 🪙 ' + ((G.lastPayout || 0) + (G.coinsThisRace || 0)) +
      ' (wallet ' + Garage.coins + ')';
  }
  // points are awarded before this renders, so gp.race is already incremented
  if (G.mode === 1 && G.gp) {
    const last = G.gp.race >= 5;
    $('resultsHelp').innerHTML = last
      ? '<b>Enter</b> — podium ceremony'
      : '<b>Enter</b> — next race (' + (G.gp.race + 1) + '/5) · <b>Esc</b> abandon cup';
  } else {
    $('resultsHelp').innerHTML = '<b>Enter</b> race again · <b>Esc</b> menu';
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
