// The sky strip: everything above the observer's horizon right now, unrolled by azimuth
// (N → E → S → W → N) against elevation, plus the selected object's current or next pass.
// It plays the role of DECLINATION's compass strip: the same model, seen from the ground.

import { gstime, eciToEcf, ecfToLookAngles } from 'satellite.js';
import { eciAt, lookAngles } from './orbit.js';

const DEG = 180 / Math.PI;

// Look angles for every object the scene has propagated. ~20k objects cost a few ms, so this
// runs on a slow tick, not per frame.
export function skyPositions(scene, observer, date) {
  const gmst = gstime(date), t = date.getTime();
  const out = [];
  for (let i = 0; i < scene.leaders.length; i++) {
    const p = scene.positionNow(i, t);
    if (!p) continue;
    const la = ecfToLookAngles(observer, eciToEcf({ x: p[0], y: p[1], z: p[2] }, gmst));
    if (la.elevation <= 0) continue;
    const o = scene.leaders[i];
    out.push({ o, az: la.azimuth * DEG, el: la.elevation * DEG });
  }
  return out;
}

export function drawSky(canvas, { above, selected, pass, observer, pal, now }) {
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(r.width * dpr)) { canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr); }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  const w = r.width, h = r.height, top = 4, base = h - 14;
  const X = az => (az / 360) * w;
  const Y = el => base - (el / 90) * (base - top);

  // Grid: horizon, 30° and 60° rings, compass ticks every 15°.
  ctx.font = '9px "Space Mono", monospace';
  ctx.textBaseline = 'alphabetic';
  for (const el of [0, 30, 60]) {
    ctx.fillStyle = `rgba(${pal.text}, ${el ? 0.07 : 0.25})`;
    ctx.fillRect(0, Math.round(Y(el)), w, 1);
    if (el) { ctx.fillStyle = `rgba(${pal.text}, .3)`; ctx.fillText(`${el}°`, 2, Y(el) - 2); }
  }
  for (let az = 0; az < 360; az += 15) {
    const major = az % 90 === 0, mid = az % 45 === 0;
    ctx.fillStyle = `rgba(${pal.text}, ${major ? 0.5 : 0.18})`;
    ctx.fillRect(Math.round(X(az)), base, 1, major ? 6 : mid ? 4 : 2);
    if (mid) {
      const label = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][az / 45];
      ctx.fillStyle = `rgba(${pal.text}, ${major ? 0.7 : 0.38})`;
      ctx.fillText(label, Math.min(w - 14, X(az) + 3), h - 2);
    }
  }

  // Everything above the horizon.
  ctx.globalCompositeOperation = 'lighter';
  for (const { o, az, el } of above) {
    const type = o.flags.has('station') ? 'station' : o.type === 'DEB' ? 'deb' : o.type === 'R/B' ? 'rb' : 'pay';
    ctx.fillStyle = `rgba(${pal[type]}, ${type === 'station' ? 0.95 : 0.55})`;
    const s = type === 'station' ? 3 : 1.5;
    ctx.fillRect(X(az) - s / 2, Y(el) - s / 2, s, s);
  }

  // The selected object's pass: its arc across the sky, and where it is now.
  if (selected && pass) {
    ctx.strokeStyle = `rgba(${pal.text}, .55)`; ctx.lineWidth = 1;
    ctx.beginPath();
    let prevX = null;
    for (let t = pass.start; t <= pass.stop; t += Math.max(5e3, (pass.stop - pass.start) / 80)) {
      const pv = eciAt(selected, new Date(t));
      if (!pv) continue;
      const la = lookAngles(observer, pv.position, new Date(t));
      const x = X(la.az), y = Y(Math.max(0, la.el));
      if (prevX === null || Math.abs(x - prevX) > w / 2) ctx.moveTo(x, y); else ctx.lineTo(x, y); // wrap at north
      prevX = x;
    }
    ctx.stroke();
    const pk = X(pass.maxAz), py = Y(pass.maxEl);
    ctx.fillStyle = `rgba(${pal.text}, .8)`;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillText(`${pass.maxEl.toFixed(0)}°`, Math.min(w - 22, pk + 4), py - 4);
  }
  ctx.globalCompositeOperation = 'source-over';
  if (selected) {
    const pv = eciAt(selected, now);
    const la = pv && lookAngles(observer, pv.position, now);
    if (la && la.el > 0) {
      const x = X(la.az), y = Y(la.el);
      ctx.strokeStyle = `rgb(${pal.text})`; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = `rgb(${pal.text})`;
      ctx.fillText(selected.name, Math.min(w - ctx.measureText(selected.name).width - 2, x + 8), Math.max(10, y - 6));
    }
  }
}
