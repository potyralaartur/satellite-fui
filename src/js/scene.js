// The hero: a hand-rolled pinhole camera over the orbital shell, drawn in Canvas 2D.
// Positions are ECI (TEME, km). Earth's surface is rotated into ECI by GMST each frame, so
// orbits stay put and the planet turns under them.

import { gstime } from 'satellite.js';
import { EARTH_R } from './data.js';
import { eciAt, sunEciKm } from './orbit.js';

const DEG = Math.PI / 180;
const TRACK_SAMPLES = 160;
const MIN_VIEW = 150, FOCUS_FAR = 9000, FOCUS_NEAR = 3500;
const smoothstep = x => { const c = Math.max(0, Math.min(1, x)); return c * c * (3 - 2 * c); };

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  const rgb = name => cs.getPropertyValue(`--p-${name}-rgb`).trim() || '255,255,255';
  return Object.fromEntries(['text', 'pay', 'rb', 'deb', 'station', 'deep', 'hot', 'warn', 'land', 'night', 'sun', 'observer', 'k1', 'k3', 'flux', 'dim']
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
    this.cam = { yaw: -60 * DEG, pitch: 22 * DEG, view: 27000, targetView: 27000 };
    this.hidden = new Set(); // object types switched off in the legend
    this.lookAt = [0, 0, 0];
    this.focus = 0;
    this.lastDrag = 0;
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
    this.insets = { top: 0, right: 0, bottom: 0, left: 0, ...this.opts.getInsets?.() };
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
      this.lastInput = this.lastDrag = performance.now();
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
      if (k) { this.lastInput = this.lastDrag = performance.now(); this.cam.yaw += k[0]; this.cam.pitch = Math.max(-1.4, Math.min(1.4, this.cam.pitch + k[1])); e.preventDefault(); }
      if (e.key === '+' || e.key === '=') this.zoomTo(this.cam.targetView / 1.3, true);
      if (e.key === '-') this.zoomTo(this.cam.targetView * 1.3, true);
    });
  }

  // Below FOCUS_FAR the camera starts to centre on the selected object instead of the Earth,
  // and by FOCUS_NEAR it is following it, so zooming in lands on the satellite, not the core.
  zoomTo(view, immediate = false) {
    const before = this.cam.targetView;
    this.cam.targetView = Math.max(MIN_VIEW, Math.min(60000, view));
    if (immediate) this.cam.view = this.cam.targetView;
    if (this.selected && before >= FOCUS_FAR && this.cam.targetView < FOCUS_FAR) this.faceSelected();
  }

  // Turn the camera so the selected object is on the near side of the Earth.
  faceSelected() {
    const p = this.selectedPos;
    if (!p) return;
    this.cutAt = performance.now();
    this.cam.targetYaw = Math.atan2(p[1], p[0]);
    this.cam.targetPitch = Math.max(-1.2, Math.min(1.2, Math.asin(p[2] / Math.hypot(...p)) + 0.25));
  }

  toggleType(type, on) { if (on) this.hidden.delete(type); else this.hidden.add(type); }

  select(o, { zoom = true } = {}) {
    this.selected = o?.leader ?? null;
    this.selectedPos = null;
    if (this.selected && zoom) this.zoomTo(Math.max(9500, (this.selected.apogee + EARTH_R) * 1.45));
  }

  // A cut in the idle tour: ease the camera to a new angle and distance.
  cutTo({ yaw, pitch, view }) {
    this.cutAt = performance.now();
    if (yaw !== undefined) this.cam.targetYaw = yaw;
    if (pitch !== undefined) this.cam.targetPitch = pitch;
    if (view !== undefined) this.zoomTo(view);
  }

  // Yaw that puts an ECI position facing the camera.
  yawFacing(p) { return Math.atan2(p[1], p[0]); }

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
    const L = this.lookAt;
    let pos = [L[0] + dist * Math.cos(pitch) * Math.cos(yaw), L[1] + dist * Math.cos(pitch) * Math.sin(yaw), L[2] + dist * Math.sin(pitch)];
    const r0 = Math.hypot(...pos);
    if (r0 < EARTH_R + 150) pos = pos.map(v => v * (EARTH_R + 150) / r0); // never inside the planet
    const f = norm(sub(L, pos));
    const r = norm(cross(f, [0, 0, 1]));
    const u = cross(r, f);
    // Centre the Earth in the part of the canvas the HUD panels leave uncovered.
    const { top, right, bottom, left } = this.insets;
    const vw = Math.max(80, this.w - left - right), vh = Math.max(80, this.h - top - bottom);
    const half = Math.min(vw, vh) / 2;
    const focal = half * 0.94 * dist / view;
    return { pos, f, r, u, focal, dist, dist0: Math.hypot(...pos), cx: left + vw / 2, cy: top + vh / 2 };
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
    const k = Math.min(1, dtMs / 700);
    if (this.lastDrag > (this.cutAt ?? 0)) this.cam.targetYaw = this.cam.targetPitch = undefined; // user took over
    if (this.cam.targetYaw !== undefined) {
      const d = Math.atan2(Math.sin(this.cam.targetYaw - this.cam.yaw), Math.cos(this.cam.targetYaw - this.cam.yaw));
      this.cam.yaw += d * k;
      if (Math.abs(d) < 0.002) this.cam.targetYaw = undefined;
    } else if (idle && !this.opts.reducedMotion && this.focus < 0.1) this.cam.yaw += dtMs * 0.000035;
    if (this.cam.targetPitch !== undefined) this.cam.pitch += (this.cam.targetPitch - this.cam.pitch) * k;
    this.cam.view += (this.cam.targetView - this.cam.view) * Math.min(1, dtMs / 350);

    this.propagateSlice(date, warp);
    const t = date.getTime();

    // Close zoom: ease the look-at point from the Earth's centre onto the selected object, and
    // when nobody is dragging, slowly swing round with it so it never slips behind the planet.
    const si = this.selected ? this.leaders.indexOf(this.selected) : -1;
    this.selectedPos = si >= 0 ? this.positionNow(si, t) : null;
    const want = this.selectedPos ? smoothstep((FOCUS_FAR - this.cam.view) / (FOCUS_FAR - FOCUS_NEAR)) : 0;
    this.focus += (want - this.focus) * Math.min(1, dtMs / 400);
    const P = this.selectedPos ?? [0, 0, 0];
    this.lookAt = P.map(v => v * this.focus);
    if (this.focus > 0.5 && this.cam.targetYaw === undefined && performance.now() - this.lastDrag > 3000 && !this.opts.reducedMotion) {
      const ty = Math.atan2(P[1], P[0]), tp = Math.asin(P[2] / Math.hypot(...P)) + 0.25;
      const kk = Math.min(1, dtMs / 4000);
      this.cam.yaw += Math.atan2(Math.sin(ty - this.cam.yaw), Math.cos(ty - this.cam.yaw)) * kk;
      this.cam.pitch += (Math.max(-1.2, Math.min(1.2, tp)) - this.cam.pitch) * kk;
    }
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
    if (!c) return;
    const rad = cam.focal * EARTH_R / Math.sqrt(cam.dist0 ** 2 - EARTH_R ** 2) * (cam.dist0 / c[2]);
    // Disc: the true horizon circle projected (an ellipse when the Earth sits off-axis at close
    // zoom), filled night-side colour with a soft glow on the hemisphere facing the sun.
    const cd = norm(cam.pos), hr = EARTH_R / cam.dist0;
    const hc = cd.map(v => v * EARTH_R * hr), hrad = EARTH_R * Math.sqrt(1 - hr * hr);
    const ha = norm(cross(cd, Math.abs(cd[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0])), hb = cross(cd, ha);
    const disc = new Path2D(); let first = true;
    for (let k = 0; k <= 128; k++) {
      const th = (k / 128) * Math.PI * 2, cs = Math.cos(th) * hrad, sn = Math.sin(th) * hrad;
      const s = this.project(cam, [hc[0] + ha[0] * cs + hb[0] * sn, hc[1] + ha[1] * cs + hb[1] * sn, hc[2] + ha[2] * cs + hb[2] * sn]);
      if (!s) continue;
      if (first) { disc.moveTo(s[0], s[1]); first = false; } else disc.lineTo(s[0], s[1]);
    }
    disc.closePath();
    ctx.fillStyle = `rgb(${pal.night})`; ctx.fill(disc);
    const sp = this.project(cam, sun.map(v => v * EARTH_R));
    const facing = -dot(sun, cam.f); // >0 when the lit side faces the camera
    if (sp) {
      const g = ctx.createRadialGradient(sp[0], sp[1], 0, sp[0], sp[1], rad * 1.6);
      g.addColorStop(0, `rgba(${pal.sun}, ${0.10 + 0.10 * Math.max(0, facing)})`);
      g.addColorStop(1, `rgba(${pal.sun}, 0)`);
      ctx.save(); ctx.clip(disc); ctx.fillStyle = g; ctx.fillRect(0, 0, this.w, this.h); ctx.restore();
    }
    ctx.strokeStyle = `rgba(${pal.land}, 0.35)`; ctx.lineWidth = 1; ctx.stroke(disc);

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
        if (dot(n, camDir) < EARTH_R / cam.dist0) { pen = false; continue; }
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
      if (dot(n, camDir) < EARTH_R / cam.dist0) { pen = false; continue; }
      const s = this.project(cam, n.map(v => v * EARTH_R));
      if (!s) { pen = false; continue; }
      if (pen) term.lineTo(s[0], s[1]); else { term.moveTo(s[0], s[1]); pen = true; }
    }
    ctx.strokeStyle = `rgba(${pal.sun}, 0.35)`; ctx.setLineDash([2, 4]); ctx.stroke(term); ctx.setLineDash([]);

    // Observer
    const ob = this.opts.getObserver();
    const op = toEci(ob.lonDeg, ob.latDeg);
    if (dot(norm(op), camDir) > EARTH_R / cam.dist0) {
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

    // Crewed stations' orbits stay on; everything else only when selected, so the picture
    // doesn't drown in lines. Built lazily so loading stays fast.
    let built = 0;
    for (const o of this.leaders) {
      if (!o.flags.has('station') || o === this.selected || this.hidden.has('station')) continue;
      const style = 'station';
      if (!this.tracks.has(String(o.id)) && built++ > 6) continue;
      add(o, style);
    }
    if (this.selected) add(this.selected, 'sel');
    if (this.conj?.a && this.conj?.b) {
      const tca = Date.parse(this.conj.tca);
      add(this.conj.a, 'conjA', tca, `tca:${this.conj.a.id}`);
      add(this.conj.b, 'conjB', tca, `tca:${this.conj.b.id}`);
    }

    // Colour carries meaning, as in DECLINATION: northbound legs of an orbit are drawn ice-white,
    // southbound legs deep blue, so the eye reads each ring's direction of travel.
    const buckets = {};
    const bucket = (style, back, leg) => (buckets[style + back + leg] ??= { style, back, leg, path: new Path2D() });
    for (const { pts, style } of jobs) {
      let prev = null, prevBack = null, prevLeg = null, prevZ = NaN;
      for (let k = 0; k < TRACK_SAMPLES; k++) {
        const p = [pts[k * 3], pts[k * 3 + 1], pts[k * 3 + 2]];
        if (!Number.isFinite(p[0])) { prev = null; continue; }
        const s = this.project(cam, p);
        if (!s) { prev = null; continue; }
        const back = this.occluded(cam, p);
        const leg = style.startsWith('conj') ? 'n' : Number.isFinite(prevZ) && p[2] < prevZ ? 's' : 'n';
        if (prev && prevBack === back && prevLeg === leg) bucket(style, back, leg).path.lineTo(s[0], s[1]);
        else { const b = bucket(style, back, leg).path; b.moveTo(...(prev ?? s)); b.lineTo(s[0], s[1]); }
        prev = s; prevBack = back; prevLeg = leg; prevZ = p[2];
      }
    }
    const ink = { faint: pal.flux, station: pal.station, sel: pal.text, conjA: pal.hot, conjB: pal.warn };
    const alpha = { faint: 0.45, station: 0.2, sel: 0.75, conjA: 0.8, conjB: 0.8 };
    // The strongest lines breathe on a slow sine so the frame never sits perfectly still.
    const breathe = this.opts.reducedMotion ? 1 : 0.82 + 0.18 * Math.sin(performance.now() / 6500 * Math.PI * 2);
    for (const { style, back, leg, path } of Object.values(buckets)) {
      const a = alpha[style] * (back ? 0.25 : 1) * (style === 'faint' ? 1 : breathe) * (leg === 's' && style !== 'faint' ? 0.85 : 1);
      const colour = leg === 's' && style !== 'faint' ? pal.deep : ink[style];
      if (style !== 'faint') { // wide tinted underlay
        ctx.lineWidth = 4; ctx.strokeStyle = `rgba(${colour}, ${a * 0.18})`; ctx.stroke(path);
      }
      ctx.lineWidth = style === 'faint' ? 0.7 : 1.1;
      ctx.strokeStyle = `rgba(${colour}, ${a})`; ctx.stroke(path);
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
      if (this.hidden.has(type) && o !== this.selected) continue;
      const age = (now - o.epoch) / 864e5;
      const fresh = age < 1 ? 2 : age < 3 ? 1 : 0;
      push(`${type}|${fresh}`, s[0], s[1]);
    }
    // Kept deliberately quiet: thousands of points add up under 'lighter', so each one is small
    // and dim, debris and rocket bodies dimmer still, and everything steps back when one
    // object is selected. Closer in, points get a little bigger again.
    const fresh = [0.45, 0.7, 1];
    const base = { pay: 0.5, rb: 0.42, deb: 0.32, station: 1 };
    const quiet = this.selected ? 0.6 : 1;
    const grow = this.cam.view < 1000 ? 2.4 : this.cam.view < 6000 ? 1.6 : 1;
    for (const [key, xy] of groups) {
      const [type, f] = key.split('|');
      const big = type === 'station' ? 3 : 1.25 * grow;
      ctx.fillStyle = `rgba(${pal[type]}, ${base[type] * fresh[f] * (type === 'station' ? 1 : quiet)})`;
      for (let k = 0; k < xy.length; k += 2) ctx.fillRect(xy[k] - big / 2, xy[k + 1] - big / 2, big, big);
    }
  }

  // The selection cursor: a 12 px ring, four ticks turning slowly around it, and L-brackets
  // that breathe in and out. Returns the bracket radius so the leader line starts at its corner.
  drawCursor(x, y, color) {
    const ctx = this.ctx, now = performance.now() / 1000;
    const still = this.opts.reducedMotion;
    ctx.strokeStyle = `rgba(${color}, 0.95)`; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke();
    const rot = still ? 0 : now * 0.35;
    ctx.beginPath();
    for (let k = 0; k < 4; k++) {
      const a = rot + k * Math.PI / 2, c = Math.cos(a), s = Math.sin(a);
      ctx.moveTo(x + c * 15, y + s * 15); ctx.lineTo(x + c * 22, y + s * 22);
    }
    ctx.strokeStyle = `rgba(${this.pal.k3}, 0.9)`; ctx.stroke();
    const r = 27 / Math.SQRT2 + (still ? 0 : 2 * Math.sin(now / 2.2 * Math.PI * 2)), arm = 6;
    ctx.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const cx = x + sx * r, cy = y + sy * r;
      ctx.moveTo(cx - sx * arm, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy - sy * arm);
    }
    ctx.strokeStyle = `rgba(${color}, 0.8)`; ctx.stroke();
    return r;
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
      const b = ring ? this.drawCursor(sx, sy, color) : 3;
      // Leader line up and to the right, flipped left when the text would leave the canvas.
      const tw = ctx.measureText(text).width;
      const dir = sx + b + 22 + tw > this.w - this.insets.right - 8 ? -1 : 1;
      const lx = sx + dir * (b + 10), ly = sy - b - 8;
      ctx.strokeStyle = `rgba(${color}, 0.9)`; ctx.fillStyle = `rgba(${color}, 0.95)`; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(sx + dir * b, sy - b); ctx.lineTo(lx, ly); ctx.lineTo(lx + dir * 6, ly); ctx.stroke();
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
    // Close in, name the objects around the selection.
    if (this.selected && this.cam.view < 4500) {
      const si = this.leaders.indexOf(this.selected);
      const x0 = this.screen[si * 2], y0 = this.screen[si * 2 + 1];
      if (Number.isFinite(x0)) {
        const near = [];
        for (let i = 0; i < this.leaders.length; i++) {
          if (i === si) continue;
          const x = this.screen[i * 2], y = this.screen[i * 2 + 1];
          if (!Number.isFinite(x) || x > this.w - this.insets.right - 60) continue;
          const d = (x - x0) ** 2 + (y - y0) ** 2;
          if (d > 60 * 60 && d < 320 * 320) near.push([d, i]);
        }
        near.sort((a, b) => a[0] - b[0]);
        ctx.font = '9px "Space Mono", monospace';
        ctx.fillStyle = `rgba(${pal.dim}, 0.9)`;
        // Skip any name that would overlap one already placed (or the selection's own label).
        const boxes = [[x0 - 30, y0 - 50, 260, 80]];
        let shown = 0;
        for (const [, i] of near) {
          if (shown >= 8) break;
          const name = this.leaders[i].name, x = this.screen[i * 2] + 5, y = this.screen[i * 2 + 1] - 5;
          const box = [x - 2, y - 7, ctx.measureText(name).width + 4, 13];
          if (boxes.some(b => box[0] < b[0] + b[2] && b[0] < box[0] + box[2] && box[1] < b[1] + b[3] && b[1] < box[1] + box[3])) continue;
          boxes.push(box); shown++;
          ctx.fillText(name, x, y);
        }
        ctx.font = '10px "Space Mono", monospace';
      }
    }
    if (this.selected) {
      const p = this.positionNow(this.leaders.indexOf(this.selected), t);
      const alt = p ? Math.hypot(...p) - EARTH_R : NaN;
      label(this.selected, `${this.selected.name}  ${Number.isFinite(alt) ? alt.toFixed(0) + ' KM' : ''}`, pal.text, true);
    }
  }
}
