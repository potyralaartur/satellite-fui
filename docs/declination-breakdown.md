# How DECLINATION is built

Reference: https://uispace.org/declination.html, "DECLINATION, Geomagnetic Observatory 1",
SCENESCAPES Channel 64, by Annas Rahman. Inspected 2026-10-10 in Chrome (DOM, computed styles,
module source).

## Stack

- No framework, no WebGL, no SVG, no chart library.
- One plain ES module, `scenescapes/declination.js` (~165 KB). It imports four tiny helpers from
  an in-house kit shared by every SCENESCAPES page: `/lib/fui/palette.js`, `rng.js` (seeded),
  `press-any-key.js`, `nav.js` (prev/next channel).
- Five Canvas 2D surfaces: hero field (`dc-hero`), compass strip, magnetogram, dipole curve,
  pole-tracks map.
- All tables and readouts are real DOM text, updated via `textContent` / `classList`. Crisp,
  selectable, laid out by CSS.
- `scenescape-fit.js` runs before first paint: scales the fixed composition on phones (~0.29 on a
  portrait iPhone) and hides the fullscreen button where it cannot work.
- Vercel hosting; full OG / JSON-LD; screen-reader-only `h1` + `p` describe the scene.

## One model drives every view

The source header says it directly: the hero is a field, not a panel, and every reading lives
on or in it. Three simulated layers:

1. **Field.** A degree-3 spherical-harmonic Gauss model (15 coefficients, the maths behind
   Earth's IGRF) plus six shallow flux-patch dipoles. `fieldAt(x,y,z)` evaluates B analytically.
   Each "solve" refits one patch so one pole drifts ~200 km; the solve table was precomputed
   offline and verified to keep exactly 6 poles / 4 saddles.
2. **External.** A storm at the observatory: ring-current depression, substorm bays, Sq,
   pulsations → magnetogram X/Y/Z and the live compass needle.
3. **Fleet.** 437 ships, 18 ports; their declination errors come from the same field.

Every number on screen is derived, so every number agrees with every other.

## Hero rendering

- **Field lines integrated live:** `traceLine` = RK4 along the normalised field direction from
  320 footpoints, step size growing with radius.
- **Time-sliced work:** `traceWork` runs on an interval with a millisecond budget (9 ms, later
  3 ms), pre-traces the next solve while the current one shows, and pauses during "money shot"
  beats so those frames never stutter.
- **Hand-written 3D:** `project()` is a pinhole camera (position, forward/right/up, focal length);
  `occluded` / `facing` fade lines behind the disc.
- **Glow without filters:** `globalCompositeOperation = 'lighter'`; segments bucketed by
  brightness into one `Path2D` per level, so a handful of strokes instead of thousands. Two passes
  per level: wide tinted underlay, thin core pushed toward white. Strongest levels "breathe" on a
  6.5 s sine.
- **Colour = meaning:** outbound legs white→ice, return legs deep blue, weak/far lines violet;
  brightness ∝ log |B| at the footpoint.

## Animation and performance

- Four `requestAnimationFrame` loops, each throttled to its own fps (hero 30, cut 20, mag 30,
  tracks 30). Nine `setInterval` ticks for slow updates (clock, needle, log, row scan, legend).
- A `gen` counter kills stale loops on restart.
- Honours `prefers-reduced-motion`, pauses on `visibilitychange`, caps backing-store ratio at
  `min(2, devicePixelRatio × fitScale)`.
- Seeded RNG + scripted timeline of beats and cuts: edited like a film, not a dashboard.

## Layout and styling

- No CSS grid: every region is `position: absolute` in a fixed root, sized with `clamp()` on
  `--rootH` / `--rootW`, which JS writes after measuring (e.g. bottom band
  `clamp(150px, 26% of height, 290px)`).
- Palette module writes `--p-*-rgb` triplets; inks derive as `rgba(var(--p-text-rgb), 0.8)`. The
  same tokens are read into JS for canvas, so DOM and canvas never drift.
- Space Grotesk for labels, Space Mono for data. (The site loads ~15 other families the scene
  doesn't use.)

## Reusable takeaways

1. A real model underneath, so every figure is consistent.
2. Colour and brightness mapped to data meaning, not decoration.
3. Canvas for dense/animated; DOM for anything read.
4. Additive two-pass strokes = cheapest "light on glass" look in Canvas 2D.
5. Budgeted, pre-computed work so hero beats never drop frames.
