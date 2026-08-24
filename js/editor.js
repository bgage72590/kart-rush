// ---------------------------------------------------------------------------
// Track Lab canvas: draggable control points over a live road preview.
// The def's points are normalized [0..1]²; the builder does the rest.
// ---------------------------------------------------------------------------
import { CFG } from './config.js';
import { TAU, clamp } from './util.js';

function catmull2(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  const f = (a, b, c, d) =>
    0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])];
}

export class TrackEditor {
  constructor(canvas, onChange) {
    this.cv = canvas;
    this.g = canvas.getContext('2d');
    this.onChange = onChange;
    this.def = null;
    this.dragIdx = -1;
    this.hoverIdx = -1;

    canvas.addEventListener('pointerdown', (e) => this._down(e));
    canvas.addEventListener('pointermove', (e) => this._move(e));
    addEventListener('pointerup', () => this._up());
    addEventListener('pointercancel', () => this._up());
    canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); this._up(); });
    canvas.addEventListener('dblclick', (e) => this._dbl(e));
  }

  setDef(def) {
    this.def = def;
    this.render();
  }

  _pos(e) {
    const r = this.cv.getBoundingClientRect();
    return [
      (e.clientX - r.left) / r.width,
      (e.clientY - r.top) / r.height,
    ];
  }

  _nearest(p) {
    let best = -1, bestD = Infinity;
    this.def.points.forEach((q, i) => {
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < bestD) { bestD = d; best = i; }
    });
    return { i: best, d: bestD };
  }

  _down(e) {
    if (!this.def || e.button !== 0) return;      // left button only
    const p = this._pos(e);
    const n = this._nearest(p);
    if (n.d < 0.045) {
      this.dragIdx = n.i;
      this.cv.setPointerCapture(e.pointerId);
    }
  }

  _move(e) {
    if (!this.def) return;
    const p = this._pos(e);
    if (this.dragIdx >= 0) {
      this.def.points[this.dragIdx] = [clamp(p[0], 0.05, 0.95), clamp(p[1], 0.05, 0.95)];
      this.render();
    } else {
      const n = this._nearest(p);
      const h = n.d < 0.045 ? n.i : -1;
      if (h !== this.hoverIdx) { this.hoverIdx = h; this.render(); }
      this.cv.style.cursor = h >= 0 ? 'grab' : 'crosshair';
    }
  }

  _up() {
    if (this.dragIdx >= 0) {
      this.dragIdx = -1;
      if (this.onChange) this.onChange();
    }
  }

  _dbl(e) {
    if (!this.def) return;
    const p = this._pos(e);
    const n = this._nearest(p);
    const pts = this.def.points;
    if (n.d < 0.045) {
      // on a point: remove it, unless we're at the minimum viable loop
      if (pts.length > 8) pts.splice(n.i, 1);
    } else if (pts.length < 24) {
      // insert on the chord closest to the click
      let bi = 0, bd = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        const d = Math.hypot(mx - p[0], my - p[1]);
        if (d < bd) { bd = d; bi = i; }
      }
      const a = pts[bi], b = pts[(bi + 1) % pts.length];
      pts.splice(bi + 1, 0, [
        clamp((a[0] + b[0]) / 2, 0.05, 0.95),
        clamp((a[1] + b[1]) / 2, 0.05, 0.95),
      ]);
    }
    this.render();
    if (this.onChange) this.onChange();
  }

  render() {
    if (!this.def) return;
    const g = this.g;
    const W = this.cv.width, H = this.cv.height;
    const pts = this.def.points;
    const n = pts.length;

    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(10, 12, 24, 0.88)';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(255,255,255,0.06)';
    g.lineWidth = 1;
    for (let i = 1; i < 10; i++) {
      g.beginPath(); g.moveTo(W * i / 10, 0); g.lineTo(W * i / 10, H); g.stroke();
      g.beginPath(); g.moveTo(0, H * i / 10); g.lineTo(W, H * i / 10); g.stroke();
    }

    // spline samples
    const samp = [];
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      for (let s = 0; s < 10; s++) samp.push(catmull2(p0, p1, p2, p3, s / 10));
    }

    const roadPx = (CFG.roadWidth / CFG.worldScale) * W;
    const path = () => {
      g.beginPath();
      samp.forEach((q, i) => {
        if (i === 0) g.moveTo(q[0] * W, q[1] * H);
        else g.lineTo(q[0] * W, q[1] * H);
      });
      g.closePath();
    };
    g.lineJoin = g.lineCap = 'round';
    g.strokeStyle = 'rgba(226,60,52,0.85)';
    g.lineWidth = roadPx + 7;
    path(); g.stroke();
    g.strokeStyle = '#4c4c58';
    g.lineWidth = roadPx;
    path(); g.stroke();
    g.strokeStyle = 'rgba(255,215,80,0.75)';
    g.lineWidth = 2;
    g.setLineDash([9, 9]);
    path(); g.stroke();
    g.setLineDash([]);

    // direction arrow at the start
    const s0 = samp[0], s1 = samp[3];
    const ang = Math.atan2(s1[1] - s0[1], s1[0] - s0[0]);
    g.save();
    g.translate(s0[0] * W, s0[1] * H);
    g.rotate(ang);
    g.fillStyle = '#7bff8a';
    g.beginPath();
    g.moveTo(18, 0); g.lineTo(2, -9); g.lineTo(2, 9);
    g.closePath(); g.fill();
    g.restore();

    // control points
    pts.forEach((q, i) => {
      const x = q[0] * W, y = q[1] * H;
      g.beginPath();
      g.arc(x, y, i === this.hoverIdx || i === this.dragIdx ? 11 : 8, 0, TAU);
      g.fillStyle = i === 0 ? '#ffd94d' : (i === this.dragIdx ? '#ffffff' : 'rgba(255,255,255,0.88)');
      g.fill();
      g.lineWidth = 2.5;
      g.strokeStyle = 'rgba(0,0,0,0.65)';
      g.stroke();
    });
  }
}
