#!/usr/bin/env node
// Builds the static site into ./dist:
//   dist/index.html, style.css      copied from src/
//   dist/app.js                     src/js/main.js bundled with satellite.js (esbuild)
//   dist/data/snapshot.json         every dataset the page needs, joined by NORAD id
//   dist/data/coast.json            Natural Earth 110m land outlines (world-atlas)
//   dist/data/coast-hi.json         Natural Earth 50m land outlines, loaded on close zoom
//
// Data comes from ./data (written by `npm run fetch-data`) when present, otherwise from the
// seed snapshot in data/seed-2026-10-10, so the site always builds offline.
//
//   node scripts/build-site.mjs

import { mkdir, readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { mesh } from 'topojson-client';
import { csvToOmm, parseCsv } from './omm.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const SEED = join(DATA, 'seed-2026-10-10');
const SRC = join(ROOT, 'src');
const OUT = join(ROOT, 'dist');
const require = createRequire(import.meta.url);

const exists = p => stat(p).then(() => true, () => false);
const readText = p => readFile(p, 'utf8');
async function readJson(p) { try { return JSON.parse(await readText(p)); } catch { return null; } }

const log = (...a) => console.log('build ', ...a);

// ---------- orbits ----------

// Ordered by priority: a flag from a later group is added to an object already seen.
const GROUPS = [
  ['celestrak-active.csv', 'active'],
  ['celestrak-stations.csv', 'station'],
  ['celestrak-visual.csv', 'visual'],
  ['celestrak-cosmos-2251-debris.csv', 'debris'],
  ['celestrak-decaying.csv', 'decaying'],
];

async function loadOrbits() {
  const byId = new Map();
  const used = [];
  for (const [file, flag] of GROUPS) {
    let path = join(DATA, file);
    if (!(await exists(path))) {
      if (flag !== 'station') continue;
      path = join(SEED, 'celestrak-stations.csv');
    }
    const rows = csvToOmm(await readText(path));
    used.push(`${path.replace(ROOT + '/', '')} (${rows.length})`);
    for (const o of rows) {
      if (!Number.isFinite(o.NORAD_CAT_ID) || !Number.isFinite(o.MEAN_MOTION)) continue;
      const prev = byId.get(o.NORAD_CAT_ID);
      if (prev) prev.flags.add(flag);
      else byId.set(o.NORAD_CAT_ID, { omm: o, flags: new Set([flag]) });
    }
  }
  log('orbits from', used.join(', '));
  return byId;
}

// CelesTrak SATCAT, joined by NORAD id: object type, owner, launch date, ops status.
async function loadSatcat() {
  const path = join(DATA, 'celestrak-satcat.csv');
  if (!(await exists(path))) return null;
  const [header, ...rows] = parseCsv(await readText(path));
  const col = name => header.indexOf(name);
  const iId = col('NORAD_CAT_ID'), iType = col('OBJECT_TYPE'), iOwner = col('OWNER'),
    iLaunch = col('LAUNCH_DATE'), iOps = col('OPS_STATUS_CODE');
  if (iId < 0) return null;
  const map = new Map();
  for (const r of rows) map.set(Number(r[iId]), {
    type: r[iType] ?? '', owner: r[iOwner] ?? '', launch: r[iLaunch] ?? '', ops: r[iOps] ?? '',
  });
  log('satcat', map.size, 'entries');
  return map;
}

function guessType(name) {
  if (/\bDEB\b/.test(name)) return 'DEB';
  if (/\bR\/B\b/.test(name)) return 'R/B';
  return 'PAY';
}

// Compact row layout; src/js/data.js reads the same order.
const OBJ_FIELDS = ['name', 'intl', 'epoch', 'mm', 'ecc', 'inc', 'raan', 'argp', 'ma',
  'id', 'bstar', 'mmdot', 'mmddot', 'type', 'owner', 'launch', 'ops', 'flags'];

function packObjects(byId, satcat) {
  const out = [];
  for (const { omm: o, flags } of byId.values()) {
    const sc = satcat?.get(o.NORAD_CAT_ID);
    out.push([
      o.OBJECT_NAME, o.OBJECT_ID, o.EPOCH, o.MEAN_MOTION, o.ECCENTRICITY, o.INCLINATION,
      o.RA_OF_ASC_NODE, o.ARG_OF_PERICENTER, o.MEAN_ANOMALY, o.NORAD_CAT_ID, o.BSTAR,
      o.MEAN_MOTION_DOT, o.MEAN_MOTION_DDOT,
      sc?.type || guessType(o.OBJECT_NAME), sc?.owner ?? '', sc?.launch ?? '', sc?.ops ?? '',
      [...flags].join(' '),
    ]);
  }
  return out;
}

// ---------- conjunctions ----------

// Full SOCRATES CSV (fetched with --socrates-full) when it parses, else the seed top 10.
// Columns are found by name so a reordered header still works; anything unrecognised falls back.
async function loadConjunctions() {
  const full = await loadSocratesFull();
  if (full) return full;
  const rows = parseCsv(await readText(join(SEED, 'socrates-top10-maxprob.csv')));
  const [h, ...body] = rows;
  const all = body.map(r => Object.fromEntries(h.map((k, i) => [k, r[i]])));
  // Docked pairs show up with ~0 relative speed; they are not close approaches.
  const real = all.filter(c => Number(c.rel_speed_km_s) > 0.05).map(c => ({
    a: { id: Number(c.norad_1), name: c.name_1, ops: c.ops_status_1, age: Number(c.days_since_epoch_1) },
    b: { id: Number(c.norad_2), name: c.name_2, ops: c.ops_status_2, age: Number(c.days_since_epoch_2) },
    tca: c.tca_utc,
    rangeKm: Number(c.min_range_km),
    speedKms: Number(c.rel_speed_km_s),
    maxProb: Number(c.max_probability),
  }));
  log('conjunctions', real.length, `of ${all.length} from seed (docked pairs dropped)`);
  return { source: 'CelesTrak SOCRATES Plus, top 10 by max probability', retrieved: '2026-10-10T21:20:00Z', rows: real };
}

async function loadSocratesFull() {
  const path = join(DATA, 'socrates-min-range.csv');
  if (!(await exists(path))) return null;
  const [header, ...rows] = parseCsv(await readText(path));
  const find = (...res) => header.findIndex(h => res.every(re => re.test(h.toUpperCase())));
  const c = {
    id1: find(/NORAD|CAT/, /1/), name1: find(/NAME/, /1/), dse1: find(/DSE|EPOCH/, /1/),
    id2: find(/NORAD|CAT/, /2/), name2: find(/NAME/, /2/), dse2: find(/DSE|EPOCH/, /2/),
    tca: header.findIndex(h => /TCA/i.test(h) && !/RANGE|SPEED|VEL/i.test(h)), range: find(/RANGE/), speed: find(/SPEED|VEL/), prob: find(/PROB/),
  };
  const missing = Object.entries(c).filter(([k, v]) => v < 0 && !k.startsWith('dse')).map(([k]) => k);
  if (missing.length) {
    console.warn(`build  SOCRATES CSV: no column for ${missing.join(', ')} in [${header.join(', ')}]; using seed`);
    return null;
  }
  const now = Date.now();
  const parsed = rows.map(r => ({
    a: { id: Number(r[c.id1]), name: r[c.name1]?.trim(), age: c.dse1 >= 0 ? Number(r[c.dse1]) : NaN },
    b: { id: Number(r[c.id2]), name: r[c.name2]?.trim(), age: c.dse2 >= 0 ? Number(r[c.dse2]) : NaN },
    tca: isoZ(r[c.tca]?.trim()),
    rangeKm: Number(r[c.range]), speedKms: Number(r[c.speed]), maxProb: Number(r[c.prob]),
  })).filter(x => Number.isFinite(x.rangeKm) && Number.isFinite(x.maxProb) && x.speedKms > 0.05 && Date.parse(x.tca) > now);
  if (!parsed.length) { console.warn('build  SOCRATES CSV parsed to 0 future rows; using seed'); return null; }
  parsed.sort((x, y) => y.maxProb - x.maxProb || x.rangeKm - y.rangeKm);
  const man = await readJson(join(DATA, 'manifest.json'));
  log('conjunctions', `top 10 of ${parsed.length} from SOCRATES CSV`);
  return {
    source: 'CelesTrak SOCRATES Plus, top 10 by max probability',
    retrieved: man?.files?.['socrates-min-range.csv']?.retrieved_utc ?? new Date().toISOString(),
    rows: parsed.slice(0, 10),
  };
}

// ---------- radio ----------

// SatNOGS transmitters for objects in the snapshot, a few per object.
async function loadRadio(ids) {
  const json = await readJson(join(DATA, 'satnogs-transmitters.json'));
  if (!Array.isArray(json)) return {};
  const out = {};
  const mhz = v => (Number.isFinite(Number(v)) && v ? Math.round(Number(v) / 1e3) / 1e3 : null);
  for (const t of json) {
    const id = Number(t.norad_cat_id);
    if (!ids.has(id) || t.status === 'invalid') continue;
    (out[id] ??= []).push({
      d: String(t.description ?? '').slice(0, 40), dl: mhz(t.downlink_low), ul: mhz(t.uplink_low),
      mode: t.mode ?? '', baud: Number(t.baud) || null, alive: t.alive !== false && t.status !== 'inactive',
    });
  }
  for (const k of Object.keys(out)) out[k] = out[k].sort((a, b) => b.alive - a.alive).slice(0, 6);
  log('radio', Object.keys(out).length, 'objects with SatNOGS transmitters');
  return out;
}

// ---------- space weather ----------

// NOAA products come either as [header, ...rows] arrays or as arrays of objects.
function tableRows(json) {
  if (!Array.isArray(json) || !json.length) return [];
  if (Array.isArray(json[0])) {
    const [h, ...rows] = json;
    return rows.map(r => Object.fromEntries(h.map((k, i) => [k, r[i]])));
  }
  return json;
}
const num = v => (v === null || v === '' || v === undefined ? NaN : Number(v));
const isoZ = t => (t && !/Z$|[+-]\d\d:?\d\d$/.test(t) ? t.replace(' ', 'T') + 'Z' : t);

async function loadKp() {
  const json = await readJson(join(DATA, 'noaa-kp-3h.json'));
  const rows = tableRows(json)
    .map(r => ({ t: isoZ(r.time_tag), kp: num(r.Kp ?? r.kp ?? r.kp_index) }))
    .filter(r => r.t && Number.isFinite(r.kp));
  if (rows.length) { log('kp from data/noaa-kp-3h.json', rows.length); return rows; }
  const [, ...seed] = parseCsv(await readText(join(SEED, 'noaa-kp-3h.csv')));
  log('kp from seed', seed.length);
  return seed.map(r => ({ t: r[0], kp: Number(r[1]) }));
}

function latest(rows, key) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const v = num(rows[i][key]);
    if (Number.isFinite(v)) return { value: v, t: isoZ(rows[i].time_tag) };
  }
  return null;
}

async function loadSolarWind() {
  const seed = await readJson(join(SEED, 'noaa-space-weather-summary.json'));
  const out = {
    speed: { value: seed.solar_wind_speed_km_s.value, t: seed.solar_wind_speed_km_s.time_tag },
    bt: { value: seed.imf_bt_nT.value, t: seed.imf_bt_nT.time_tag },
    bz: { value: seed.imf_bz_gsm_nT.value, t: seed.imf_bz_gsm_nT.time_tag },
    f107: { value: seed.f10_7_cm_flux_sfu.value, t: seed.f10_7_cm_flux_sfu.time_tag },
    speedTrace: [], bzTrace: [],
  };
  const wind = tableRows(await readJson(join(DATA, 'noaa-solar-wind-1m.json')));
  const mag = tableRows(await readJson(join(DATA, 'noaa-imf-1m.json')));
  // rtsw files list several spacecraft per minute; keep the one flagged active when present.
  const act = rows => rows.filter(r => r.active === undefined || r.active === true);
  const w = act(wind).sort((a, b) => String(a.time_tag).localeCompare(String(b.time_tag)));
  const m = act(mag).sort((a, b) => String(a.time_tag).localeCompare(String(b.time_tag)));
  const s = latest(w, 'proton_speed'); if (s) out.speed = s;
  const bt = latest(m, 'bt'); if (bt) out.bt = bt;
  const bz = latest(m, 'bz_gsm'); if (bz) out.bz = bz;
  const trace = (rows, key) => rows.slice(-360).map(r => num(r[key])).filter(Number.isFinite);
  out.speedTrace = trace(w, 'proton_speed');
  out.bzTrace = trace(m, 'bz_gsm');
  log('solar wind', s ? 'from data/' : 'from seed', `(${out.speedTrace.length} trace points)`);
  return out;
}

async function loadScales() {
  const json = await readJson(join(DATA, 'noaa-scales.json'));
  const cur = json?.['0'];
  if (!cur) return { G: 0, S: 0, R: 0, source: 'seed', note: 'Scales lag the 3-hour Kp; check both.' };
  const n = x => Number(x?.Scale) || 0;
  return { G: n(cur.G), S: n(cur.S), R: n(cur.R), t: isoZ(`${cur.DateStamp} ${cur.TimeStamp}`) };
}

async function loadAlerts() {
  const json = await readJson(join(DATA, 'noaa-alerts.json'));
  if (!Array.isArray(json)) return [];
  return json.slice(0, 12).map(a => {
    const msg = String(a.message ?? '');
    const title = (msg.match(/^(ALERT|WARNING|WATCH|SUMMARY|CONTINUED ALERT|EXTENDED WARNING|CANCEL[^:]*):\s*(.+)$/m) ?? [])
      .slice(1).join(': ') || msg.split('\n').find(l => l.trim()) || a.product_id;
    return { t: isoZ(a.issue_datetime), id: a.product_id, title: title.trim().slice(0, 140) };
  });
}

// ---------- coastlines ----------

// Two levels of detail: 110m for the whole globe, 50m loaded once the viewer zooms in close.
function coastlines(res = '110m', step = 0.05) {
  const topo = require(`world-atlas/land-${res}.json`);
  const m = mesh(topo, topo.objects.land);
  const r = v => Math.round(v / step) * step;
  const q = v => Number(r(v).toFixed(3));
  return m.coordinates.map(line => line.flatMap(([lon, lat]) => [q(lon), q(lat)]));
}

// ---------- main ----------

async function sourcesUsed() {
  const man = await readJson(join(DATA, 'manifest.json'));
  const seed = await readJson(join(SEED, 'manifest.json'));
  return {
    fetched: Object.fromEntries(Object.entries(man?.files ?? {}).map(([f, v]) => [f, v.retrieved_utc])),
    seed: Object.keys(seed?.files ?? {}),
  };
}

async function main() {
  await mkdir(join(OUT, 'data'), { recursive: true });

  const [orbits, satcat] = await Promise.all([loadOrbits(), loadSatcat()]);
  const snapshot = {
    generated: new Date().toISOString(),
    fields: OBJ_FIELDS,
    objects: packObjects(orbits, satcat),
    conjunctions: await loadConjunctions(),
    kp: await loadKp(),
    wind: await loadSolarWind(),
    scales: await loadScales(),
    alerts: await loadAlerts(),
    radio: await loadRadio(new Set(orbits.keys())),
    sources: await sourcesUsed(),
  };
  const json = JSON.stringify(snapshot);
  await writeFile(join(OUT, 'data/snapshot.json'), json);
  log('snapshot.json', snapshot.objects.length, 'objects,', (json.length / 1024).toFixed(0), 'KB');

  const coast = JSON.stringify(coastlines());
  await writeFile(join(OUT, 'data/coast.json'), coast);
  log('coast.json', (coast.length / 1024).toFixed(0), 'KB');
  const coastHi = JSON.stringify(coastlines('50m', 0.01));
  await writeFile(join(OUT, 'data/coast-hi.json'), coastHi);
  log('coast-hi.json', (coastHi.length / 1024).toFixed(0), 'KB');

  await build({
    entryPoints: [join(SRC, 'js/main.js')],
    bundle: true, format: 'esm', target: 'es2022', minify: true, sourcemap: true,
    outfile: join(OUT, 'app.js'),
    // satellite.js re-exports a WASM bulk propagator we don't use; keep it out of the bundle.
    external: ['#wasm-single-thread', '#wasm-multi-thread'],
    logLevel: 'warning',
  });
  log('app.js bundled');

  for (const f of ['index.html', 'style.css', 'favicon.svg']) await copyFile(join(SRC, f), join(OUT, f));
  await writeFile(join(OUT, '.nojekyll'), '');
  log('done → dist/');
}

main().catch(e => { console.error(e); process.exit(1); });
