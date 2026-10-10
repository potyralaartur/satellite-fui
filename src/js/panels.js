// DOM panels. Everything here is plain text in tables and lists so it stays crisp and selectable.

import { compass } from './orbit.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pad = n => String(n).padStart(2, '0');

export const fmt = {
  utc: d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
  utcShort: d => `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
  local: t => new Date(t).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }),
  dur: ms => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 3600) return `${Math.floor(s / 60)}m${pad(s % 60)}s`;
    if (s < 86400) return `${Math.floor(s / 3600)}h${pad(Math.floor((s % 3600) / 60))}m`;
    return `${Math.floor(s / 86400)}d${pad(Math.floor((s % 86400) / 3600))}h`;
  },
  km: v => (Math.abs(v) < 1 ? `${(v * 1000).toFixed(0)} m` : `${v.toFixed(v < 10 ? 2 : 0)} km`),
};

const TYPE_NAME = { PAY: 'PAYLOAD', 'R/B': 'ROCKET BODY', DEB: 'DEBRIS', UNK: 'UNKNOWN' };
const OPS = { '+': 'operational', '-': 'non-operational', P: 'partially operational', B: 'backup', S: 'spare', X: 'extended mission', D: 'decayed', '?': 'unknown' };

export function renderObject(o, st) {
  if (!o) {
    $('obj-name').textContent = 'Click a satellite';
    $('obj-tag').textContent = '';
    $('obj-grid').innerHTML = '';
    $('obj-docked').textContent = '';
    return;
  }
  $('obj-name').textContent = o.name;
  $('obj-tag').textContent = `${TYPE_NAME[o.type] ?? o.type} · ${o.regime}`;
  const rows = [
    ['NORAD', o.id], ['INTL', o.intl],
    ['LAT', st ? `${st.lat.toFixed(2)}°` : '--'], ['LON', st ? `${st.lon.toFixed(2)}°` : '--'],
    ['ALT', st ? `${st.alt.toFixed(0)} km` : '--'], ['SPEED', st ? `${st.speed.toFixed(2)} km/s` : '--'],
    ['PERIGEE', `${o.perigee.toFixed(0)} km`], ['APOGEE', `${o.apogee.toFixed(0)} km`],
    ['INCL', `${o.inc.toFixed(2)}°`], ['PERIOD', `${o.periodMin.toFixed(1)} min`],
    ['AZ / EL', st ? `${st.look.az.toFixed(0)}° / ${st.look.el.toFixed(0)}°` : '--'],
    ['LIGHT', st ? (st.shadow > 0.99 ? 'eclipse' : st.shadow > 0.01 ? 'penumbra' : 'sunlit') : '--'],
    ['ELEM AGE', st ? `${st.ageDays.toFixed(1)} d` : '--'], ['OWNER', o.owner || '--'],
  ];
  if (o.launch) rows.push(['LAUNCH', o.launch], ['STATUS', OPS[o.ops] ?? (o.ops || '--')]);
  $('obj-grid').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
  $('obj-docked').textContent = o.docked.length
    ? `Shares one element set with ${o.docked.length} docked object${o.docked.length > 1 ? 's' : ''}: ${o.docked.map(d => d.name).join(', ')}.`
    : '';
}

export function renderPasses(passes, now, o) {
  const body = $('passes');
  if (!o) { body.innerHTML = '<tr><td colspan="5" class="dim">Select a satellite to see its passes.</td></tr>'; return; }
  if (!passes.length) {
    body.innerHTML = `<tr><td colspan="5" class="dim">No passes above 10° in the next 48 h${o.regime === 'GEO' ? ' (geostationary objects hang still in the sky)' : ''}.</td></tr>`;
    return;
  }
  body.innerHTML = passes.map(p => {
    const live = now >= p.start && now <= p.stop;
    return `<tr${live ? ' class="active"' : ''}>
      <td>${live ? '<span class="hot">NOW</span>' : esc(fmt.local(p.start))}</td>
      <td>${p.maxEl.toFixed(0)}°</td>
      <td>${fmt.dur(p.stop - p.start)}</td>
      <td>${compass(p.startAz)}→${compass(p.stopAz)}</td>
      <td>${p.visible ? '<span class="star" title="Visible to the eye">★</span>' : ''}</td></tr>`;
  }).join('');
}

export function renderConjunctions(conj, now, activeIdx, onPick) {
  const body = $('conj');
  body.innerHTML = conj.rows.map((c, i) => {
    const dt = Date.parse(c.tca) - now;
    return `<tr class="click${i === activeIdx ? ' active' : ''}" data-i="${i}" tabindex="0">
      <td class="pair">${esc(c.a.name)}<small>vs ${esc(c.b.name)}</small></td>
      <td class="${c.rangeKm < 0.1 ? 'hot' : ''}">${fmt.km(c.rangeKm)}</td>
      <td>${c.speedKms.toFixed(1)} km/s</td>
      <td>${dt > 0 ? fmt.dur(dt) : '<span class="dim">passed</span>'}</td></tr>`;
  }).join('');
  body.querySelectorAll('tr').forEach(tr => {
    const go = () => onPick(Number(tr.dataset.i));
    tr.addEventListener('click', go);
    tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
  $('conj-note').textContent =
    `Snapshot ${conj.retrieved.slice(0, 10)}. Docked pairs removed. Probabilities are conservative upper bounds from public data, not operator estimates. Click a row to draw both orbits at closest approach.`;
}

const gScale = kp => Math.max(0, Math.min(5, Math.round(kp) - 4));

export function renderWeather(snap, pal) {
  const { kp, wind, scales } = snap;
  const last = kp[kp.length - 1];
  const peak = kp.slice(-8).reduce((m, r) => Math.max(m, r.kp), 0);
  const g = gScale(peak);
  const tag = $('wx-tag');
  tag.textContent = g ? `STORM · G${g} (24 h peak)` : 'QUIET';
  tag.className = `tag ${g >= 3 ? 'hot' : g ? 'warn' : ''}`;
  const rows = [
    ['KP', last ? `${last.kp.toFixed(2)}` : '--'],
    ['NOAA G/S/R', `G${scales.G} S${scales.S} R${scales.R}`],
    ['WIND', `${wind.speed.value.toFixed(0)} km/s`],
    ['BT', `${wind.bt.value.toFixed(0)} nT`],
    ['BZ', `${wind.bz.value.toFixed(0)} nT`],
    ['F10.7', `${wind.f107.value} sfu`],
  ];
  $('wx-grid').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
  $('wx-grid').style.gridTemplateColumns = 'auto 1fr';
  $('wx-note').textContent =
    `Kp to ${last ? fmt.utcShort(new Date(last.t)) : '--'} UTC, solar wind ${fmt.utcShort(new Date(wind.speed.t))} UTC. ` +
    'Storms heat the upper atmosphere, raising drag and pulling low orbits down faster. NOAA scales lag the 3-hour Kp.';
  drawKp($('kp'), kp, pal);
}

function drawKp(canvas, kp, pal) {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = r.width, h = r.height, top = 6, base = h - 16, left = 16;
  const y = v => base - (v / 9) * (base - top);
  ctx.font = '9px "Space Mono", monospace';
  ctx.fillStyle = `rgba(${pal.text}, .38)`;
  for (const v of [0, 3, 5, 7, 9]) {
    ctx.fillText(String(v), 0, y(v) + 3);
    ctx.fillStyle = `rgba(${pal.text}, ${v === 5 ? .22 : .08})`; ctx.fillRect(left, Math.round(y(v)), w - left, 1);
    ctx.fillStyle = `rgba(${pal.text}, .38)`;
  }
  const n = kp.length, bw = (w - left) / Math.max(1, n);
  kp.forEach((row, i) => {
    const g = gScale(row.kp);
    ctx.fillStyle = `rgba(${g >= 3 ? pal.hot : g ? pal.warn : pal.pay}, ${g ? 0.9 : 0.55})`;
    ctx.fillRect(left + i * bw + 0.5, y(row.kp), Math.max(1, bw - 1.5), base - y(row.kp));
    const d = new Date(row.t);
    if (d.getUTCHours() === 0) {
      ctx.fillStyle = `rgba(${pal.text}, .38)`;
      ctx.fillText(`${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}`, left + i * bw, h - 3);
    }
  });
}

export function renderCensus(objects) {
  const leaders = objects.filter(o => o.leader === o);
  const by = key => leaders.reduce((m, o) => m.set(o[key], (m.get(o[key]) ?? 0) + 1), new Map());
  const reg = by('regime'), typ = by('type');
  const rows = [
    ...['LEO', 'MEO', 'GEO', 'HEO'].map(k => [k, reg.get(k) ?? 0]),
    ['', null],
    ...[['PAY', 'Payloads'], ['R/B', 'Rocket bodies'], ['DEB', 'Debris']].map(([k, n]) => [n, typ.get(k) ?? 0]),
  ];
  const max = Math.max(1, ...rows.map(r => r[1] ?? 0));
  $('census').innerHTML = rows.map(([k, v]) => v === null ? '<tr><td colspan="3"></td></tr>' :
    `<tr><td>${k}</td><td>${v.toLocaleString()}</td><td class="bar"><div class="b" style="width:${(v / max) * 100}%"></div></td></tr>`).join('');
}

export function renderLog(entries) {
  $('log').innerHTML = entries
    .sort((a, b) => b.t - a.t)
    .map(e => `<li><time datetime="${new Date(e.t).toISOString()}">${fmt.utcShort(new Date(e.t))}</time><span class="${e.cls ?? ''}">${esc(e.text)}</span></li>`)
    .join('');
}
