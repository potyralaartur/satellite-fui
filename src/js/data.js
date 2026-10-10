// Loads dist/data/snapshot.json and turns every packed row into an object with a satrec and
// a few derived orbital quantities. Everything else on the page reads from these objects.

import { json2satrec } from 'satellite.js';

export const EARTH_R = 6378.137; // km
const MU = 398600.4418; // km^3/s^2

export async function loadSnapshot() {
  const [snap, coast] = await Promise.all([
    fetch('data/snapshot.json').then(r => r.json()),
    fetch('data/coast.json').then(r => r.json()),
  ]);
  const f = Object.fromEntries(snap.fields.map((k, i) => [k, i]));
  const objects = [];
  for (const row of snap.objects) {
    const omm = {
      OBJECT_NAME: row[f.name], OBJECT_ID: row[f.intl], EPOCH: row[f.epoch],
      MEAN_MOTION: row[f.mm], ECCENTRICITY: row[f.ecc], INCLINATION: row[f.inc],
      RA_OF_ASC_NODE: row[f.raan], ARG_OF_PERICENTER: row[f.argp], MEAN_ANOMALY: row[f.ma],
      EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: 'U', NORAD_CAT_ID: row[f.id], ELEMENT_SET_NO: 999,
      REV_AT_EPOCH: 0, BSTAR: row[f.bstar], MEAN_MOTION_DOT: row[f.mmdot], MEAN_MOTION_DDOT: row[f.mmddot],
    };
    let satrec;
    try { satrec = json2satrec(omm); } catch { continue; }
    if (satrec.error) continue;
    const n = (omm.MEAN_MOTION * 2 * Math.PI) / 86400; // rad/s
    const a = Math.cbrt(MU / (n * n));
    const e = omm.ECCENTRICITY;
    const apogee = a * (1 + e) - EARTH_R, perigee = a * (1 - e) - EARTH_R;
    objects.push({
      id: omm.NORAD_CAT_ID, name: omm.OBJECT_NAME, intl: omm.OBJECT_ID,
      epoch: Date.parse(omm.EPOCH + (omm.EPOCH.endsWith('Z') ? '' : 'Z')),
      type: row[f.type] || 'PAY', owner: row[f.owner], launch: row[f.launch], ops: row[f.ops],
      flags: new Set(String(row[f.flags]).split(' ').filter(Boolean)),
      inc: omm.INCLINATION, ecc: e, periodMin: 1440 / omm.MEAN_MOTION, apogee, perigee,
      regime: regimeOf(apogee, perigee, e, 1440 / omm.MEAN_MOTION),
      key: `${omm.EPOCH}|${omm.MEAN_MOTION}|${omm.MEAN_ANOMALY}`,
      satrec,
      // filled by the scene every refresh
      eci: null, ok: false,
    });
  }
  groupDocked(objects);
  return { snap, objects, coast, byId: new Map(objects.map(o => [o.id, o])) };
}

function regimeOf(apogee, perigee, ecc, periodMin) {
  if (ecc > 0.25) return 'HEO';
  if (apogee < 2000) return 'LEO';
  if (periodMin > 1300 && periodMin < 1600) return 'GEO';
  return 'MEO';
}

// Docked vehicles share one element set and propagate to the same point. Group them under the
// lowest catalog number (ISS ZARYA, CSS TIANHE) so the scene draws one object, not a stack.
function groupDocked(objects) {
  const groups = new Map();
  for (const o of objects) {
    const g = groups.get(o.key);
    if (g) g.push(o); else groups.set(o.key, [o]);
  }
  for (const g of groups.values()) {
    g.sort((x, y) => x.id - y.id);
    for (const o of g) {
      o.leader = g[0];
      o.docked = g.length > 1 ? g.filter(x => x !== o) : [];
    }
  }
}

export function search(objects, q) {
  q = q.trim().toUpperCase();
  if (!q) return [];
  const id = Number(q);
  const hits = objects.filter(o => (Number.isFinite(id) && o.id === id) || o.name.includes(q));
  hits.sort((a, b) => (a.name.startsWith(q) ? 0 : 1) - (b.name.startsWith(q) ? 0 : 1) || a.name.length - b.name.length);
  return hits.slice(0, 8);
}
