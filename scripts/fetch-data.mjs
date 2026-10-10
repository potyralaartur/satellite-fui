#!/usr/bin/env node
// Downloads the open satellite datasets into ./data and records what it got in data/manifest.json.
//
//   node scripts/fetch-data.mjs                 fetch everything that is stale
//   node scripts/fetch-data.mjs --only=noaa     only one source group (celestrak, gcat, satnogs, noaa)
//   node scripts/fetch-data.mjs --socrates-full also grab the full SOCRATES CSV (~22 MB)
//
// Rules this script follows (CelesTrak blocks clients that ignore them):
//   * each file has a max age; a file younger than that is never re-downloaded
//   * CelesTrak GP data: at most once every 2 hours, one download per update
//   * any non-200 response from a host stops all further requests to that host for this run
//   * nothing is overwritten unless the new download succeeded
//
// Needs Node 18+ (global fetch). No dependencies.

import { mkdir, stat, writeFile, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const HOUR = 3600e3, DAY = 24 * HOUR;

const args = new Set(process.argv.slice(2));
const only = [...args].find(a => a.startsWith('--only='))?.split('=')[1];

const SOURCES = [
  // group, file, url, maxAge, licence / credit
  ['celestrak', 'celestrak-active.csv',
    'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=csv', 2 * HOUR,
    'CelesTrak GP data (18 SDS via Space-Track). Free; respect https://celestrak.org/usage-policy.php'],
  ['celestrak', 'celestrak-visual.csv',
    'https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=csv', 2 * HOUR,
    'CelesTrak — ~150 brightest objects, a good small set for a hero scene'],
  ['celestrak', 'celestrak-decaying.csv',
    'https://celestrak.org/NORAD/elements/gp.php?SPECIAL=DECAYING&FORMAT=csv', 2 * HOUR,
    'CelesTrak — objects with potential near-term decay'],
  ['celestrak', 'celestrak-satcat.csv',
    'https://celestrak.org/pub/satcat.csv', DAY,
    'CelesTrak SATCAT — owner, launch, type, ops status, RCS (~7 MB)'],
  ['gcat', 'gcat-satcat.tsv',
    'https://planet4589.org/space/gcat/tsv/cat/satcat.tsv', 7 * DAY,
    'GCAT, J. McDowell, planet4589.org/space/gcat — CC-BY, cite when used (~19 MB)'],
  ['gcat', 'gcat-psatcat.tsv',
    'https://planet4589.org/space/gcat/tsv/cat/psatcat.tsv', 7 * DAY,
    'GCAT payload catalog (mission, owner, class) — CC-BY'],
  ['satnogs', 'satnogs-satellites.json',
    'https://db.satnogs.org/api/satellites/?format=json', DAY,
    'SatNOGS DB, Libre Space Foundation — CC-BY-SA 4.0'],
  ['satnogs', 'satnogs-transmitters.json',
    'https://db.satnogs.org/api/transmitters/?format=json', DAY,
    'SatNOGS DB transmitters (frequencies, modes) — CC-BY-SA 4.0'],
  ['noaa', 'noaa-kp-3h.json',
    'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json', 10 * 60e3,
    'NOAA SWPC — public domain, credit NOAA SWPC'],
  ['noaa', 'noaa-kp-1m.json',
    'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json', 10 * 60e3,
    'NOAA SWPC estimated Kp, 1-minute cadence'],
  ['noaa', 'noaa-kp-forecast.json',
    'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json', 10 * 60e3,
    'NOAA SWPC 3-day Kp forecast'],
  ['noaa', 'noaa-dst.json',
    'https://services.swpc.noaa.gov/products/kyoto-dst.json', 10 * 60e3,
    'Kyoto Dst (ring-current storm index) via NOAA SWPC'],
  ['noaa', 'noaa-solar-wind-1m.json',
    'https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json', 10 * 60e3,
    'NOAA SWPC real-time solar wind (L1): density, speed, temperature'],
  ['noaa', 'noaa-imf-1m.json',
    'https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json', 10 * 60e3,
    'NOAA SWPC real-time IMF (L1): Bx, By, Bz, Bt'],
  ['noaa', 'noaa-scales.json',
    'https://services.swpc.noaa.gov/products/noaa-scales.json', 10 * 60e3,
    'NOAA space weather scales (G/S/R) now and forecast'],
  ['noaa', 'noaa-alerts.json',
    'https://services.swpc.noaa.gov/products/alerts.json', 10 * 60e3,
    'NOAA SWPC alerts, watches and warnings (text) — good log-panel material'],
];
if (args.has('--socrates-full')) {
  SOURCES.push(['celestrak', 'socrates-min-range.csv',
    'https://celestrak.org/SOCRATES/sort-minRange.csv', 8 * HOUR,
    'CelesTrak SOCRATES Plus — all conjunctions, next 7 days (~22 MB)']);
}

const UA = 'satellite-fui-snapshot/1.0 (personal design project)';
const blockedHosts = new Set();

async function ageMs(path) {
  try { return Date.now() - (await stat(path)).mtimeMs; } catch { return Infinity; }
}

async function readManifest() {
  try { return JSON.parse(await readFile(join(DATA, 'manifest.json'), 'utf8')); }
  catch { return { files: {} }; }
}

async function main() {
  await mkdir(DATA, { recursive: true });
  const manifest = await readManifest();
  let fetched = 0, skipped = 0, failed = 0;

  for (const [group, file, url, maxAge, credit] of SOURCES) {
    if (only && group !== only) continue;
    const host = new URL(url).host;
    const path = join(DATA, file);
    const age = await ageMs(path);

    if (age < maxAge) {
      console.log(`skip   ${file.padEnd(32)} ${(age / 60e3).toFixed(0)} min old (max ${(maxAge / 60e3).toFixed(0)})`);
      skipped++; continue;
    }
    if (blockedHosts.has(host)) {
      console.log(`stop   ${file.padEnd(32)} ${host} returned an error earlier in this run`);
      failed++; continue;
    }

    process.stdout.write(`fetch  ${file.padEnd(32)} `);
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'manual' });
    } catch (e) {
      console.log(`network error: ${e.message}`);
      blockedHosts.add(host); failed++; continue;
    }
    if (res.status !== 200) {
      const body = (await res.text().catch(() => '')).slice(0, 300).replace(/\s+/g, ' ');
      console.log(`HTTP ${res.status} — stopping requests to ${host}. ${body}`);
      blockedHosts.add(host); failed++; continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const head = buf.subarray(0, 200).toString('utf8');
    if (buf.length < 50 || /No GP data found/i.test(head)) {
      console.log(`empty or unexpected response (${buf.length} B): ${head.slice(0, 80)}`);
      failed++; continue;
    }
    await writeFile(path + '.part', buf);
    await rename(path + '.part', path);
    manifest.files[file] = {
      url, credit, retrieved_utc: new Date().toISOString(), bytes: buf.length,
    };
    console.log(`${(buf.length / 1024).toFixed(0)} KB`);
    fetched++;
  }

  manifest.updated_utc = new Date().toISOString();
  await writeFile(join(DATA, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`\n${fetched} fetched, ${skipped} fresh, ${failed} failed. Manifest: data/manifest.json`);
  if (failed) process.exitCode = 1;
}

main();
