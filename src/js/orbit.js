// SGP4 helpers on top of satellite.js: position at a time, look angles, sun, and pass prediction.

import {
  propagate, gstime, eciToGeodetic, eciToEcf, ecfToLookAngles, sunPos, jday, shadowFraction,
  degreesLat, degreesLong, radiansToDegrees,
} from 'satellite.js';

const KM_PER_AU = 149597870.7;
const DEG = Math.PI / 180;

export function eciAt(o, date) {
  const pv = propagate(o.satrec, date);
  return pv && pv.position && Number.isFinite(pv.position.x) ? pv : null;
}

export function sunEciKm(date) {
  const { rsun } = sunPos(jday(date));
  return { x: rsun.x * KM_PER_AU, y: rsun.y * KM_PER_AU, z: rsun.z * KM_PER_AU, au: rsun };
}

export function lookAngles(observer, eci, date) {
  const la = ecfToLookAngles(observer, eciToEcf(eci, gstime(date)));
  return { az: radiansToDegrees(la.azimuth), el: radiansToDegrees(la.elevation), range: la.rangeSat };
}

// Everything the readout panel shows about one object at one instant.
export function stateOf(o, date, observer) {
  const pv = eciAt(o, date);
  if (!pv) return null;
  const gmst = gstime(date);
  const gd = eciToGeodetic(pv.position, gmst);
  const v = pv.velocity;
  const sun = sunEciKm(date);
  return {
    lat: degreesLat(gd.latitude), lon: degreesLong(gd.longitude), alt: gd.height,
    speed: Math.hypot(v.x, v.y, v.z),
    shadow: shadowFraction(sun.au, pv.position),
    look: lookAngles(observer, pv.position, date),
    ageDays: (date - o.epoch) / 864e5,
  };
}

const elevationAt = (o, observer, t) => {
  const pv = eciAt(o, new Date(t));
  return pv ? lookAngles(observer, pv.position, new Date(t)).el : -90;
};

// Bisection on the horizon crossing between t0 (below) and t1 (above), or the reverse.
function crossing(o, observer, t0, t1, minEl) {
  let a = t0, b = t1;
  const rising = elevationAt(o, observer, a) < minEl;
  for (let i = 0; i < 20 && b - a > 1000; i++) {
    const m = (a + b) / 2;
    if ((elevationAt(o, observer, m) < minEl) === rising) a = m; else b = m;
  }
  return (a + b) / 2;
}

// Passes above minEl in the next `hours`. A pass is "visible" when the satellite is sunlit at
// culmination while the observer is in at least civil twilight (sun below -6°).
export function predictPasses(o, observer, from, { hours = 48, minEl = 10, max = 6 } = {}) {
  const passes = [];
  const step = o.periodMin < 200 ? 30e3 : 120e3;
  const end = from.getTime() + hours * 3600e3;
  let prevT = from.getTime(), prevEl = elevationAt(o, observer, prevT);
  let start = prevEl >= minEl ? prevT : null;
  for (let t = prevT + step; t <= end && passes.length < max; t += step) {
    const el = elevationAt(o, observer, t);
    if (start === null && prevEl < minEl && el >= minEl) start = crossing(o, observer, prevT, t, minEl);
    if (start !== null && prevEl >= minEl && el < minEl) {
      const stop = crossing(o, observer, prevT, t, minEl);
      passes.push(describePass(o, observer, start, stop));
      start = null;
    }
    prevT = t; prevEl = el;
  }
  return passes;
}

function describePass(o, observer, start, stop) {
  let best = { t: start, el: -90, az: 0 };
  for (let t = start; t <= stop; t += 5e3) {
    const d = new Date(t);
    const pv = eciAt(o, d);
    if (!pv) continue;
    const la = lookAngles(observer, pv.position, d);
    if (la.el > best.el) best = { t, el: la.el, az: la.az, eci: pv.position };
  }
  const d = new Date(best.t);
  const sun = sunEciKm(d);
  const sunEl = lookAngles(observer, sun, d).el;
  const sunlit = best.eci ? shadowFraction(sun.au, best.eci) < 0.5 : false;
  const azAt = t => { const p = eciAt(o, new Date(t)); return p ? lookAngles(observer, p.position, new Date(t)).az : 0; };
  return {
    start, stop, maxT: best.t, maxEl: best.el,
    startAz: azAt(start), maxAz: best.az, stopAz: azAt(stop),
    visible: sunlit && sunEl < -6, sunlit, sunEl,
  };
}

export function compass(az) {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((az % 360) + 360) % 360 / 45) % 8];
}

export function observerFrom(latDeg, lonDeg, heightKm = 0.2, label = '') {
  return { latitude: latDeg * DEG, longitude: lonDeg * DEG, height: heightKm, latDeg, lonDeg, label };
}
