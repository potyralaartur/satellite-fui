// The hero: a hand-rolled pinhole camera over the orbital shell, drawn in Canvas 2D.
// Positions are ECI (TEME, km). Earth's surface is rotated into ECI by GMST each frame, so
// orbits stay put and the planet turns under them.

import { gstime } from 'satellite.js';
import { EARTH_R } from './data.js';
import { eciAt, sunEciKm } from './orbit.js';

const DEG = Math.PI / 180;
const TRACK_SAMPLES = 160;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  const rgb = name => cs.getPropertyValue(`--p-${name}-rgb`).trim() || '255,255,255';
  return Object.fromEntries(['text', 'pay', 'rb', 'deb', 'station', 'hot', 'warn', 'land', 'night', 'sun', 'observer']
    .map(k => [k, rgb(k)]));
}

export class Scene {
  constructor(canvas, world, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = world;
    this.opts = opts; // { getTime, getObserver, onSelect, reducedMotion }
    this.pal = readPalette();
    this.leaders = world.objects.filter(o => o.leader === o);
    this.cam = { yaw: -60 * DEG, pitch: 22 * DEG, view: 30000, targetView: 30000 };
    this.selected = null;
    this.conj = null; // { a, b, tca, label }
    this.tracks = new Map(); // id -> { t0, pts: Float64Array }
    this.cursor = 0;
    this.lastInput = 0;
    this.screen = new Float32Array(this.leaders.length * 2).fill(NaN);
    this.lastPropT = new Float64Array(this.leaders.length).fill(NaN);
    this.vel = new Array(this.leaders.length);
    this.resize();
    this.bindInput();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  // ---------- setup ----------

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(1, r.width); this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  bindInput() {
    const c = this.canvas;
    const ptrs = new Map();
    let drag = null, pinch = null, moved = 0;
    c.addEventListener('pointerdown', e => {
      c.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved = 0;
      if (ptrs.size === 1) drag = { x: e.clientX, y: e.clientY };
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), view: this.cam.targetView };
        drag = null;
      }
    });
    c.addEventListener('pointermove', e => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.lastInput = performance.now();
      if (pinch && ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        this.zoomTo(pinch.view * pinch.d / Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), true);
        moved += 10;
      } else if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        moved += Math.abs(dx) + Math.abs(dy);
        this.cam.yaw -= dx * 0.005;
        this.cam.pitch = Math.max(-85 * DEG, Math.min(85 * DEG, this.cam.pitch + dy * 0.005));
        drag = { x: e.clientX, y: e.clientY };
      }
    });
    const up = e => {
      if (ptrs.size === 1 && moved < 6 && drag) this.pick(e.clientX, e.clientY);
      ptrs.delete(e.pointerId);
      if (ptrs.size < 2) pinch = null;
      if (!ptrs.size) drag = null;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', e => { ptrs.delete(e.pointerId); drag = pinch = null; });
    c.addEventListener('wheel', e => {
      e.preventDefault();
      this.lastInput = performance.now();
      this.zoomTo(this.cam.targetView * Math.exp(e.deltaY * 0.0015), true);
    }, { passive: false });
    c.addEventListener('keydown', e => {
      const k = { ArrowLeft: [0.1, 0], ArrowRight: [-0.1, 0], ArrowUp: [0, 0.08], ArrowDown: [0, -0.08] }[e.key];
      if (k) { this.cam.yaw += k[0]; this.cam.pitch = Math.max(-1.4, Math.min(1.4, this.cam.pitch + k[1])); e.preventDefault(); }
      if (e.key === '+' || e.key === '=') this.zoomTo(this.cam.targetView / 1.3, true);
      if (e.key === '-') this.zoomTo(this.cam.targetView * 1.3, true);
    });
  }

  zoomTo(view, immediate = false) {
    this.cam.targetView = Math.max(7600, Math.min(60000, view));
    if (immediate) this.cam.view = this.cam.targetView;
  }

  select(o) {
    this.selected = o?.leader ?? null;
    if (this.selected) this.zoomTo(Math.max(9500, (this.selected.apogee + EARTH_R) * 1.45));
  }

  setConjunction(c) {
    this.conj = c;
    if (c) {
      this.tracks.delete(`tca:${c.a.id}`); this.tracks.delete(`tca:${c.b.id}`);
      this.zoomTo(Math.max(9500, (Math.max(c.a.apogee, c.b.apogee) + EARTH_R) * 1.5));
    }
  }

  // ---------- camera ----------

  camera() {
    const { yaw, pitch, view } = this.cam;
    const dist = view * 3.2;
    const pos = [dist * Math.cos(pitch) * Math.cos(yaw), dist * Math.cos(pitch) * Math.sin(yaw), dist * Math.sin(pitch)];
    const f = norm([-pos[0], -pos[1], -pos[2]]);
    const r = norm(cross(f, [0, 0, 1]));
    const u = cross(r, f);
    const half = Math.min(this.w, this.h) / 2;
    const focal = half * 0.94 * dist / view;
    return { pos, f, r, u, focal, dist, cx: this.w / 2, cy: this.h / 2 };
  }

  // Returns [sx, sy, depth] or null when behind the camera.
  project(cam, p) {
    const d = sub(p, cam.pos);
    const z = dot(d, cam.f);
    if (z <= 1) return null;
    return [cam.cx + cam.focal * dot(d, cam.r) / z, cam.cy - cam.focal * dot(d, cam.u) / z, z];
  }

  // True when Earth blocks the line from the camera to p.
  occluded(cam, p) {
    const d = sub(p, cam.pos);
    const dd = dot(d, d);
    const t = -dot(cam.pos, d) / dd;
    if (t <= 0 || t >= 1) return false;
    const q = [cam.pos[0] + t * d[0], cam.pos[1] + t * d[1], cam.pos[2] + t * d[2]];
    return dot(q, q) < EARTH_R * EARTH_R;
  }

  // ---------- simulation ----------

  // Propagates a slice of the catalog per frame and extrapolates the rest linearly from their
  // last state, so the whole shell moves smoothly without propagating 10k objects every frame.
  propagateSlice(date, warp) {
    const n = this.leaders.length;
    const budget = warp >= 300 ? n : Math.max(1500, Math.ceil(n / (warp >= 30 ? 3 : 8)));
    const t = date.getTime();
    for (let k = 0; k < Math.min(budget, n); k++) {
      const i = (this.cursor + k) % n;
      const o = this.leaders[i];
      const pv = eciAt(o, date);
      if (pv) {
        o.eci = [pv.position.x, pv.position.y, pv.position.z];
        this.vel[i] = [pv.velocity.x, pv.velocity.y, pv.velocity.z];
        this.lastPropT[i] = t;
        o.ok = true;
      } else o.ok = false;
    }
    this.cursor = (this.cursor + budget) % n;
  }

  positionNow(i, t) {
    const o = this.leaders[i];
    if (!o.ok) return null;
    const dt = (t - this.lastPropT[i]) / 1000;
    const v = this.vel[i];
    return [o.eci[0] + v[0] * dt, o.eci[1] + v[1] * dt, o.eci[2] + v[2] * dt];
  }

  // One orbit of ECI samples centred on `center`. Inertial ellipses drift slowly (J2), so a track
  // is rebuilt once the clock has moved an eighth of a period away from where it was sampled.
  track(o, center, key = String(o.id)) {
    const periodMs = o.periodMin * 60e3;
    const have = this.tracks.get(key);
    if (have && Math.abs(have.t0 - center) < periodMs / 8) return have.pts;
    const pts = new Float64Array(TRACK_SAMPLES * 3).fill(NaN);
    for (let k = 0; k < TRACK_SAMPLES; k++) {
      const pv = eciAt(o, new Date(center + (k / (TRACK_SAMPLES - 1) - 0.5) * periodMs));
      if (pv) { pts[k * 3] = pv.position.x; pts[k * 3 + 1] = pv.position.y; pts[k * 3 + 2] = pv.position.z; }
    }
    this.tracks.set(key, { t0: center, pts });
    return pts;
  }

  // ---------- picking ----------

  pick(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const x = clientX - r.left, y = clientY - r.top;
    let best = -1, bestD = 16 * 16;
    for (let i = 0; i < this.leaders.length; i++) {
      const sx = this.screen[i * 2], sy = this.screen[i * 2 + 1];
      if (!Number.isFinite(sx)) continue;
      const d = (sx - x) ** 2 + (sy - y) ** 2;
      // Stations and the current selection win ties against the swarm.
      const bias = this.leaders[i].flags.has('station') ? 0.5 : 1;
      if (d * bias < bestD) { bestD = d * bias; best = i; }
    }
    this.opts.onSelect(best >= 0 ? this.leaders[best] : null);
  }

  // ---------- drawing ----------

  frame(date, warp, dtMs) {
    const ctx = this.ctx, pal = this.pal;
    const idle = performance.now() - this.lastInput > 4000;
    if (idle && !this.opts.reducedMotion) this.cam.yaw += dtMs * 0.000035;
    this.cam.view += (this.cam.targetView - this.cam.view) * Math.min(1, dtMs / 350);

    this.propagateSlice(date, warp);
    const t = date.getTime();
    const cam = this.camera();
    const gmst = gstime(date);
    const sun = norm((({ x, y, z }) => [x, y, z])(sunEciKm(date)));

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, this.w, this.h);

    this.drawEarth(cam, gmst, sun);
    ctx.globalCompositeOperation = 'lighter';
    this.drawTracks(cam, t);
    this.drawPoints(cam, t);
    ctx.globalCompositeOperation = 'source-over';
    this.drawLabels(cam, t);
  }

  drawEarth(cam, gmst, sun) {
    const ctx = this.ctx, pal = this.pal;
    const c = this.project(cam, [0, 0, 0]);
    const rad = cam.focal * EARTH_R / Math.sqrt(cam.dist ** 2 - EARTH_R ** 2);
    // Disc: night side colour with a soft glow on the hemisphere facing the sun.
    ctx.beginPath(); ctx.arc(c[0], c[1], rad, 0, Math.PI * 2);
    ctx.fillStyle = `rgb(${pal.night})`; ctx.fill();
    const sp = this.project(cam, sun.map(v => v * EARTH_R));
    const facing = -dot(sun, cam.f); // >0 when the lit side faces the camera
    if (sp) {
      const g = ctx.createRadialGradient(sp[0], sp[1], 0, sp[0], sp[1], rad * 1.6);
      g.addColorStop(0, `rgba(${pal.sun}, ${0.10 + 0.10 * Math.max(0, facing)})`);
      g.addColorStop(1, `rgba(${pal.sun}, 0)`);
      ctx.save(); ctx.clip(); ctx.fillStyle = g; ctx.fillRect(c[0] - rad, c[1] - rad, rad * 2, rad * 2); ctx.restore();
    }
    // Limb
    ctx.beginPath(); ctx.arc(c[0], c[1], rad, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${pal.land}, 0.35)`; ctx.lineWidth = 1; ctx.stroke();

    // Surface lines: graticule and coastlines, ECEF → ECI by GMST, only the near hemisphere.
    const cg = Math.cos(gmst), sg = Math.sin(gmst);
    const toEci = (lon, lat) => {
      const cl = Math.cos(lat * DEG);
      const x = EARTH_R * cl * Math.cos(lon * DEG), y = EARTH_R * cl * Math.sin(lon * DEG), z = EARTH_R * Math.sin(lat * DEG);
      return [x * cg - y * sg, x * sg + y * cg, z];
    };
    const day = new Path2D(), night = new Path2D(), grid = new Path2D();
    const camDir = norm(cam.pos);
    const strokeLine = (coords, pathFor) => {
      let pen = false;
      for (let k = 0; k < coords.length; k += 2) {
        const p = toEci(coords[k], coords[k + 1]);
        const n = [p[0] / EARTH_R, p[1] / EARTH_R, p[2] / EARTH_R];
        // Visible if on the camera side of the horizon circle (a little slack for perspective).
        if (dot(n, camDir) < EARTH_R / cam.dist) { pen = false; continue; }
        const s = this.project(cam, p);
        if (!s) { pen = false; continue; }
        const path = pathFor(n);
        if (pen !== path) { path.moveTo(s[0], s[1]); pen = path; } else path.lineTo(s[0], s[1]);
      }
    };
    for (const line of this.world.coast) strokeLine(line, n => (dot(n, sun) > 0 ? day : night));
    for (let lat = -60; lat <= 60; lat += 30) {
      const pts = []; for (let lon = -180; lon <= 180; lon += 5) pts.push(lon, lat); strokeLine(pts, () => grid);
    }
    for (let lon = -180; lon < 180; lon += 30) {
      const pts = []; for (let lat = -90; lat <= 90; lat += 5) pts.push(lon, lat); strokeLine(pts, () => grid);
    }
    ctx.lineWidth = 0.6;
    ctx.strokeStyle = `rgba(${pal.land}, 0.10)`; ctx.stroke(grid);
    ctx.lineWidth = 0.9;
    ctx.strokeStyle = `rgba(${pal.land}, 0.30)`; ctx.stroke(night);
    ctx.strokeStyle = `rgba(${pal.land}, 0.75)`; ctx.stroke(day);

    // Terminator: the great circle perpendicular to the sun direction.
    const a = norm(cross(sun, [0, 0, 1])), b = cross(sun, a);
    const term = new Path2D(); let pen = false;
    for (let k = 0; k <= 180; k++) {
      const th = (k / 180) * Math.PI * 2;
      const n = [a[0] * Math.cos(th) + b[0] * Math.sin(th), a[1] * Math.cos(th) + b[1] * Math.sin(th), a[2] * Math.cos(th) + b[2] * Math.sin(th)];
      if (dot(n, camDir) < EARTH_R / cam.dist) { pen = false; continue; }
      const s = this.project(cam, n.map(v => v * EARTH_R));
      if (!s) { pen = false; continue; }
      if (pen) term.lineTo(s[0], s[1]); else { term.moveTo(s[0], s[1]); pen = true; }
    }
    ctx.strokeStyle = `rgba(${pal.sun}, 0.35)`; ctx.setLineDash([2, 4]); ctx.stroke(term); ctx.setLineDash([]);

    // Observer
    const ob = this.opts.getObserver();
    const op = toEci(ob.lonDeg, ob.latDeg);
    if (dot(norm(op), camDir) > EARTH_R / cam.dist) {
      const s = this.project(cam, op);
      if (s) {
        ctx.strokeStyle = `rgb(${pal.observer})`; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(s[0] - 5, s[1]); ctx.lineTo(s[0] + 5, s[1]); ctx.moveTo(s[0], s[1] - 5); ctx.lineTo(s[0], s[1] + 5); ctx.stroke();
        ctx.font = '10px "Space Mono", monospace'; ctx.fillStyle = `rgba(${pal.observer}, 0.9)`;
        ctx.fillText(ob.label.toUpperCase(), s[0] + 7, s[1] - 5);
      }
    }
    this.earthScreen = { c, rad };
  }

  // Orbit lines bucketed into a few Path2Ds: front/back × style, then stroked twice for glow.
  drawTracks(cam, t) {
    const ctx = this.ctx, pal = this.pal;
    const jobs = [];
    const add = (o, style, center = t, key) => jobs.push({ pts: this.track(o, center, key), style });

    // Stations and the brightest objects as a faint lattice; built lazily so loading stays fast.
    let built = 0;
    for (const o of this.leaders) {
      const style = o.flags.has('station') ? 'station' : o.flags.has('visual') ? 'faint' : null;
      if (!style || o === this.selected) continue;
      if (!this.tracks.has(String(o.id)) && built++ > 6) continue;
      add(o, style);
    }
    if (this.selected) add(this.selected, 'sel');
    if (this.conj?.a && this.conj?.b) {
      const tca = Date.parse(this.conj.tca);
      add(this.conj.a, 'conjA', tca, `tca:${this.conj.a.id}`);
      add(this.conj.b, 'conjB', tca, `tca:${this.conj.b.id}`);
    }

    const buckets = {};
    const bucket = (style, back) => (buckets[style + back] ??= { style, back, path: new Path2D() });
    for (const { pts, style } of jobs) {
      let prev = null, prevBack = null;
      for (let k = 0; k < TRACK_SAMPLES; k++) {
        const p = [pts[k * 3], pts[k * 3 + 1], pts[k * 3 + 2]];
        if (!Number.isFinite(p[0])) { prev = null; continue; }
        const s = this.project(cam, p);
        if (!s) { prev = null; continue; }
        const back = this.occluded(cam, p);
        if (prev && prevBack === back) bucket(style, back).path.lineTo(s[0], s[1]);
        else { const b = bucket(style, back).path; if (prev) b.moveTo(prev[0], prev[1]); else b.moveTo(s[0], s[1]); b.lineTo(s[0], s[1]); }
        prev = s; prevBack = back;
      }
    }
    const ink = { faint: pal.pay, station: pal.station, sel: pal.text, conjA: pal.hot, conjB: pal.warn };
    const alpha = { faint: 0.07, station: 0.28, sel: 0.7, conjA: 0.8, conjB: 0.8 };
    for (const { style, back, path } of Object.values(buckets)) {
      const a = alpha[style] * (back ? 0.25 : 1);
      if (style !== 'faint') { // wide tinted underlay
        ctx.lineWidth = 4; ctx.strokeStyle = `rgba(${ink[style]}, ${a * 0.18})`; ctx.stroke(path);
      }
      ctx.lineWidth = style === 'faint' ? 0.7 : 1.1;
      ctx.strokeStyle = `rgba(${ink[style]}, ${a})`; ctx.stroke(path);
    }

    // Conjunction marker at TCA.
    if (this.conj?.a) {
      const pv = eciAt(this.conj.a, new Date(Date.parse(this.conj.tca)));
      const p = pv && [pv.position.x, pv.position.y, pv.position.z];
      const s = p && this.project(cam, p);
      if (s) {
        const back = this.occluded(cam, p);
        ctx.strokeStyle = `rgba(${pal.hot}, ${back ? 0.35 : 1})`; ctx.lineWidth = 1.2;
        const r = 7 + 2 * Math.sin(performance.now() / 400);
        ctx.beginPath(); ctx.moveTo(s[0] - r, s[1] - r); ctx.lineTo(s[0] + r, s[1] + r);
        ctx.moveTo(s[0] + r, s[1] - r); ctx.lineTo(s[0] - r, s[1] + r); ctx.stroke();
        this.tcaScreen = s;
      } else this.tcaScreen = null;
    } else this.tcaScreen = null;
  }

  drawPoints(cam, t) {
    const ctx = this.ctx, pal = this.pal;
    const now = t;
    // ink[type][freshness]; freshness: element age < 1 d, < 3 d, older.
    const groups = new Map();
    const push = (key, x, y) => { let g = groups.get(key); if (!g) groups.set(key, (g = [])); g.push(x, y); };
    for (let i = 0; i < this.leaders.length; i++) {
      const o = this.leaders[i];
      const p = this.positionNow(i, t);
      this.screen[i * 2] = NaN;
      if (!p) continue;
      const s = this.project(cam, p);
      if (!s) continue;
      if (this.occluded(cam, p)) continue;
      this.screen[i * 2] = s[0]; this.screen[i * 2 + 1] = s[1];
      const type = o.flags.has('station') ? 'station' : o.type === 'DEB' ? 'deb' : o.type === 'R/B' ? 'rb' : 'pay';
      const age = (now - o.epoch) / 864e5;
      const fresh = age < 1 ? 2 : age < 3 ? 1 : 0;
      push(`${type}|${fresh}`, s[0], s[1]);
    }
    const alpha = [0.35, 0.6, 0.95];
    for (const [key, xy] of groups) {
      const [type, fresh] = key.split('|');
      const big = type === 'station' ? 3 : 1.6;
      ctx.fillStyle = `rgba(${pal[type]}, ${alpha[fresh]})`;
      for (let k = 0; k < xy.length; k += 2) ctx.fillRect(xy[k] - big / 2, xy[k + 1] - big / 2, big, big);
    }
  }

  drawLabels(cam, t) {
    const ctx = this.ctx, pal = this.pal;
    ctx.font = '10px "Space Mono", monospace';
    ctx.textBaseline = 'middle';
    const label = (o, text, color, ring) => {
      const i = this.leaders.indexOf(o);
      if (i < 0) return;
      const sx = this.screen[i * 2], sy = this.screen[i * 2 + 1];
      if (!Number.isFinite(sx)) return;
      ctx.strokeStyle = `rgba(${color}, 0.9)`; ctx.fillStyle = `rgba(${color}, 0.95)`; ctx.lineWidth = 1;
      if (ring) { ctx.beginPath(); ctx.arc(sx, sy, 8, 0, Math.PI * 2); ctx.stroke(); }
      // Leader line up and to the right, flipped left when the text would leave the canvas.
      const tw = ctx.measureText(text).width;
      const dir = sx + 33 + tw > this.w - 8 ? -1 : 1;
      const lx = sx + dir * 18, ly = sy - 16;
      ctx.beginPath(); ctx.moveTo(sx + dir * (ring ? 6 : 3), sy - (ring ? 6 : 3)); ctx.lineTo(lx, ly); ctx.lineTo(lx + dir * 6, ly); ctx.stroke();
      ctx.fillText(text, dir > 0 ? lx + 9 : lx - 9 - tw, ly);
    };
    for (const o of this.leaders) {
      if (o.flags.has('station') && o.docked.length && o !== this.selected) label(o, o.name.replace(/\s*\(.*\)/, ''), pal.station, false);
    }
    if (this.conj?.a && this.tcaScreen) {
      const [x, y] = this.tcaScreen;
      ctx.fillStyle = `rgb(${pal.hot})`;
      ctx.fillText(`TCA ${this.conj.label}`, x + 12, y + 14);
    }
    if (this.selected) {
      const p = this.positionNow(this.leaders.indexOf(this.selected), t);
      const alt = p ? Math.hypot(...p) - EARTH_R : NaN;
      label(this.selected, `${this.selected.name}  ${Number.isFinite(alt) ? alt.toFixed(0) + ' KM' : ''}`, pal.text, true);
    }
  }
}
