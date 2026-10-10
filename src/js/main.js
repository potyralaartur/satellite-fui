import { loadSnapshot, search } from './data.js';
import { Scene, readPalette } from './scene.js';
import { stateOf, predictPasses, observerFrom, eciAt } from './orbit.js';
import { skyPositions, drawSky } from './sky.js';
import { renderObject, renderPasses, renderConjunctions, renderWeather, renderCensus, renderDecay, fmt } from './panels.js';
import { Log } from './log.js';

const $ = id => document.getElementById(id);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const FPS = 30;

// ---------- clock (real time, or warped) ----------
const clock = { real0: Date.now(), sim0: Date.now(), warp: 1 };
const simNow = () => new Date(clock.sim0 + (Date.now() - clock.real0) * clock.warp);
function setWarp(w) {
  const now = w === 1 ? new Date() : simNow(); // LIVE snaps back to the real time
  clock.real0 = Date.now(); clock.sim0 = now.getTime(); clock.warp = w;
  document.querySelectorAll('[data-warp]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.warp) === w)));
}

// ---------- observer ----------
const KRAKOW = observerFrom(50.06, 19.94, 0.22, 'Kraków');
function loadObserver() {
  try {
    const s = JSON.parse(localStorage.getItem('observer') || 'null');
    if (s && Number.isFinite(s.lat) && Number.isFinite(s.lon)) return observerFrom(s.lat, s.lon, 0.2, s.label || 'You');
  } catch { /* storage unavailable */ }
  return KRAKOW;
}
let observer = loadObserver();

// How much of the canvas the right column and bottom strip cover (zero when they don't overlay it).
function hudInsets() {
  const side = document.querySelector('.side');
  if (getComputedStyle(side).position !== 'absolute') return {};
  const c = $('hero').getBoundingClientRect();
  const s = side.getBoundingClientRect(), b = document.querySelector('.band').getBoundingClientRect();
  return { top: 0, right: Math.max(0, c.right - s.left), bottom: Math.max(0, c.bottom - b.top), left: 0 };
}

// One-shot highlight: the element snaps white and eases back.
function flash(el) {
  if (!el || reducedMotion) return;
  el.classList.remove('hot-flash'); void el.offsetWidth; el.classList.add('hot-flash');
}

async function main() {
  const world = await loadSnapshot();
  const { snap, objects, byId, radio } = world;
  const pal = readPalette();
  let selected = null, passes = [], passesFor = null, conjIdx = -1;

  const scene = new Scene($('hero'), world, {
    getObserver: () => observer,
    onSelect: o => select(o),
    reducedMotion,
    getInsets: hudInsets,
  });

  // ---------- selection ----------
  function select(o, { fromHash = false, zoom = true } = {}) {
    selected = o?.leader ?? null;
    scene.select(selected, { zoom });
    passesFor = null;
    if (!fromHash) history.replaceState(null, '', selected ? `#${selected.id}` : location.pathname);
    refreshObject(true);
  }

  function refreshObject(force) {
    const now = simNow();
    renderObject(selected, selected && stateOf(selected, now, observer), (selected && radio[selected.id]) || []);
    const stale = passes.length && now.getTime() > passes[0].stop;
    if (force || passesFor !== selected || stale) {
      passes = selected ? predictPasses(selected, observer, now) : [];
      if (passesFor !== selected && selected) logPass();
      passesFor = selected;
    }
    renderPasses(passes, now.getTime(), selected);
  }

  // ---------- conjunctions ----------
  function pickConjunction(i) {
    const c = snap.conjunctions.rows[i];
    if (conjIdx === i) { conjIdx = -1; scene.setConjunction(null); drawConj(); return; }
    conjIdx = i;
    const a = byId.get(c.a.id), b = byId.get(c.b.id);
    if (a && b) {
      const tca = new Date(c.tca);
      scene.setConjunction({ a, b, tca: c.tca, label: `${fmt.utcShort(tca)} UTC · ${fmt.km(c.rangeKm)}` });
      select(a);
    } else {
      scene.setConjunction(null);
      if (a || b) select(a || b);
    }
    drawConj();
    if (!(a && b)) $('conj-note').textContent =
      `Orbits for ${[!a && c.a.name, !b && c.b.name].filter(Boolean).join(' and ')} aren't in this snapshot, so the pair can't be drawn.`;
  }
  const drawConj = () => { renderConjunctions(snap.conjunctions, simNow().getTime(), conjIdx, pickConjunction); scanStep(false); };

  // The countdown to the next close approach in the top bar.
  function nextTca() {
    const now = simNow().getTime();
    const c = snap.conjunctions.rows.filter(r => Date.parse(r.tca) > now).sort((x, y) => Date.parse(x.tca) - Date.parse(y.tca))[0];
    $('tb-tca').textContent = c ? fmt.dur(Date.parse(c.tca) - now) : '--';
    $('tb-tca').className = `big${c && c.rangeKm < 0.1 ? ' alarm' : ''}`;
    $('tb-tca-sub').textContent = c ? `TCA ${c.a.name.slice(0, 14)} · ${fmt.km(c.rangeKm)}` : 'NO UPCOMING TCA';
  }

  // The verification cursor: steps down the close-approach and decay tables a row at a time.
  let scanI = 0;
  function scanStep(advance) {
    if (reducedMotion) return;
    if (advance) scanI++;
    for (const id of ['conj', 'decay']) {
      const rows = $(id).rows;
      for (let i = 0; i < rows.length; i++) rows[i].classList.toggle('scan', i === scanI % rows.length);
    }
  }
  setInterval(() => scanStep(true), 1100);

  // ---------- log ----------
  // The snapshot's own events stream in first, oldest to newest; after that the feed is live:
  // selections, rises and sets over the observer, and the tour's cuts.
  const log = new Log($('log'), { reducedMotion, onCount: n => { $('log-tag').textContent = `${n} EVENTS · LIVE`; } });
  {
    const out = [];
    for (const a of snap.alerts) out.push({ t: Date.parse(a.t), tag: 'NOAA', text: a.title, cls: 'warn' });
    let prevG = 0;
    for (const r of snap.kp) {
      const g = Math.max(0, Math.round(r.kp) - 4);
      if (g > prevG) out.push({ t: Date.parse(r.t), tag: `STORM G${g}`, text: `Kp ${r.kp.toFixed(2)}, geomagnetic storm`, cls: g >= 3 ? 'hot' : 'warn' });
      prevG = g;
    }
    const newest = objects.reduce((m, o) => (o.intl > (m?.intl ?? '') ? o : m), null);
    if (newest) out.push({ t: Date.parse(snap.generated), tag: 'LAUNCH', text: `newest catalogued ${newest.intl} ${newest.name}`, cls: 'cool' });
    const freshest = objects.reduce((m, o) => Math.max(m, o.epoch), 0);
    out.push({ t: freshest, tag: 'EPOCH', text: `newest element set, ${objects.length.toLocaleString()} loaded`, cls: 'ok' });
    for (const c of snap.conjunctions.rows.slice(0, 3)) {
      out.push({ t: Date.parse(c.tca), tag: 'TCA', text: `${c.a.name} / ${c.b.name} ${fmt.km(c.rangeKm)} at ${c.speedKms.toFixed(1)} km/s`, cls: 'hot' });
    }
    out.sort((x, y) => x.t - y.t).forEach(e => log.push(e));
  }
  function logPass() {
    const p = passes[0];
    log.push(p
      ? { t: simNow().getTime(), tag: 'PASS', text: `${selected.name} rises ${fmt.local(p.start)}, max ${p.maxEl.toFixed(0)}°${p.visible ? ', visible' : ''}`, cls: 'ok' }
      : { t: simNow().getTime(), tag: 'TRACK', text: `${selected.name}, no pass above 10° in 48 h` });
  }

  // ---------- search ----------
  const q = $('q'), results = $('q-results');
  let hits = [], cursor = 0;
  const showResults = () => {
    results.hidden = !hits.length;
    results.innerHTML = hits.map((o, i) =>
      `<li role="option" data-i="${i}" aria-selected="${i === cursor}"><span>${o.name.replace(/</g, '&lt;')}</span><span class="id">${o.id}</span></li>`).join('');
  };
  const choose = o => { if (o) select(o); q.value = ''; hits = []; showResults(); q.blur(); };
  q.addEventListener('input', () => { hits = search(objects, q.value); cursor = 0; showResults(); });
  q.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { cursor = Math.min(hits.length - 1, cursor + 1); showResults(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { cursor = Math.max(0, cursor - 1); showResults(); e.preventDefault(); }
    if (e.key === 'Enter') choose(hits[cursor]);
    if (e.key === 'Escape') { hits = []; showResults(); }
  });
  results.addEventListener('pointerdown', e => { const li = e.target.closest('li'); if (li) { e.preventDefault(); choose(hits[Number(li.dataset.i)]); } });
  q.addEventListener('blur', () => setTimeout(() => { hits = []; showResults(); }, 150));

  // ---------- controls ----------
  document.querySelectorAll('[data-warp]').forEach(b => b.addEventListener('click', () => { setWarp(Number(b.dataset.warp)); refreshObject(true); drawConj(); }));
  document.querySelectorAll('[data-type]').forEach(b => b.addEventListener('click', () => {
    const on = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(on));
    scene.toggleType(b.dataset.type, on);
  }));
  const views = document.querySelectorAll('[data-view]');
  views.forEach(b => b.addEventListener('click', () => {
    scene.zoomTo(Number(b.dataset.view));
    views.forEach(v => v.setAttribute('aria-pressed', String(v === b)));
  }));
  const setObserver = o => {
    observer = o;
    const mine = o !== KRAKOW;
    const name = mine ? 'YOU' : 'KRAKÓW';
    $('obs-name').textContent = $('sky-obs').textContent = $('obs-log').textContent = $('tb-obs-name').textContent = name;
    $('tb-obs').textContent = `${Math.abs(o.latDeg).toFixed(2)}° ${o.latDeg >= 0 ? 'N' : 'S'} ${Math.abs(o.lonDeg).toFixed(2)}° ${o.lonDeg >= 0 ? 'E' : 'W'}`;
    $('locate').textContent = mine ? 'RESET TO KRAKÓW' : 'USE MY LOCATION';
    refreshObject(true);
  };
  $('locate').addEventListener('click', () => {
    if (observer !== KRAKOW) {
      try { localStorage.removeItem('observer'); } catch { /* ignore */ }
      setObserver(KRAKOW);
      return;
    }
    if (!navigator.geolocation) { $('locate').textContent = 'LOCATION UNAVAILABLE'; return; }
    $('locate').textContent = 'LOCATING…';
    navigator.geolocation.getCurrentPosition(pos => {
      const lat = Math.round(pos.coords.latitude * 100) / 100, lon = Math.round(pos.coords.longitude * 100) / 100;
      try { localStorage.setItem('observer', JSON.stringify({ lat, lon, label: 'You' })); } catch { /* ignore */ }
      setObserver(observerFrom(lat, lon, 0.2, 'You'));
    }, () => { $('locate').textContent = 'LOCATION UNAVAILABLE'; }, { timeout: 10000 });
  });

  if (observer !== KRAKOW) setObserver(observer);

  // ---------- static panels ----------
  const leaders = objects.filter(o => o.leader === o).length;
  $('hud-count').textContent = leaders.toLocaleString();
  $('tb-count').textContent = leaders.toLocaleString();
  $('tb-sets').textContent = objects.length.toLocaleString();
  $('hud-data').textContent = `${snap.generated.slice(0, 16).replace('T', ' ')} UTC`;
  renderCensus(objects);
  renderDecay(objects, Date.now(), o => select(o));
  renderWeather(snap, pal);
  drawConj();
  window.addEventListener('resize', () => renderWeather(snap, pal));

  const fromHash = () => {
    const id = Number(location.hash.slice(1));
    const o = byId.get(id);
    if (o) select(o, { fromHash: true });
  };
  window.addEventListener('hashchange', fromHash);
  if (byId.has(Number(location.hash.slice(1)))) fromHash();
  else select(byId.get(25544) ?? objects[0], { zoom: false });

  // ---------- loops ----------
  let last = performance.now(), running = true, first = true;
  const loop = now => {
    if (!running) return;
    requestAnimationFrame(loop);
    const dt = now - last;
    if (dt < 1000 / FPS - 2) return;
    last = now;
    scene.frame(simNow(), clock.warp, Math.min(dt, 100));
    if (first) { $('loading').classList.add('done'); first = false; }
  };
  requestAnimationFrame(loop);
  document.addEventListener('visibilitychange', () => {
    running = !document.hidden;
    if (running) { last = performance.now(); requestAnimationFrame(loop); }
  });
  setInterval(() => {
    if (document.hidden) return;
    $('clock-utc').textContent = fmt.utc(simNow());
    refreshObject(false);
    nextTca();
    scanStep(false);
  }, 500);
  setInterval(() => { if (!document.hidden) drawConj(); }, 15000);
  // Timeline beats: every 9 s one top-bar figure is re-read and flashes.
  const figs = ['tb-count', 'tb-sky', 'tb-kp', 'tb-tca'];
  let fig = 0;
  setInterval(() => { if (!document.hidden) flash($(figs[fig++ % figs.length])); }, 9000);

  // ---------- sky strip ----------
  let prevAbove = null;
  const drawSkyNow = () => {
    if (document.hidden) return;
    const now = simNow();
    const above = skyPositions(scene, observer, now);
    $('sky-tag').textContent = `${above.length.toLocaleString()} ABOVE HORIZON`;
    $('tb-sky').textContent = above.length.toLocaleString();
    // Rises and sets of the objects worth looking up for (crewed and naked-eye bright ones).
    const watch = new Map();
    for (const a of above) if (a.o.flags.has('station') || a.o.flags.has('visual') || a.o === selected) watch.set(a.o, a);
    if (prevAbove) {
      for (const [o, a] of watch) if (!prevAbove.has(o)) log.push({ t: now.getTime(), tag: 'RISE', text: `${o.name} az ${a.az.toFixed(0)}°`, cls: o.flags.has('station') ? 'ok' : '' });
      for (const o of prevAbove.keys()) if (!watch.has(o) && (o.flags.has('station') || o === selected)) log.push({ t: now.getTime(), tag: 'SET', text: o.name });
    }
    prevAbove = watch;
    drawSky($('sky'), { above, selected, pass: passes[0], observer, pal, now });
  };
  setTimeout(drawSkyNow, 1500); // after the first full propagation sweep
  setInterval(drawSkyNow, 1000);

  // ---------- tour ----------
  // Edited like a film rather than a dashboard: when nobody is touching the page, the camera
  // cuts between a few beats the data makes interesting, each with a caption.
  const leadersList = objects.filter(o => o.leader === o);
  const count = r => leadersList.filter(o => o.regime === r).length;
  const beats = [
    () => {
      setConjunctionIdx(-1);
      scene.cutTo({ view: 27000, pitch: 0.38, yaw: scene.cam.yaw + 1.1 });
      return ['The shell', `${leadersList.length.toLocaleString()} tracked objects · ${count('LEO').toLocaleString()} in low orbit`];
    },
    () => {
      const iss = byId.get(25544);
      if (!iss) return null;
      setConjunctionIdx(-1);
      select(iss);
      const pv = eciAt(iss, simNow());
      if (pv) scene.cutTo({ yaw: scene.yawFacing([pv.position.x, pv.position.y]), pitch: 0.45 });
      const p = passes[0];
      return ['Crewed · ISS', p ? `next pass over ${observer.label} ${fmt.local(p.start)} · max ${p.maxEl.toFixed(0)}°` : `${iss.docked.length} vehicles docked`];
    },
    () => {
      const i = snap.conjunctions.rows.findIndex(c => byId.has(c.a.id) && byId.has(c.b.id) && Date.parse(c.tca) > simNow());
      if (i < 0) return null;
      const c = snap.conjunctions.rows[i];
      setConjunctionIdx(i);
      const pv = eciAt(byId.get(c.a.id), new Date(c.tca));
      if (pv) scene.cutTo({ yaw: scene.yawFacing([pv.position.x, pv.position.y]), pitch: Math.asin(Math.max(-1, Math.min(1, pv.position.z / Math.hypot(pv.position.x, pv.position.y, pv.position.z)))) * 0.8 });
      return ['Close approach', `${c.a.name} / ${c.b.name} · ${fmt.km(c.rangeKm)} at ${c.speedKms.toFixed(1)} km/s`];
    },
    () => {
      setConjunctionIdx(-1);
      scene.cutTo({ view: 52000, pitch: 0.12 });
      return ['Geostationary belt', `${count('GEO').toLocaleString()} objects parked 35,786 km up`];
    },
    () => {
      const d = leadersList.filter(o => o.flags.has('decaying')).sort((a, b) => a.perigee - b.perigee)[0];
      if (!d) return null;
      setConjunctionIdx(-1);
      select(d);
      return ['Decay watch', `${d.name} · perigee ${d.perigee.toFixed(0)} km`];
    },
  ];
  function setConjunctionIdx(i) {
    if (i === conjIdx) return;
    if (i < 0) { conjIdx = -1; scene.setConjunction(null); drawConj(); return; }
    pickConjunction(i);
  }
  let tourOn = !reducedMotion, beat = -1, lastUser = performance.now(), lastCut = 0, captionTimer;
  const tourBtn = $('tour');
  tourBtn.setAttribute('aria-pressed', String(tourOn));
  tourBtn.addEventListener('click', () => { tourOn = !tourOn; tourBtn.setAttribute('aria-pressed', String(tourOn)); });
  for (const ev of ['pointerdown', 'keydown', 'wheel']) document.addEventListener(ev, () => { lastUser = performance.now(); }, { passive: true });
  function caption(n, title, sub) {
    const el = $('cut');
    el.querySelector('.cut-n').textContent = `CUT ${String(n).padStart(2, '0')} / ${String(beats.length).padStart(2, '0')}`;
    el.querySelector('.cut-t').textContent = title;
    el.querySelector('.cut-s').textContent = sub;
    el.classList.add('on');
    clearTimeout(captionTimer);
    captionTimer = setTimeout(() => el.classList.remove('on'), 7000);
  }
  setInterval(() => {
    const now = performance.now();
    if (!tourOn || document.hidden || now - lastUser < 20000 || now - lastCut < 12000) return;
    for (let tries = 0; tries < beats.length; tries++) {
      beat = (beat + 1) % beats.length;
      const c = beats[beat]();
      if (c) { caption(beat + 1, ...c); lastCut = now; log.push({ t: simNow().getTime(), tag: 'CUT', text: `${c[0]} · ${c[1]}`, cls: 'cool' }); break; }
    }
  }, 1000);
}

main().catch(err => {
  console.error(err);
  $('loading').textContent = 'COULD NOT LOAD ORBITAL DATA';
});
