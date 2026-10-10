# satellite-fui

Open data and reference notes for a cinematic FUI satellite-tracking scene, modelled on how
[DECLINATION](https://uispace.org/declination.html) (SCENESCAPES ch. 64) is built.

The idea in one line: **one real model drives every view.** Public orbital elements + the SGP4
propagator give every position, ground track, pass and close approach. Catalog, conjunction,
radio and space-weather data hang off the same NORAD catalog numbers.

## Quick start

```bash
cd ~/src/satellite-fui
npm install                  # satellite.js 7.1.0
npm run demo                 # propagates the seed snapshot to "now", prints lat/lon/alt + look angles from Kraków
npm run fetch-data           # downloads the full datasets into data/ (run from your own Terminal)
node scripts/propagate-demo.mjs data/celestrak-visual.csv
```

`fetch-data` is polite by design: every file has a max age, CelesTrak is hit at most once per
2 hours per file, and any error from a host stops further requests to it. Run it whenever you
want fresh data; running it twice in a row does nothing the second time.

## What's here

```
data/
  seed-2026-10-10/            live snapshot taken 2026-10-10 ~21:20 UTC (works offline, no fetch needed)
    celestrak-stations.csv      22 objects: ISS, CSS, docked vehicles, recent deployments (OMM keywords)
    noaa-kp-3h.csv              7 days of planetary Kp; a Kp 7 storm was under way at snapshot time
    noaa-space-weather-summary.json   solar wind 761 km/s, Bt 16 nT, F10.7 126
    socrates-top10-maxprob.csv  top 10 predicted conjunctions (headline: Starlink vs Cosmos 2251 debris, 7 m)
    manifest.json               sources, credits, caveats
  (fetch-data writes the full files here + manifest.json)
docs/
  declination-breakdown.md    how the reference scene is engineered
  data-sources.md             every source: URL, format, size, update rate, licence, gotchas
  scene-concept.md            how the data maps onto a DECLINATION-style scene
scripts/
  fetch-data.mjs              downloader (Node 18+, no deps)
  omm.mjs                     GP CSV -> OMM objects for satellite.js
  propagate-demo.mjs          SGP4 smoke test
```

## Using it in a Claude Project

Add `README.md`, the three files in `docs/` and `data/seed-2026-10-10/manifest.json` as project
knowledge. They are written to stand alone. The large data files are better kept in the code
folder than uploaded.

## Credits (required by the licences)

- Orbital data and SOCRATES: CelesTrak (celestrak.org), from 18 SDS / Space-Track
- GCAT: data from GCAT (J. McDowell, planet4589.org/space/gcat), CC-BY
- SatNOGS DB: Libre Space Foundation, CC-BY-SA 4.0
- Space weather: NOAA Space Weather Prediction Center
- SGP4 in JS: satellite.js (MIT)
