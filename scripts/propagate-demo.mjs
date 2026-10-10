#!/usr/bin/env node
// Smoke test: propagate every object in a GP CSV to "now" with SGP4 and print where it is,
// plus look angles from an observer (default Kraków).
//
//   npm install
//   node scripts/propagate-demo.mjs                                   uses the seed snapshot
//   node scripts/propagate-demo.mjs data/celestrak-visual.csv         after fetch-data
//   node scripts/propagate-demo.mjs data/seed-2026-10-10/celestrak-stations.csv 2026-10-11T00:00:00Z

import * as satellite from 'satellite.js';
import { loadOmm } from './omm.mjs';

const file = process.argv[2] ?? new URL('../data/seed-2026-10-10/celestrak-stations.csv', import.meta.url).pathname;
const when = process.argv[3] ? new Date(process.argv[3]) : new Date();
const observer = { latitude: satellite.degreesToRadians(50.06), longitude: satellite.degreesToRadians(19.94), height: 0.22 };

const omms = await loadOmm(file);
const gmst = satellite.gstime(when);
console.log(`${omms.length} objects from ${file}\nepoch of view: ${when.toISOString()}\n`);
console.log('NAME'.padEnd(24), 'NORAD'.padStart(7), '  LAT°'.padStart(8), '  LON°'.padStart(8), ' ALT km'.padStart(8), '  AZ°'.padStart(7), '  EL°'.padStart(7), ' AGE d');

for (const omm of omms) {
  const rec = satellite.json2satrec(omm);
  const pv = satellite.propagate(rec, when);
  if (!pv || !pv.position || rec.error) {
    console.log(omm.OBJECT_NAME.padEnd(24), String(omm.NORAD_CAT_ID).padStart(7), '  propagation error', rec.error);
    continue;
  }
  const gd = satellite.eciToGeodetic(pv.position, gmst);
  const look = satellite.ecfToLookAngles(observer, satellite.eciToEcf(pv.position, gmst));
  const ageDays = (when - new Date(omm.EPOCH + 'Z')) / 864e5;
  console.log(
    omm.OBJECT_NAME.slice(0, 24).padEnd(24),
    String(omm.NORAD_CAT_ID).padStart(7),
    satellite.degreesLat(gd.latitude).toFixed(2).padStart(8),
    satellite.degreesLong(gd.longitude).toFixed(2).padStart(8),
    gd.height.toFixed(0).padStart(8),
    satellite.radiansToDegrees(look.azimuth).toFixed(1).padStart(7),
    satellite.radiansToDegrees(look.elevation).toFixed(1).padStart(7),
    ageDays.toFixed(1).padStart(6),
  );
}
