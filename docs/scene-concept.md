# Scene concept: a DECLINATION-style satellite tracker

Working rule borrowed from DECLINATION: the hero is the orbital shell itself, not a panel,
and every reading on screen is computed from the same element sets.

## The model

- **Orbits:** CelesTrak GP snapshot → satellite.js SGP4 (WASM `BulkPropagator` for thousands
  of objects). Deterministic: fix the snapshot + a seeded clock and the scene replays identically.
- **Joins by NORAD ID:** SATCAT/GCAT (owner, type, launch), SOCRATES (pairs), SatNOGS
  (transmitters, waterfalls), DECAYING list.
- **Environment:** NOAA Kp / Dst / solar wind drive a drag-haze layer in LEO and the log.

## Hero

- Small dark Earth (≤ ~22 % of frame height, like DECLINATION's disc), hand-rolled pinhole
  camera, Canvas 2D.
- Orbits as additive two-pass strokes bucketed by brightness into a few `Path2D`s.
- Ink by meaning: payloads one family, rocket bodies another, debris a third; brightness =
  element freshness (fresh = bright, a week old = dim). Ops status from SATCAT (`+`, `P`, `-`).
- Debris clouds as point fields (e.g. `NAME=COSMOS 2251 DEB`, `FENGYUN 1C DEB`).
- Selected pair from SOCRATES drawn with both tracks converging on TCA, miss distance labelled.

## Panels (DOM text, CSS layout)

- **Conjunction table:** top-N by max probability, TCA countdown, min range, rel speed. Seed
  headline: STARLINK-4429 vs COSMOS 2251 DEB, 7 m at 13.95 km/s, 2026-10-13 05:09 UTC.
- **Decay watch:** DECAYING list, BSTAR trend, predicted window.
- **Space weather strip:** Kp bars (seed has a Kp 7 storm on 2026-10-10), solar wind speed /
  Bz trace, G-scale badge.
- **Pass predictor:** next passes over an observer (Kraków 50.06° N 19.94° E) with
  az/el; from `ecfToLookAngles`.
- **Radio:** SatNOGS transmitters for the selected object; a real waterfall PNG for texture.
- **Log:** NOAA alerts text + derived events (new launch catalogued, object decayed, conjunction
  entered 24 h window).
- **Census:** counts by type/orbit regime from SATCAT/GCAT; boxscore-style.

## Caveats to design for

- Docked vehicles share elements: group them (ISS and its visitors) instead of stacking dots.
- SOCRATES false positives from docked pairs: drop rel speed ≈ 0.
- "Max probability" is an upper bound; label it so.
- Element age matters; never pretend sub-km precision.
