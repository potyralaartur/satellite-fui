# Open satellite data sources

Checked 2026-10-10. URLs below were confirmed to return HTTP 200 on that date.
The join key across almost everything is the **NORAD catalog number** (`NORAD_CAT_ID`).

## 1. Orbits: CelesTrak GP data (the backbone)

- Query: `https://celestrak.org/NORAD/elements/gp.php?{QUERY}=VALUE&FORMAT=csv`
  - `CATNR` one object · `INTDES` everything from a launch (e.g. `2026-226`) · `GROUP` curated
    sets (`active`, `stations`, `visual`, `gps-ops`, `weather`, `starlink`, `amateur`…) ·
    `NAME` substring · `SPECIAL` = `GPZ`, `GPZ-PLUS`, `DECAYING`
  - Formats: `CSV` (default, smallest), `JSON` (~3× CSV), `XML`/`KVN` (OMM), `TLE`/`3LE`/`2LE`
- **Use CSV or JSON, never TLE.** The 5-digit catalog numbers ran out on 2026-07-11; new
  objects get 6-digit numbers (the seed snapshot already contains 100057, 100712, 100882) and
  have no TLE representation.
- Fields (OMM keywords): `OBJECT_NAME, OBJECT_ID, EPOCH, MEAN_MOTION, ECCENTRICITY,
  INCLINATION, RA_OF_ASC_NODE, ARG_OF_PERICENTER, MEAN_ANOMALY, EPHEMERIS_TYPE,
  CLASSIFICATION_TYPE, NORAD_CAT_ID, ELEMENT_SET_NO, REV_AT_EPOCH, BSTAR, MEAN_MOTION_DOT,
  MEAN_MOTION_DDOT`. `satellite.js` `json2satrec()` takes these directly (numbers parsed).
- **Rate rules (enforced):** CelesTrak checks for new data every 2 h; underlying 18 SDS data
  updates 2–3×/day. `active` and `starlink` allow one download per update (repeat → HTTP 403).
  50 HTTP errors in 2 h → IP firewalled. Always stop on non-200. Snapshot at build time,
  propagate client-side.
- Extras: `table.php` with flags `BSTAR`, `SHOW-OPS`, `OLDEST`, `DOCKED`, `MOVERS` (GEO
  drifters); `satcat/lost.php`; `satcat/decayed-with-last.php`; `gp-first.php` (first data for
  a launch/debris event).

## 2. Propagation: satellite.js

- `npm i satellite.js@7.1.0` (MIT). SGP4/SDP4 from TLE or OMM; `eciToGeodetic`, `eciToEcf`,
  `ecfToLookAngles`, `sunPos`, `shadowFraction`, `dopplerFactor`, `checkForDecay`.
- `BulkPropagator` (WASM) for whole catalogs, 3–12× faster than a JS loop; single- and
  multi-thread runtimes.
- GP/SGP4 accuracy is ~km and degrades over days from epoch. Fine for visualisation, not for
  operations. Show element age (`now − EPOCH`) as a data-quality channel.

## 3. Catalog metadata

| Source | URL | Size | Notes |
|---|---|---|---|
| CelesTrak SATCAT | `https://celestrak.org/pub/satcat.csv` | ~7 MB | owner, launch date/site, object type, ops status, decay date, RCS |
| GCAT satcat | `https://planet4589.org/space/gcat/tsv/cat/satcat.tsv` | ~19 MB | J. McDowell; every object since 1957 incl. failed-to-orbit, deep space; CC-BY |
| GCAT psatcat | `https://planet4589.org/space/gcat/tsv/cat/psatcat.tsv` | ~5 MB | payload catalog: mission, program, class |
| GCAT tables | `.../tsv/tables/orgs.tsv`, `sites.tsv`, `lv.tsv`, `launch/launch.tsv` | small | organisations, launch sites, vehicles, launch list |

GCAT citation: "data from GCAT (J. McDowell, planet4589.org/space/gcat)".

## 4. Close approaches: CelesTrak SOCRATES Plus

- Screens the full public catalog 3×/day, conjunctions for the next 7 days.
- Top-10 tables (HTML): `https://celestrak.org/SOCRATES/table-socrates.php?NAME=,&ORDER=MAXPROB&MAX=10`
  (or `ORDER=MINRANGE`).
- Full CSV: `https://celestrak.org/SOCRATES/sort-minRange.csv` (~22 MB; format doc at
  `/SOCRATES/socrates-format.php`).
- Per event: two NORAD IDs + names + ops status, days since epoch, TCA, min range (km),
  relative speed (km/s), max probability, dilution threshold.
- **Label honestly:** "max probability" is a conservative upper bound; operator Pc is usually far
  lower. Filter docked pairs (relative speed ≈ 0), which show up as false "conjunctions".

## 5. Decays and reentries

- `gp.php?SPECIAL=DECAYING` · `satcat/decayed-with-last.php` · rising `BSTAR` / `MEAN_MOTION_DOT`
  (CelesTrak sorts Starlink by BSTAR to spot disposal lowering).

## 6. Radio: SatNOGS (Libre Space Foundation)

| Endpoint | Size | Content |
|---|---|---|
| `https://db.satnogs.org/api/satellites/?format=json` | ~1.5 MB, 2,832 entries | sat_id, norad_cat_id, names, status, operator, countries, launched/deployed/decayed, image |
| `https://db.satnogs.org/api/transmitters/?format=json` | ~3.9 MB, 5,114 entries | uplink/downlink frequencies, drift, mode, baud, alive, type |
| `https://network.satnogs.org/api/observations/` | paged | per pass: station, times, waterfall PNG, audio, demodulated frames |

Licence CC-BY-SA 4.0. Read access needs no key; be gentle (paged, rate-limited). Real waterfalls
are excellent FUI texture.

## 7. Space weather: NOAA SWPC (public domain)

| File | URL |
|---|---|
| Kp 3-hourly, 7 days | `https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json` |
| Kp estimated, 1-min | `https://services.swpc.noaa.gov/json/planetary_k_index_1m.json` |
| Kp 3-day forecast | `https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json` |
| Dst (Kyoto) | `https://services.swpc.noaa.gov/products/kyoto-dst.json` |
| Solar wind L1, 1-min | `https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json` |
| IMF L1, 1-min | `https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json` |
| G/S/R scales | `https://services.swpc.noaa.gov/products/noaa-scales.json` |
| Alerts/warnings text | `https://services.swpc.noaa.gov/products/alerts.json` |
| One-value summaries | `https://services.swpc.noaa.gov/products/summary/solar-wind-speed.json`, `solar-wind-mag-field.json`, `10cm-flux.json` |

Note: the old `products/solar-wind/*-7-day.json` and
`products/noaa-estimated-planetary-k-index-1-minute.json` paths now return 404.
Storms raise thermospheric density → more drag → faster decay in LEO, so this layer can
legitimately drive the decay story.

## 8. Space-Track.org (upstream)

Free account; full GP history, decay/TIP messages, CDMs for operators. Redistribution terms
apply, so for a public page prefer CelesTrak + GCAT.
