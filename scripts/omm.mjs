// Load CelesTrak GP CSV (OMM keywords) into objects satellite.js can propagate.
// CSV is CelesTrak's own working format and a third the size of the JSON; fields are the same.

import { readFile } from 'node:fs/promises';

const NUMERIC = new Set([
  'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER',
  'MEAN_ANOMALY', 'EPHEMERIS_TYPE', 'NORAD_CAT_ID', 'ELEMENT_SET_NO', 'REV_AT_EPOCH',
  'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT',
]);

// Minimal CSV parser: handles quoted fields (some object names contain commas).
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function csvToOmm(text) {
  const [header, ...rows] = parseCsv(text);
  return rows.map(r => Object.fromEntries(header.map((k, i) =>
    [k, NUMERIC.has(k) ? Number(r[i]) : r[i]])));
}

export async function loadOmm(path) {
  return csvToOmm(await readFile(path, 'utf8'));
}
