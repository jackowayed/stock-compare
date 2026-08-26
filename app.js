/* Stock Compare — normalize securities, chart ratios, adjust the time window.
 *
 * Data comes from /api/quote-timeseries (Yahoo Finance daily *adjusted* close —
 * split- and dividend-adjusted, so this is total return, with decades of
 * history). No build step: plain modules-free ES, ECharts for the chart,
 * everything else vanilla.
 */

'use strict';

/* ---------------------------------------------------------------- config -- */

const RANGES = [
  { key: '1W', label: '1W', days: 7 },
  { key: '1M', label: '1M', days: 31 },
  { key: '3M', label: '3M', days: 93 },
  { key: '6M', label: '6M', days: 186 },
  { key: '1Y', label: '1Y', days: 366 },
  { key: '5Y', label: '5Y', days: 5 * 366 },
  { key: 'MAX', label: 'Max', days: Infinity }, // full history (decades)
];
const DEFAULT_RANGE = 'MAX';

const EXAMPLES = [
  'SPY, QQQ',
  'AAPL, MSFT, GOOGL',
  'SPY/QQQ',
  'TSLA, F, GM',
  'VTI, VXUS',
];

// Distinct, readable in both light and dark.
const PALETTE = [
  '#2563eb', '#e11d48', '#059669', '#d97706',
  '#7c3aed', '#0891b2', '#db2777', '#65a30d',
];

const STORE_PREFIX = 'sc:';

/* ----------------------------------------------------------------- state -- */

const state = {
  input: '',
  range: DEFAULT_RANGE,
  normalize: true,
  log: false,
  theme: 'auto', // 'auto' | 'light' | 'dark'
};

let built = [];      // [{ expr, raw:[[t,v],...] }] for the current input
let chart = null;

const el = (id) => document.getElementById(id);

/* ------------------------------------------------------------- utilities -- */

class AppError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind || 'error';
  }
}

function parseDate(s) {
  // 'YYYY-MM-DD' -> local midnight, so dates render correctly in the user's tz.
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtNum(v, decimals = 2) {
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: decimals });
}

function fmtValue(v, expr, normalized) {
  if (normalized) return fmtNum(v, 2);
  if (expr && expr.type === 'ratio') return fmtNum(v, 3);
  return fmtNum(v, 2);
}

function fmtPct(p) {
  const sign = p > 0 ? '+' : '';
  return `${sign}${fmtNum(p, 2)}%`;
}

function isDarkMode() {
  if (state.theme === 'dark') return true;
  if (state.theme === 'light') return false;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/* -------------------------------------------------- expression parsing -- */

function parseExpr(rawToken) {
  const expr = rawToken.trim();
  if (!expr) return null;

  if (expr.includes('/')) {
    const parts = expr.split('/').map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (parts.length !== 2) {
      throw new AppError(`Ratio "${expr}" must be exactly NUM/DEN (one slash).`, 'bad_expr');
    }
    return { raw: `${parts[0]}/${parts[1]}`, type: 'ratio', num: parts[0], den: parts[1], symbols: [parts[0], parts[1]] };
  }

  const sym = expr.toUpperCase();
  return { raw: sym, type: 'single', symbol: sym, symbols: [sym] };
}

function parseInput(value) {
  const seen = new Set();
  const exprs = [];
  for (const token of value.split(',')) {
    const expr = parseExpr(token);
    if (!expr || seen.has(expr.raw)) continue;
    seen.add(expr.raw);
    exprs.push(expr);
  }
  return exprs;
}

/* ------------------------------------------------------- data fetching -- */

const memCache = new Map();

function readDayCache(symbol) {
  try {
    const rawStr = localStorage.getItem(STORE_PREFIX + 'adj:' + symbol);
    if (!rawStr) return null;
    const parsed = JSON.parse(rawStr);
    if (parsed.day !== todayStr() || !Array.isArray(parsed.series)) return null;
    return parsed.series; // [[t, close], ...]
  } catch {
    return null;
  }
}

function writeDayCache(symbol, series) {
  try {
    localStorage.setItem(STORE_PREFIX + 'adj:' + symbol, JSON.stringify({ day: todayStr(), series }));
  } catch {
    /* quota / private mode — caching is best-effort */
  }
}

function isCached(symbol) {
  symbol = symbol.toUpperCase();
  if (memCache.has(symbol)) return true;
  const cached = readDayCache(symbol);
  if (cached) {
    memCache.set(symbol, cached);
    return true;
  }
  return false;
}

async function fetchSymbol(symbol) {
  symbol = symbol.toUpperCase();
  if (memCache.has(symbol)) return memCache.get(symbol);

  const res = await fetch(`/api/quote-timeseries?symbol=${encodeURIComponent(symbol)}`);
  let body;
  try {
    body = await res.json();
  } catch {
    throw new AppError('Unexpected response from the server.', 'upstream');
  }

  if (!res.ok) {
    throw new AppError(body && body.error ? body.error : `Request failed (${res.status}).`, (body && body.kind) || 'upstream');
  }

  const raw = body && body.series;
  if (!Array.isArray(raw)) {
    throw new AppError(`No data returned for "${symbol}".`, 'not_found');
  }

  // Proxy hands back [["YYYY-MM-DD", adjClose], ...] ascending; convert the
  // date to a local-midnight timestamp for charting and ratio alignment.
  const series = raw
    .map(([date, c]) => [parseDate(date), Number(c)])
    .filter(([t, c]) => Number.isFinite(t) && Number.isFinite(c))
    .sort((a, b) => a[0] - b[0]);

  if (!series.length) throw new AppError(`No usable data for "${symbol}".`, 'not_found');

  memCache.set(symbol, series);
  writeDayCache(symbol, series);
  return series;
}

async function buildRawPoints(expr) {
  if (expr.type === 'single') {
    const s = await fetchSymbol(expr.symbol);
    return s.map(([t, c]) => [t, c]);
  }
  // Ratio: align numerator and denominator by date.
  const [a, b] = await Promise.all([fetchSymbol(expr.num), fetchSymbol(expr.den)]);
  const bByDate = new Map(b.map(([t, c]) => [t, c]));
  const pts = [];
  for (const [t, c] of a) {
    const d = bByDate.get(t);
    if (d != null && d !== 0) pts.push([t, c / d]);
  }
  if (!pts.length) throw new AppError(`No overlapping dates for ${expr.raw}.`, 'not_found');
  return pts;
}

/* ----------------------------------------------- windowing + normalize -- */

function shape(rawPts, cutoff, normalize) {
  const win = Number.isFinite(cutoff) ? rawPts.filter(([t]) => t >= cutoff) : rawPts;
  if (!win.length) return null;

  const base = win[0][1];
  const data = normalize && base ? win.map(([t, v]) => [t, (v / base) * 100]) : win.map(([t, v]) => [t, v]);

  return {
    data,
    base,
    firstRaw: win[0][1],
    lastRaw: win[win.length - 1][1],
    firstT: win[0][0],
    lastT: win[win.length - 1][0],
    pct: (win[win.length - 1][1] / win[0][1] - 1) * 100,
  };
}

/* --------------------------------------------------------------- banner -- */

function showBanner(html, kind) {
  const b = el('banner');
  b.className = 'banner banner--' + kind;
  b.innerHTML = html;
  b.hidden = false;
}

function clearBanner() {
  const b = el('banner');
  b.className = 'banner';
  b.hidden = true;
}

function setBusy(busy) {
  el('plot').disabled = busy;
  el('plot').textContent = busy ? 'Loading…' : 'Plot';
  if (busy) showBanner('<span class="spinner"></span> Fetching price data…', 'loading');
}

/* --------------------------------------------------------------- chart -- */

function ensureChart() {
  if (!chart) {
    chart = echarts.init(el('chart'), null, { renderer: 'canvas' });
    // Zooming the slider must not re-run normalization; it is a pure visual zoom.
  }
  return chart;
}

function chartTheme() {
  const dark = isDarkMode();
  return dark
    ? { text: '#9aa4b2', strong: '#e7ebf3', axis: '#2b313c', split: 'rgba(255,255,255,.07)', tipBg: '#1f242d', tipBorder: '#2b313c' }
    : { text: '#5b6472', strong: '#1a1f2b', axis: '#dfe3ec', split: 'rgba(16,24,40,.07)', tipBg: '#ffffff', tipBorder: '#dfe3ec' };
}

function render() {
  const range = RANGES.find((r) => r.key === state.range) || RANGES[RANGES.length - 1];
  const cutoff = Number.isFinite(range.days) ? Date.now() - range.days * 86400000 : Infinity * -1;
  const normalize = state.normalize;

  const series = [];
  const summary = [];
  const emptyWindow = [];
  let windowStartT = null;

  built.forEach((item, i) => {
    const s = shape(item.raw, cutoff, normalize);
    if (!s) {
      emptyWindow.push(item.expr.raw);
      return;
    }
    const color = PALETTE[i % PALETTE.length];
    windowStartT = windowStartT == null ? s.firstT : Math.min(windowStartT, s.firstT);

    series.push({
      name: item.expr.raw,
      type: 'line',
      data: s.data,
      color,
      showSymbol: false,
      symbol: 'circle',
      symbolSize: 6,
      lineStyle: { width: 2 },
      emphasis: { focus: 'series' },
      connectNulls: true,
      // stash for the tooltip
      _base: s.base,
      _type: item.expr.type,
    });

    summary.push({
      name: item.expr.raw,
      color,
      type: item.expr.type,
      lastRaw: s.lastRaw,
      pct: s.pct,
      firstT: s.firstT,
      lastT: s.lastT,
    });
  });

  el('chartEmpty').style.display = series.length ? 'none' : 'grid';

  const t = chartTheme();
  const baseMap = {};
  series.forEach((s) => { baseMap[s.name] = { base: s._base, type: s._type }; });

  const option = {
    backgroundColor: 'transparent',
    animationDuration: 300,
    color: series.map((s) => s.color),
    textStyle: { color: t.text, fontFamily: 'inherit' },
    grid: { left: 6, right: 14, top: 44, bottom: 64, containLabel: true },
    legend: {
      type: 'scroll',
      top: 6,
      textStyle: { color: t.strong },
      inactiveColor: t.text,
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: t.tipBg,
      borderColor: t.tipBorder,
      textStyle: { color: t.strong },
      axisPointer: { type: 'cross', label: { backgroundColor: isDarkMode() ? '#111' : '#555' } },
      formatter: (params) => {
        if (!params.length) return '';
        const header = fmtDate(params[0].value[0]);
        const rows = params
          .map((p) => {
            const meta = baseMap[p.seriesName] || {};
            const val = p.value[1];
            const pct = normalize ? val - 100 : (meta.base ? (val / meta.base - 1) * 100 : 0);
            const cls = pct >= 0 ? 'color:#16a34a' : 'color:#dc2626';
            return (
              `<div style="display:flex;justify-content:space-between;gap:16px;align-items:center">` +
              `<span>${p.marker}${p.seriesName}</span>` +
              `<span><b>${fmtValue(val, { type: meta.type }, normalize)}</b> ` +
              `<span style="${cls}">${fmtPct(pct)}</span></span></div>`
            );
          })
          .join('');
        return `<div style="font-weight:600;margin-bottom:4px">${header}</div>${rows}`;
      },
    },
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: t.axis } },
      axisLabel: { color: t.text, hideOverlap: true },
      splitLine: { show: false },
    },
    yAxis: {
      type: state.log ? 'log' : 'value',
      scale: true,
      axisLine: { show: false },
      axisLabel: { color: t.text, formatter: (v) => fmtNum(v, 2) },
      splitLine: { lineStyle: { color: t.split } },
    },
    dataZoom: [
      { type: 'inside', throttle: 60 },
      {
        type: 'slider',
        height: 20,
        bottom: 14,
        borderColor: t.axis,
        backgroundColor: 'transparent',
        fillerColor: isDarkMode() ? 'rgba(79,140,255,.15)' : 'rgba(37,99,235,.10)',
        handleStyle: { color: t.strong },
        dataBackground: { lineStyle: { color: t.axis }, areaStyle: { color: t.split } },
        textStyle: { color: t.text },
      },
    ],
    series,
  };

  const c = ensureChart();
  c.setOption(option, { notMerge: true });

  renderCaption(normalize, windowStartT, range, emptyWindow);
  renderSummary(summary, normalize);
}

function renderCaption(normalize, windowStartT, range, emptyWindow) {
  const cap = el('chartCaption');
  if (!built.length) {
    cap.hidden = true;
    return;
  }
  const parts = [];
  if (normalize && windowStartT != null) {
    parts.push(`Normalized to 100 at ${fmtDate(windowStartT)}`);
  } else if (!normalize) {
    parts.push('Raw values (prices / ratios)');
  }
  parts.push(range.key === 'MAX' ? 'full available history' : `${range.label} window`);
  if (state.log) parts.push('log scale');
  let html = parts.join(' · ');
  if (emptyWindow.length) {
    html += ` — <span class="down">no data in window for ${emptyWindow.join(', ')}</span>`;
  }
  cap.innerHTML = html;
  cap.hidden = false;
}

function renderSummary(summary, normalize) {
  const box = el('summary');
  if (!summary.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.innerHTML = summary
    .map((s) => {
      const dir = s.pct >= 0 ? 'up' : 'down';
      const arrow = s.pct >= 0 ? '▲' : '▼';
      const valLabel = s.type === 'ratio' ? 'ratio' : 'adj close';
      return (
        `<div class="stat" style="border-left-color:${s.color}">` +
        `<div class="stat__name"><span class="stat__swatch" style="background:${s.color}"></span>${s.name}</div>` +
        `<div class="stat__value">${fmtValue(s.lastRaw, { type: s.type }, false)}</div>` +
        `<div class="stat__change ${dir}">${arrow} ${fmtPct(s.pct)}</div>` +
        `<div class="stat__meta">${valLabel} · ${fmtDate(s.firstT)} → ${fmtDate(s.lastT)}</div>` +
        `</div>`
      );
    })
    .join('');
  box.hidden = false;
}

/* ----------------------------------------------------------- data flow -- */

async function loadAndRender() {
  let exprs;
  try {
    exprs = parseInput(el('symbols').value);
  } catch (e) {
    showBanner(e.message, 'error');
    return;
  }

  if (!exprs.length) {
    built = [];
    render();
    clearBanner();
    return;
  }

  const symbols = [...new Set(exprs.flatMap((e) => e.symbols))];
  const needsNetwork = symbols.some((s) => !isCached(s));
  if (needsNetwork) setBusy(true);

  const nextBuilt = [];
  const failures = [];
  for (const expr of exprs) {
    try {
      const raw = await buildRawPoints(expr);
      nextBuilt.push({ expr, raw });
    } catch (e) {
      failures.push({ expr, message: e.message, kind: e.kind });
    }
  }

  built = nextBuilt;
  setBusy(false);
  render();

  if (failures.length) {
    const rateLimited = failures.find((f) => f.kind === 'rate_limit');
    if (rateLimited) {
      showBanner(
        `<strong>Data provider limit reached.</strong> ${rateLimited.message} ` +
        `Try again later — previously loaded symbols are cached for today.`,
        'error'
      );
    } else {
      const list = failures.map((f) => `<li><b>${f.expr.raw}</b>: ${f.message}</li>`).join('');
      showBanner(`<strong>Couldn't load some entries:</strong><ul style="margin:6px 0 0 18px">${list}</ul>`, 'error');
    }
  } else {
    clearBanner();
  }
}

/* ---------------------------------------------------------- URL + prefs -- */

function syncUrl() {
  const p = new URLSearchParams();
  if (state.input) p.set('symbols', state.input);
  if (state.range !== DEFAULT_RANGE) p.set('range', state.range);
  if (!state.normalize) p.set('norm', '0');
  if (state.log) p.set('log', '1');
  const qs = p.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

function readUrl() {
  const p = new URLSearchParams(location.search);
  state.input = p.get('symbols') || p.get('quotes') || '';
  const range = (p.get('range') || '').toUpperCase();
  if (RANGES.some((r) => r.key === range)) state.range = range;
  if (p.get('norm') === '0') state.normalize = false;
  if (p.get('log') === '1') state.log = true;
  try {
    const savedTheme = localStorage.getItem(STORE_PREFIX + 'theme');
    if (savedTheme === 'light' || savedTheme === 'dark') state.theme = savedTheme;
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------- theming -- */

function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.theme);
}

function toggleTheme() {
  state.theme = isDarkMode() ? 'light' : 'dark';
  applyTheme();
  try {
    localStorage.setItem(STORE_PREFIX + 'theme', state.theme);
  } catch { /* ignore */ }
  if (built.length || chart) render();
}

/* ------------------------------------------------------------- UI wiring -- */

function buildRangeButtons() {
  const box = el('ranges');
  box.innerHTML = '';
  for (const r of RANGES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg';
    b.textContent = r.label;
    b.dataset.key = r.key;
    b.setAttribute('aria-pressed', String(r.key === state.range));
    b.addEventListener('click', () => {
      state.range = r.key;
      updateRangeButtons();
      syncUrl();
      render();
    });
    box.appendChild(b);
  }
}

function updateRangeButtons() {
  for (const b of el('ranges').children) {
    b.setAttribute('aria-pressed', String(b.dataset.key === state.range));
  }
}

function buildExamples() {
  const box = el('examples');
  for (const ex of EXAMPLES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = ex;
    b.addEventListener('click', () => {
      el('symbols').value = ex;
      state.input = ex;
      syncUrl();
      loadAndRender();
    });
    box.appendChild(b);
  }
}

function wireControls() {
  el('controls').addEventListener('submit', (e) => {
    e.preventDefault();
    state.input = el('symbols').value.trim();
    syncUrl();
    loadAndRender();
  });

  el('normalize').addEventListener('change', (e) => {
    state.normalize = e.target.checked;
    syncUrl();
    render();
  });

  el('logscale').addEventListener('change', (e) => {
    state.log = e.target.checked;
    syncUrl();
    render();
  });

  el('themeToggle').addEventListener('click', toggleTheme);

  el('copyLink').addEventListener('click', async () => {
    state.input = el('symbols').value.trim();
    syncUrl();
    const btn = el('copyLink');
    try {
      await navigator.clipboard.writeText(location.href);
      const prev = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = prev; }, 1500);
    } catch {
      showBanner('Copy failed — here is the link: <code>' + location.href + '</code>', 'info');
    }
  });

  // Keep the chart sized to its container across resizes / orientation changes.
  window.addEventListener('resize', () => chart && chart.resize());
  if (window.ResizeObserver) {
    new ResizeObserver(() => chart && chart.resize()).observe(el('chart'));
  }

  // Re-theme the chart when the OS scheme changes while on 'auto'.
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (state.theme === 'auto') render();
    });
  }
}

/* ---------------------------------------------------------------- init -- */

function init() {
  readUrl();
  applyTheme();

  el('symbols').value = state.input;
  el('normalize').checked = state.normalize;
  el('logscale').checked = state.log;

  buildExamples();
  buildRangeButtons();
  wireControls();

  ensureChart();

  if (state.input) {
    loadAndRender();
  } else {
    render(); // shows the empty-state overlay
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
