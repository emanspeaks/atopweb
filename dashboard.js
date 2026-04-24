'use strict';
// chartjs-plugin-annotation auto-registers itself when loaded from CDN after Chart.js.

// ── Constants ────────────────────────────────────────────────────────────────

const GRBM_KEYS = [
  'Graphics Pipe',
  'Texture Pipe',
  'Shader Export',
  'Shader Processor Interpolator',
  'Primitive Assembly',
  'Depth Block',
  'Color Block',
  'Geometry Engine',
];

const GRBM2_KEYS = [
  'RunList Controller',
  'Texture Cache per Pipe',
  'Unified Translation Cache Level-2',
  'Efficiency Arbiter',
  'Render Backend Memory Interface',
  'SDMA',
  'Command Processor -  Fetcher',
  'Command Processor -  Compute',
  'Command Processor - Graphics',
];

// ── External DOM tooltip (can overflow chart canvas boundaries) ──────────────
let _tooltipEl = null;

function getTooltipEl() {
  if (!_tooltipEl) {
    _tooltipEl = document.createElement('div');
    Object.assign(_tooltipEl.style, {
      position:      'fixed',
      pointerEvents: 'none',
      zIndex:        '9999',
      background:    '#1c2128',
      border:        '1px solid #30363d',
      borderRadius:  '4px',
      padding:       '6px 8px',
      fontSize:      '11px',
      color:         '#8b949e',
      whiteSpace:    'nowrap',
      opacity:       '0',
      transition:    'opacity 0.08s',
    });
    document.body.appendChild(_tooltipEl);
  }
  return _tooltipEl;
}

function externalTooltip({ chart, tooltip }) {
  const el = getTooltipEl();
  if (!tooltip.opacity) { el.style.opacity = '0'; return; }

  const titles    = tooltip.title || [];
  const bodyItems = tooltip.body  || [];

  let html = '';
  if (titles.length) {
    html += '<div style="color:#e6edf3;line-height:1.6">' +
      titles.map(t => `<div>${t}</div>`).join('') + '</div>';
  }
  if (bodyItems.length) {
    if (titles.length) html += '<div style="margin-top:3px;border-top:1px solid #30363d;padding-top:3px">';
    bodyItems.forEach((b, i) => {
      const color = tooltip.labelColors?.[i]?.borderColor ?? '#8b949e';
      b.lines.filter(Boolean).forEach(line => {
        html += `<div><span style="display:inline-block;width:8px;height:8px;background:${color};` +
          `border-radius:1px;margin-right:4px;vertical-align:middle"></span>${line.trim()}</div>`;
      });
      b.after.filter(Boolean).forEach(line => {
        html += `<div style="color:#6e7681;font-size:9px;margin-left:12px">${line.trim()}</div>`;
      });
    });
    if (titles.length) html += '</div>';
  }
  el.innerHTML = html;

  const rect = chart.canvas.getBoundingClientRect();
  const tw   = el.offsetWidth;
  const th   = el.offsetHeight;
  const cx   = rect.left + tooltip.caretX;
  const cy   = rect.top  + tooltip.caretY;

  let left = cx + 12;
  let top  = cy - Math.round(th / 2);
  if (left + tw > window.innerWidth  - 4) left = cx - tw - 12;
  if (top < 4)                             top  = 4;
  if (top + th > window.innerHeight  - 4) top  = window.innerHeight - th - 4;

  el.style.left    = left + 'px';
  el.style.top     = top  + 'px';
  el.style.opacity = '1';
}

const CHART_DEFAULTS = {
  animation: false,
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: {
      labels: { color: '#8b949e', boxWidth: 8, padding: 5, font: { size: 10 } }
    },
    tooltip: { enabled: false },
    annotation: { drawTime: 'afterDraw', annotations: {} }
  },
  layout: { padding: { top: 4, right: 4, bottom: 4, left: 4 } },
  scales: {
    x: {
      type:   'linear',
      ticks:  { display: false },
      grid:   { color: '#21262d' },
      border: { color: '#30363d' }
    },
    y: {
      ticks: { color: '#8b949e', font: { size: 11 } },
      grid:  { color: '#21262d' },
      border: { color: '#30363d' }
    }
  }
};

// Deep-clone CHART_DEFAULTS and restore non-serializable function references.
// JSON.stringify silently drops functions, so callbacks must be re-applied
// after each clone — never rely on CHART_DEFAULTS to carry them directly.
function cloneDefaults() {
  const cfg = JSON.parse(JSON.stringify(CHART_DEFAULTS));
  cfg.plugins.tooltip.external  = externalTooltip;
  cfg.plugins.tooltip.itemSort  = tooltipItemSort;
  cfg.plugins.legend.labels.filter = (item, data) =>
    data.datasets[item.datasetIndex]?.data?.some(v => Number.isFinite(v));
  return cfg;
}

function tooltipItemSort(a, b) {
  const av = Number.isFinite(a.raw) ? a.raw : -Infinity;
  const bv = Number.isFinite(b.raw) ? b.raw : -Infinity;
  return bv - av;
}

function makeDataset(label, color, data, sourcePath, decimals) {
  return {
    label,
    data,
    sourcePath: sourcePath || null,
    decimals:   decimals  ?? 3,
    borderColor: color,
    backgroundColor: color + '1a',
    fill: true,
    tension: 0.25,
    pointRadius: 0,
    borderWidth: 1.5,
  };
}

// ── RAF render loop ──────────────────────────────────────────────────────────
// Chart.js defers actual canvas drawing to requestAnimationFrame even with
// animation:false, so calling update() directly in the WebSocket handler can
// only render at 1 Hz when the browser coalesces those calls. Instead we mark
// charts dirty and flush once per animation frame — this ties visual updates
// to the display refresh rate (60 fps) while still consuming every data point.
let _rafPending = false;
function scheduleRender() {
  const hasOverlay = !!state.overlayChart;
  if (state.paused && !hasOverlay) return;
  if (_rafPending) return;
  _rafPending = true;
  requestAnimationFrame(() => {
    _rafPending = false;
    const now = Date.now();
    const setDisplay = (el, visible) => {
      if (!el) return;
      const d = visible ? '' : 'none';
      if (el.style.display !== d) el.style.display = d;
    };
    for (const [key, c] of Object.entries(state.charts)) {
      const isCoreFreq = key.includes('-cpu-core-');
      const widthMs    = isCoreFreq ? state.coreTimeWidthMs : state.timeWidthMs;
      c.options.scales.x.min = now - widthMs;
      c.options.scales.x.max = now;
      // Skip repaint when paused, when overlay is covering the main view,
      // or when this chart has received no finite data within 10% of its window.
      const debounceMs  = widthMs * 0.1;
      const chartActive = (now - (state.chartLastData[key] || 0)) <= debounceMs;
      setDisplay(document.getElementById(`chart-box-${key}`), chartActive);
      if (!state.paused && !hasOverlay && chartActive &&
          (state.n <= 1 || parseInt(key, 10) === state.cur))
        c.update('none');
    }
    const cardDebounce = state.timeWidthMs * 0.1;
    for (const id in state.cardLastData) {
      // Permanent system cards are always visible regardless of data flow.
      if (id.startsWith('c-fan-') || id.startsWith('c-ppt-') || id.startsWith('c-uptime-')) continue;
      const active = (now - state.cardLastData[id]) <= cardDebounce;
      const el = document.getElementById(id);
      setDisplay(el?.closest('.card'), active);
    }
    if (hasOverlay && !state.paused) {
      state.overlayChart.options.scales.x.min = now - state.overlayWidthMs;
      state.overlayChart.options.scales.x.max = now;
      state.overlayChart.update('none');
    }
  });
}

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  cur:             -1,
  n:                0,
  hist:            [],
  charts:          {},
  powerLimits:     { stapm_w: null, fast_w: null, slow_w: null, apu_slow_w: null, thm_core_c: null, thm_gfx_c: null, thm_soc_c: null },
  totalRAMMiB:     null,
  systemInfo:      null,
  lastPPT:         { value: null, receivedAt: 0 },  // W; reused on each GPU tick
  lastFan:         { value: null, receivedAt: 0 },  // RPM; reused on each GPU tick
  seenFanSensor:   false,  // latched true when any fan sensor has been observed
  lastCPU:         { value: null, receivedAt: 0 },  // %; reused on each GPU tick
  coreRanks:       [],
  lastDev0:        null,
  lastDevices:     null,
  intervalMs:      1000,
  timeWidthMs:     120_000,
  coreTimeWidthMs: 60_000,
  paused:          false,
  overlayChart:    null,
  overlayChartKey: null,
  overlayWidthMs:  0,
  chartLastData:   {},   // chartKey → ms timestamp of last tick with any finite data
  cardLastData:    {},   // cardId   → ms timestamp of last tick with any finite value
  serverVersion:   null, // atopweb version string as reported by /api/config on first load
  lastConfig:      null, // last seen /api/config snapshot for change detection
};

// History size = time window / update interval, so the x-axis always shows a
// fixed duration regardless of how fast samples arrive.
function getHistorySize()     { return Math.max(2, Math.ceil(state.timeWidthMs     / state.intervalMs)); }
function getCoreHistorySize() { return Math.max(2, Math.ceil(state.coreTimeWidthMs / state.intervalMs)); }
// x-axis tick count: one tick per 5 s, plus 1 for the fencepost.
// Pick the smallest "nice" step size (in ms) that yields ≤ 24 grid lines.
function xStepSize(widthMs) {
  const steps = [5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 1800000, 3600000];
  const target = widthMs / 24;
  return steps.find(s => s >= target) ?? steps[steps.length - 1];
}

function makeHist(size, coreSize) {
  const a  = n => new Array(n).fill(NaN);
  const a2 = (rows, n) => Array.from({length: rows}, () => new Array(n).fill(NaN));
  // Pre-fill times with evenly-spaced epoch ms so the x-axis is valid before
  // real data arrives.  pushHistory overwrites them as samples come in.
  const now = Date.now();
  const ms  = state.intervalMs;
  return {
    times:     Array.from({length: size},     (_, k) => now - (size - 1 - k) * ms),
    coreTimes: Array.from({length: coreSize}, (_, k) => now - (coreSize - 1 - k) * ms),
    gfx:      a(size),
    mem:      a(size),
    media:    a(size),
    vram:     a(size),
    vramOnly: a(size),
    gttOnly:  a(size),
    pwr:      a(size),
    fan:      a(size),
    ppt:      a(size),
    cpuPwr:   a(size),
    npuPwr:   a(size),
    tempE:    a(size),
    tempC:    a(size),
    tempS:    a(size),
    tempGfx:  a(size),
    tempHot:  a(size),
    tempMem:  a(size),
    sclk:     a(size),
    mclk:     a(size),
    fclk:     a(size),
    fclkAvg:  a(size),
    socClk:   a(size),
    vclk:     a(size),
    vddgfx:   a(size),
    vddnb:    a(size),
    dramReads:  a(size),
    dramWrites: a(size),
    npuBusy:   a2(8,  size),
    npuClk:    a(size),
    npuMpClk:  a(size),
    npuReads:  a(size),
    npuWrites: a(size),
    grbm:          a2(GRBM_KEYS.length,  size),
    grbm2:         a2(GRBM2_KEYS.length, size),
    corePwr:       a2(16, size),     // CPU core power — global chart
    coreClk:       a2(16, coreSize), // CPU core SMU clocks — per-core charts
    cpuScalingClk: a2(16, coreSize), // CPU core cpufreq scaling — per-core charts
    vramMax:       1,
    events:           [],         // [{timeMs, type:'start'|'stop', name, pid}]
    prevProcNames:    new Map(),  // pid → name, previous tick
    earlyStartedPids: new Set(),  // pids emitted via server proc_event; skip fdinfo re-emit
  };
}

// ── History cache (localStorage) ─────────────────────────────────────────────
// Binary Float32 + base64 keeps each array ~640 chars (120 pts × 4 B × 4/3).
// Periodic saves avoid per-sample overhead; beforeunload catches tab closes.
const CACHE_KEY     = 'atopweb-hist-v1';
const CACHE_SAVE_MS = 5_000;

function _encF32(arr) {
  const f32 = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) f32[i] = arr[i];
  const u8 = new Uint8Array(f32.buffer);
  let s = '';
  for (let i = 0; i < u8.length; i += 8192)
    s += String.fromCharCode(...u8.subarray(i, Math.min(i + 8192, u8.length)));
  return btoa(s);
}

function _decF32(b64, target) {
  const bin = atob(b64);
  const u8  = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const src = new Float32Array(u8.buffer);
  const len = Math.min(src.length, target.length);
  for (let i = 0; i < len; i++) target[i] = src[i]; // NaN propagates correctly
}

function encodeHist(h) {
  const e1 = a => _encF32(a);
  const e2 = as => as.map(e1);
  return {
    gfx: e1(h.gfx), mem: e1(h.mem), media: e1(h.media),
    vram: e1(h.vram), vramOnly: e1(h.vramOnly), gttOnly: e1(h.gttOnly),
    pwr: e1(h.pwr), fan: e1(h.fan), ppt: e1(h.ppt),
    cpuPwr: e1(h.cpuPwr), npuPwr: e1(h.npuPwr),
    tempE: e1(h.tempE), tempC: e1(h.tempC), tempS: e1(h.tempS),
    tempGfx: e1(h.tempGfx), tempHot: e1(h.tempHot), tempMem: e1(h.tempMem),
    sclk: e1(h.sclk), mclk: e1(h.mclk), fclk: e1(h.fclk),
    fclkAvg: e1(h.fclkAvg), socClk: e1(h.socClk), vclk: e1(h.vclk),
    vddgfx: e1(h.vddgfx), vddnb: e1(h.vddnb),
    dramReads: e1(h.dramReads), dramWrites: e1(h.dramWrites),
    npuClk: e1(h.npuClk), npuMpClk: e1(h.npuMpClk),
    npuReads: e1(h.npuReads), npuWrites: e1(h.npuWrites),
    npuBusy: e2(h.npuBusy), corePwr: e2(h.corePwr),
    coreClk: e2(h.coreClk), cpuScalingClk: e2(h.cpuScalingClk),
    grbm: e2(h.grbm), grbm2: e2(h.grbm2),
  };
}

// Shift every data array in h left by `g` samples and fill the vacated tail
// with NaN, then advance the time axes by the same amount.  This injects a
// break that Chart.js (spanGaps:false by default) will render as a gap rather
// than a false connecting line.
function shiftHistGap(h, g, ms) {
  const n  = h.times.length;
  const cn = h.coreTimes.length;
  const g1 = Math.min(Math.max(0, g), n);
  const g2 = Math.min(g1, cn);
  if (g1 === 0) return;
  const sft = (a, gap) => { a.copyWithin(0, gap); a.fill(NaN, a.length - gap); };
  sft(h.gfx, g1); sft(h.mem, g1); sft(h.media, g1);
  sft(h.vram, g1); sft(h.vramOnly, g1); sft(h.gttOnly, g1);
  sft(h.pwr, g1); sft(h.fan, g1); sft(h.ppt, g1);
  sft(h.cpuPwr, g1); sft(h.npuPwr, g1);
  sft(h.tempE, g1); sft(h.tempC, g1); sft(h.tempS, g1);
  sft(h.tempGfx, g1); sft(h.tempHot, g1); sft(h.tempMem, g1);
  sft(h.sclk, g1); sft(h.mclk, g1); sft(h.fclk, g1);
  sft(h.fclkAvg, g1); sft(h.socClk, g1); sft(h.vclk, g1);
  sft(h.vddgfx, g1); sft(h.vddnb, g1);
  sft(h.dramReads, g1); sft(h.dramWrites, g1);
  sft(h.npuClk, g1); sft(h.npuMpClk, g1);
  sft(h.npuReads, g1); sft(h.npuWrites, g1);
  h.npuBusy.forEach(a => sft(a, g1));
  h.corePwr.forEach(a => sft(a, g1));
  h.grbm.forEach(a => sft(a, g1));
  h.grbm2.forEach(a => sft(a, g1));
  h.coreClk.forEach(a => sft(a, g2));
  h.cpuScalingClk.forEach(a => sft(a, g2));
  for (let k = 0; k < n;  k++) h.times[k]    += g1 * ms;
  for (let k = 0; k < cn; k++) h.coreTimes[k] += g2 * ms;
}

function decodeHist(c, h, ts, ms) {
  const d1 = (b, a) => { if (b && a) _decF32(b, a); };
  const d2 = (bs, as) => { if (bs && as) bs.forEach((b, j) => d1(b, as[j])); };
  d1(c.gfx, h.gfx); d1(c.mem, h.mem); d1(c.media, h.media);
  d1(c.vram, h.vram); d1(c.vramOnly, h.vramOnly); d1(c.gttOnly, h.gttOnly);
  d1(c.pwr, h.pwr); d1(c.fan, h.fan); d1(c.ppt, h.ppt);
  d1(c.cpuPwr, h.cpuPwr); d1(c.npuPwr, h.npuPwr);
  d1(c.tempE, h.tempE); d1(c.tempC, h.tempC); d1(c.tempS, h.tempS);
  d1(c.tempGfx, h.tempGfx); d1(c.tempHot, h.tempHot); d1(c.tempMem, h.tempMem);
  d1(c.sclk, h.sclk); d1(c.mclk, h.mclk); d1(c.fclk, h.fclk);
  d1(c.fclkAvg, h.fclkAvg); d1(c.socClk, h.socClk); d1(c.vclk, h.vclk);
  d1(c.vddgfx, h.vddgfx); d1(c.vddnb, h.vddnb);
  d1(c.dramReads, h.dramReads); d1(c.dramWrites, h.dramWrites);
  d1(c.npuClk, h.npuClk); d1(c.npuMpClk, h.npuMpClk);
  d1(c.npuReads, h.npuReads); d1(c.npuWrites, h.npuWrites);
  d2(c.npuBusy, h.npuBusy); d2(c.corePwr, h.corePwr);
  d2(c.coreClk, h.coreClk); d2(c.cpuScalingClk, h.cpuScalingClk);
  d2(c.grbm, h.grbm); d2(c.grbm2, h.grbm2);

  // Reconstruct time axes from cached end-timestamp.
  const n  = h.times.length;
  const cn = h.coreTimes.length;
  for (let k = 0; k < n;  k++) h.times[k]    = ts - (n  - 1 - k) * ms;
  for (let k = 0; k < cn; k++) h.coreTimes[k] = ts - (cn - 1 - k) * ms;

  // Shift by however many samples elapsed while the page was away so the tail
  // fills with NaN and Chart.js naturally breaks the line at the boundary.
  shiftHistGap(h, Math.round((Date.now() - ts) / ms), ms);
}

function saveCache() {
  if (!state.hist.length) return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      v: 1, ts: Date.now(),
      intervalMs:   state.intervalMs,
      histSize:     getHistorySize(),
      coreHistSize: getCoreHistorySize(),
      devices:      state.hist.map(encodeHist),
    }));
  } catch { /* quota exceeded or storage unavailable */ }
}

function restoreCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (p.v !== 1) return;
    if (Date.now() - p.ts > state.timeWidthMs) return;        // cache older than plot window
    if (p.intervalMs   !== state.intervalMs)   return;        // sample rate changed
    if (p.histSize     !== getHistorySize())    return;        // window size changed
    if (p.coreHistSize !== getCoreHistorySize()) return;
    if (p.devices.length !== state.hist.length) return;       // device count changed
    p.devices.forEach((c, i) => decodeHist(c, state.hist[i], p.ts, p.intervalMs));
    for (const chart of Object.values(state.charts)) chart.update('none');
  } catch { /* corrupt or incompatible cache — ignore */ }
}

// ── DOM helpers ──────────────────────────────────────────────────────────────
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls)  e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function setConnStatus(status, label) {
  document.getElementById('conn-dot').className = 'conn-dot ' + status;
  document.getElementById('conn-label').textContent = label;
  document.body.classList.toggle('data-stale', status !== 'connected');
}

// ── Chart tooltip / tick helpers ─────────────────────────────────────────────
function makeChartCallbacks(h) {
  return {
    title(items) {
      const idx = items[0]?.dataIndex;
      if (idx == null) return '';
      const ts = h.times[idx];
      if (ts == null) return '';
      const t   = new Date(ts);
      const abs = t.toLocaleTimeString([], { hour12: false }) + '.' +
                  String(t.getMilliseconds()).padStart(3, '0');
      const ago = ((Date.now() - ts) / 1000).toFixed(3) + 's ago';
      return [abs, ago];
    },
    label(item) {
      if (item.raw == null) return null;
      const raw = Number(item.raw);
      const dec = item.dataset.decimals ?? 3;
      const str = isNaN(raw) ? String(item.raw) :
        (Number.isInteger(raw) ? String(raw) : raw.toFixed(dec));
      return ` ${item.dataset.label}: ${str}`;
    },
    afterLabel(item) {
      const sp = item.dataset.sourcePath;
      return sp ? `  ${sp}` : null;
    },
  };
}

function fmtTick(v) {
  if (typeof v !== 'number') return String(v);
  return Number.isInteger(v) ? String(v) : v.toFixed(3);
}

// Draws a vertical cursor line on hover for charts where per-series tooltips
// are too noisy (e.g. 16-line core charts).
const verticalLinePlugin = {
  id: 'verticalLine',
  afterDraw(chart) {
    const active = chart.tooltip._active;
    if (!active || !active.length) return;
    const ctx = chart.ctx;
    const x = active[0].element.x;
    const { top, bottom } = chart.scales.y;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(139,148,158,0.4)';
    ctx.stroke();
    ctx.restore();
  }
};

// Tooltip for 16-line core charts: timestamp + instantaneous min/max only,
// no per-series breakdown.  getArrays is a function returning the 2-D data
// array so the closure stays fresh after history shifts.
function makeCoreChartCallbacks(h, getArrays, unit) {
  return {
    title(items) {
      const idx = items[0]?.dataIndex;
      if (idx == null) return [];
      const lines = [];
      const ts = h.times[idx];
      if (ts != null) {
        const t = new Date(ts);
        lines.push(
          t.toLocaleTimeString([], { hour12: false }) + '.' + String(t.getMilliseconds()).padStart(3, '0'),
          ((Date.now() - ts) / 1000).toFixed(3) + 's ago',
        );
      }
      const vals = getArrays().map(arr => arr[idx]).filter(Number.isFinite);
      if (vals.length) {
        lines.push(`Min: ${Math.min(...vals).toFixed(3)} ${unit}`);
        lines.push(`Max: ${Math.max(...vals).toFixed(3)} ${unit}`);
      }
      return lines;
    },
    label: () => null,
  };
}

// ── Build DOM (once per device-count change) ─────────────────────────────────
function buildDom(devices) {
  Object.values(state.charts).forEach(c => c.destroy());

  const tabs = document.getElementById('tabs');
  const main = document.getElementById('main');
  tabs.innerHTML = '';
  main.innerHTML = '';

  state.n = devices.length;
  state.hist = devices.map(() => makeHist(getHistorySize(), getCoreHistorySize()));
  state.charts = {};
  state.chartLastData = {};
  state.cardLastData  = {};

  if (devices.length > 1) tabs.classList.add('visible');
  updateStickyOffset();
  updateOverlayPosition();

  devices.forEach((dev, i) => {
    const name = (dev.Info && (dev.Info.DeviceName || dev.Info['ASIC Name'])) || `GPU ${i}`;

    // Tab button
    const btn = el('button', 'tab-btn' + (i === 0 ? ' active' : ''), name);
    btn.dataset.idx = i;
    btn.addEventListener('click', () => switchTab(i));
    tabs.appendChild(btn);

    // GPU panel
    const panel = el('div', 'gpu-panel' + (i === 0 ? ' active' : ''));
    panel.id = `panel-${i}`;

    // ── Stat cards ──
    const cards = el('div', 'cards');
    const cardDefs = [
      // Permanent system cards (fed by /api/system, never idle-hidden).
      { id: `c-cpu-${i}`,    cls: 'c-cpu',    label: 'CPU Usage',          unit: '%',   bar: true,  permanent: true, src: `/api/system → cpu_usage_pct (/proc/stat delta)` },
      // GPU cards
      { id: `c-gfx-${i}`,    cls: 'c-gfx',    label: 'GFX',                unit: '%',   bar: true,  src: `devices[${i}].gpu_activity.GFX.value` },
      { id: `c-media-${i}`,  cls: 'c-media',  label: 'Media',              unit: '%',   bar: true,  src: `devices[${i}].gpu_activity.MediaEngine.value` },
      { id: `c-vmem-${i}`,   cls: 'c-vmem',   label: 'GPU Mem Capacity',   unit: '%',   bar: true,  src: `(devices[${i}].VRAM['Total VRAM Usage'] + devices[${i}].VRAM['Total GTT Usage']) / (devices[${i}].VRAM['Total VRAM'] + devices[${i}].VRAM['Total GTT']) × 100` },
      { id: `c-vram-${i}`,   cls: 'c-vram',   label: 'BIOS Reserved VRAM', unit: 'GiB', bar: true,  split: true, srcU: `devices[${i}].VRAM['Total VRAM Usage'].value (MiB → GiB)`, srcT: `devices[${i}].VRAM['Total VRAM'].value (MiB → GiB)` },
      { id: `c-gtt-${i}`,    cls: 'c-gtt',    label: 'GTT',                unit: 'GiB', bar: true,  split: true, srcU: `devices[${i}].VRAM['Total GTT Usage'].value (MiB → GiB)`,  srcT: `devices[${i}].VRAM['Total GTT'].value (MiB → GiB)` },
      { id: `c-sclk-${i}`,   cls: 'c-sclk',   label: 'GFX Clock',          unit: 'MHz', bar: false, src: `devices[${i}].Sensors.GFX_SCLK.value` },
      { id: `c-fclk-${i}`,   cls: 'c-fclk',   label: 'FCLK (Fabric Clock)', unit: 'MHz', bar: false, src: `devices[${i}].Sensors.FCLK.value` },
      { id: `c-mclk-${i}`,   cls: 'c-mclk',   label: 'Mem Clock',          unit: 'MHz', bar: false, src: `devices[${i}].Sensors.GFX_MCLK.value` },
      { id: `c-vddgfx-${i}`, cls: 'c-vddgfx', label: 'VDDGFX',             unit: 'mV',  bar: false, src: `devices[${i}].Sensors.VDDGFX.value` },
      { id: `c-vddnb-${i}`,  cls: 'c-vddnb',  label: 'VDDNB',              unit: 'mV',  bar: false, src: `devices[${i}].Sensors.VDDNB.value` },
      { id: `c-etmp-${i}`,   cls: 'c-etmp',   label: 'Edge Temp',          unit: '°C',  bar: false, src: `devices[${i}].Sensors['Edge Temperature'].value` },
      { id: `c-cputmp-${i}`, cls: 'c-cputmp', label: 'CPU Tctl',           unit: '°C',  bar: false, src: `devices[${i}].Sensors['CPU Tctl'].value` },
      { id: `c-pwr-${i}`,    cls: 'c-pwr',    label: 'GPU Power',          unit: 'W',   bar: false, src: `devices[${i}].Sensors['Average Power' || 'Socket Power' || 'Input Power'].value` },
      // Permanent system cards (fed by /api/system, never idle-hidden).
      // { id: `c-ppt-${i}`,    cls: 'c-ppt',    label: 'Package Power Tracking', unit: 'W',   bar: false, permanent: true },
      { id: `c-fan-${i}`,    cls: 'c-fan',    label: 'Fan Speed',          unit: 'RPM', bar: false, permanent: true, src: `/api/system → fans[0].value` },
      { id: `c-uptime-${i}`, cls: 'c-uptime', label: 'Uptime',             unit: '',    bar: false, permanent: true, src: `/api/system → uptime_sec` },
    ];

    cardDefs.forEach(def => {
      const card = el('div', `card ${def.cls}`);
      // Permanent cards are always visible; others hide until data arrives.
      card.style.display = def.permanent ? '' : 'none';
      // Split cards: id lives on the card div (no single span owns def.id).
      // scheduleRender finds the card via getElementById(def.id).closest('.card'),
      // which works because the card div itself has the class and the id.
      if (def.split) card.id = def.id;
      const valHtml = def.split
        ? `<span class="card-value" id="${def.id}-u" data-src="${def.srcU}">—</span><span class="card-value-sep"> / </span><span class="card-value" id="${def.id}-t" data-src="${def.srcT}">—</span>`
        : `<span class="card-value" id="${def.id}"${def.src ? ` data-src="${def.src}"` : ''}>—</span>`;
      card.innerHTML = `
        <div class="card-label">${def.label}</div>
        <div>${valHtml}<span class="card-unit">${def.unit}</span></div>
        ${def.bar ? `<div class="card-bar-wrap"><div class="card-bar" id="${def.id}-bar"></div></div>` : ''}
      `;
      cards.appendChild(card);
      state.cardLastData[def.id] = def.permanent ? Date.now() : 0;
    });
    // ── Memory overview bar ──
    const memSec = el('div', 'mem-section');
    memSec.innerHTML = `
      <div class="mem-bar-outer">
        <div class="mem-bar-vram-part" id="mem-vram-part-${i}">
          <div class="mem-seg mem-seg-vram-free" id="mem-vram-free-${i}" data-src="mem_info_vram_total − mem_info_vram_used (BIOS carveout free)"></div>
          <div class="mem-seg mem-seg-vram-inv"  id="mem-vram-inv-${i}"  data-src="mem_info_vram_used − mem_info_vis_vram_used (CPU-invisible VRAM, GPU-only)"></div>
          <div class="mem-seg mem-seg-vram-vis"  id="mem-vram-vis-${i}"  data-src="mem_info_vis_vram_used (CPU-visible VRAM used, reachable via PCIe BAR)"></div>
        </div>
        <div class="mem-bar-sys-part">
          <div class="mem-seg mem-seg-gtt-used" id="mem-gtt-used-${i}" data-src="amdgpu 'Total GTT Usage' (system RAM pinned into GPU translation table)"></div>
          <div class="mem-seg mem-seg-drmcpu"   id="mem-drmcpu-${i}"   data-src="Σ drm-memory-cpu across all /proc/*/fdinfo DRM FDs (CPU-domain GPU buffers)"></div>
          <div class="mem-seg mem-seg-anon"     id="mem-anon-${i}"     data-src="/proc/meminfo AnonPages (user process heap/stack)"></div>
          <div class="mem-seg mem-seg-shmem"    id="mem-shmem-${i}"    data-src="/proc/meminfo Shmem (tmpfs + SysV shared memory)"></div>
          <div class="mem-seg mem-seg-cached"   id="mem-cached-${i}"   data-src="/proc/meminfo Cached − Shmem (file-backed page cache, reclaimable)"></div>
          <div class="mem-seg mem-seg-buf"      id="mem-buf-${i}"      data-src="/proc/meminfo Buffers (block-device cache, reclaimable)"></div>
          <div class="mem-seg mem-seg-sreclm"   id="mem-sreclm-${i}"   data-src="/proc/meminfo SReclaimable (dentry/inode slab, reclaimable)"></div>
          <div class="mem-seg mem-seg-sunrec"   id="mem-sunrec-${i}"   data-src="/proc/meminfo SUnreclaim (non-reclaimable slab)"></div>
          <div class="mem-seg mem-seg-vmalloc"  id="mem-vmalloc-${i}"  data-src="/proc/meminfo VmallocUsed (includes Percpu)"></div>
          <div class="mem-seg mem-seg-kstack"   id="mem-kstack-${i}"   data-src="/proc/meminfo KernelStack"></div>
          <div class="mem-seg mem-seg-ptables"  id="mem-ptables-${i}"  data-src="/proc/meminfo PageTables + SecPageTables"></div>
          <div class="mem-seg mem-seg-netbuf"   id="mem-netbuf-${i}"   data-src="/proc/net/sockstat mem × page size (kernel socket buffers)"></div>
          <div class="mem-seg mem-seg-drvpg"    id="mem-drvpg-${i}"    data-src="Used − Σ named buckets (kernel direct alloc_pages(): DMA-coherent, driver scratch, HugeTLB pool)"></div>
          <div class="mem-seg mem-seg-free"     id="mem-free-${i}"     data-src="/proc/meminfo MemFree"></div>
        </div>
        <div class="mem-seg mem-seg-fw"   id="mem-fw-${i}"   data-src="mem_reservation.firmware_reserved_mib minus BIOS VRAM carveout (PSP/SMU/ACPI/TSEG + hidden gap)"></div>
        <div class="mem-seg mem-seg-kres" id="mem-kres-${i}" data-src="System RAM (e820) − MemTotal (kernel-reserved: crashkernel, initrd, kernel image)"></div>
      </div>
      <div class="mem-legend">
        <span class="mem-legend-item"><span class="mem-lswatch mem-lswatch-vram-free"></span>VRAM free: <span class="mem-legend-val" id="mem-lbl-vram-free-${i}">—</span></span>
        <span class="mem-legend-item"><span class="mem-lswatch mem-lswatch-vram-vis"></span>VRAM vis: <span class="mem-legend-val" id="mem-lbl-vram-vis-${i}">—</span></span>
        <span class="mem-legend-item"><span class="mem-lswatch mem-lswatch-vram-inv"></span>VRAM invis: <span class="mem-legend-val" id="mem-lbl-vram-inv-${i}">—</span></span>
        <span class="mem-legend-item"><span class="mem-lswatch mem-lswatch-gtt"></span>GTT: <span class="mem-legend-val" id="mem-lbl-gtt-${i}">—</span></span>
        <span class="mem-legend-item"><span class="mem-lswatch mem-lswatch-drmcpu"></span>DRM-CPU: <span class="mem-legend-val" id="mem-lbl-drmcpu-${i}">—</span></span>
        <span class="mem-legend-item"><span class="mem-lswatch mem-lswatch-anon"></span>Apps: <span class="mem-legend-val" id="mem-lbl-anon-${i}">—</span></span>
        <span class="mem-legend-item"><span class="mem-lswatch mem-lswatch-shmem"></span>Shared: <span class="mem-legend-val" id="mem-lbl-shmem-${i}">—</span></span>
        <span class="mem-legend-item"><span class="mem-lswatch mem-lswatch-cached"></span>FCache: <span class="mem-legend-val" id="mem-lbl-cached-${i}">—</span></span>
        <span class="mem-legend-item"><span class="mem-lswatch mem-lswatch-buf"></span>Bufs: <span class="mem-legend-val" id="mem-lbl-buf-${i}">—</span></span>
        <span class="mem-legend-item"><span class="mem-lswatch mem-lswatch-sreclm"></span>SlabReclm: <span class="mem-legend-val" id="mem-lbl-sreclm-${i}">—</span></span>
        <span class="mem-legend-item"><span class="mem-lswatch mem-lswatch-sunrec"></span>SlabUnreclm: <span class="mem-legend-val" id="mem-lbl-sunrec-${i}">—</span></span>
        <span class="mem-legend-item"><span class="mem-lswatch mem-lswatch-vmalloc"></span>Vmalloc: <span class="mem-legend-val" id="mem-lbl-vmalloc-${i}">—</span></span>
        <span class="mem-legend-item"><span class="mem-lswatch mem-lswatch-kstack"></span>KStack: <span class="mem-legend-val" id="mem-lbl-kstack-${i}">—</span></span>
        <span class="mem-legend-item"><span class="mem-lswatch mem-lswatch-ptables"></span>PgTbls: <span class="mem-legend-val" id="mem-lbl-ptables-${i}">—</span></span>
        <span class="mem-legend-item"><span class="mem-lswatch mem-lswatch-netbuf"></span>NetBufs: <span class="mem-legend-val" id="mem-lbl-netbuf-${i}">—</span></span>
        <span class="mem-legend-item"><span class="mem-lswatch mem-lswatch-drvpg"></span>DrvPgs: <span class="mem-legend-val" id="mem-lbl-drvpg-${i}">—</span></span>
        <span class="mem-legend-item"><span class="mem-lswatch mem-lswatch-free"></span>Free: <span class="mem-legend-val" id="mem-lbl-free-${i}">—</span></span>
        <span class="mem-legend-item"><span class="mem-lswatch mem-lswatch-fw"></span>FW: <span class="mem-legend-val" id="mem-lbl-fw-${i}">—</span></span>
        <span class="mem-legend-item"><span class="mem-lswatch mem-lswatch-kres"></span>KRes: <span class="mem-legend-val" id="mem-lbl-kres-${i}">—</span></span>
        <span class="mem-legend-total">
          Installed: <span class="mem-legend-val" id="mem-lbl-total-${i}">—</span> GiB
          <span class="mem-legend-sep">◆</span>
          Non-GTT: <span class="mem-legend-val" id="mem-lbl-nongtt-${i}">—</span> GiB
          <span class="mem-legend-sep">◆</span>
          Margin: <span class="mem-legend-val" id="mem-lbl-margin-${i}">—</span> GiB
          <span class="mem-legend-sep">◆</span>
          dma-buf (shared): <span class="mem-legend-val" id="mem-lbl-dmabuf-${i}">—</span> GiB
        </span>
      </div>
    `;
    cards.appendChild(memSec);
    panel.appendChild(cards);

    const h = state.hist[i];

    // ── GRBM / GRBM2 performance counters ──
    const grbmSec = el('div', 'grbm-section');
    if (localStorage.getItem('atopweb.grbmCollapsed') !== 'false') grbmSec.classList.add('collapsed');
    const grbmTitle = el('div', 'section-title grbm-section-title', 'GPU Performance Counters');
    grbmTitle.addEventListener('click', () => {
      grbmSec.classList.toggle('collapsed');
      localStorage.setItem('atopweb.grbmCollapsed', grbmSec.classList.contains('collapsed'));
    });
    grbmSec.appendChild(grbmTitle);
    const grbmGrid = el('div', 'grbm-grid');

    const buildPCCol = (colTitle, keys, prefix, histArr, color, barCls, srcObj) => {
      const col = el('div', 'grbm-col');
      col.appendChild(el('div', 'grbm-col-title', colTitle));
      keys.forEach((key, ki) => {
        const label = key; //key.length > 30 ? key.slice(0, 28) + '…' : key;
        const item = el('div', 'grbm-item');
        item.innerHTML = `
          <div class="grbm-item-header">
            <span class="grbm-item-label" data-src="devices[${i}].${srcObj}['${key}']">${label}</span>
            <span class="grbm-item-val" id="${prefix}-val-${i}-${ki}">—</span>
          </div>
          <div class="grbm-bar-wrap">
            <div class="grbm-bar ${barCls}" id="${prefix}-bar-${i}-${ki}"></div>
          </div>`;

        const chartWrap = el('div', 'grbm-chart-wrap');
        item.appendChild(chartWrap);

        const chartKey = `${i}-${prefix}-${ki}`;
        item.addEventListener('click', () => {
          if (grbmSec.classList.contains('collapsed')) return;
          item.classList.toggle('expanded');
          if (item.classList.contains('expanded')) {
            // Lazy-create the chart on first expand.
            if (!state.charts[chartKey]) {
              const canvas = el('canvas');
              chartWrap.appendChild(canvas);
              const pcCfg = cloneDefaults();
              pcCfg.scales.x.ticks.stepSize = xStepSize(state.timeWidthMs);
              pcCfg.scales.y.min = 0;
              pcCfg.scales.y.max = 100;
              pcCfg.plugins.legend.display = false;
              pcCfg.plugins.tooltip.callbacks = makeChartCallbacks(h);
              pcCfg.scales.y.ticks.callback = fmtTick;
              pcCfg.scales.y.ticks.font = { size: 9 };
              pcCfg.scales.y.ticks.maxTicksLimit = 3;
              state.charts[chartKey] = new Chart(canvas, {
                type: 'line',
                data: {
                  labels: h.times,
                  datasets: [{
                    label: key,
                    data: histArr[ki],
                    sourcePath: `devices[${i}].${srcObj}['${key}']`,
                    borderColor: color,
                    backgroundColor: color + '1a',
                    fill: true,
                    tension: 0.25,
                    pointRadius: 0,
                    borderWidth: 1.5,
                  }],
                },
                options: pcCfg,
              });
            }
            state.charts[chartKey].resize();
            state.charts[chartKey].update('none');
          }
        });

        col.appendChild(item);
      });
      return col;
    };

    grbmGrid.appendChild(buildPCCol('GRBM',  GRBM_KEYS,  'grbm',  h.grbm,  '#e85d04', 'grbm-orange', 'GRBM'));
    grbmGrid.appendChild(buildPCCol('GRBM2', GRBM2_KEYS, 'grbm2', h.grbm2, '#388bfd', 'grbm-blue',   'GRBM2'));
    grbmSec.appendChild(grbmGrid);
    panel.appendChild(grbmSec);

    // ── Charts ──
    const chartGrid = el('div', 'charts');

    const chartDefs = [
      {
        key: 'temp', title: 'Temperature (°C)', height: 150, yMax: null,
        // wide: true,
        noYMin: true,
        datasets: () => [
          makeDataset('Edge',     '#40e0d0', h.tempE,   `devices[${i}].Sensors['Edge Temperature']`),
          makeDataset('CPU Tctl', '#fb7185', h.tempC,   `devices[${i}].Sensors['CPU Tctl']`),
          makeDataset('SoC',      '#bc8cff', h.tempS,   `devices[${i}].gpu_metrics.temperature_soc / 100`),
          makeDataset('GFX',      '#388bfd', h.tempGfx, `devices[${i}].gpu_metrics.temperature_gfx / 100`),
          makeDataset('Hotspot',  '#e879f9', h.tempHot, `devices[${i}].gpu_metrics.temperature_hotspot / 100`),
          makeDataset('Mem',      '#ffffff', h.tempMem, `devices[${i}].gpu_metrics.temperature_mem / 100`),
        ]
      },
      {
        key: 'fan', title: 'Fan Speed (RPM)', height: 150, yMax: null,
        noYMin: true,
        datasets: () => [
          makeDataset('Fan',            '#ffffff', h.fan,    `/api/system hwmon (first active fan)`),
        ]
      },
      {
        key: 'gfx-clk', title: 'Clocks (MHz)', height: 150, yMax: null,
        datasets: () => [
          makeDataset('SCLK',     '#e88504', h.sclk,    `devices[${i}].Sensors['GFX_SCLK']`),
          makeDataset('MCLK',     '#388bfd', h.mclk,    `devices[${i}].Sensors['GFX_MCLK']`),
          makeDataset('FCLK',     '#e7241a', h.fclk,    `devices[${i}].Sensors['FCLK']`),
          makeDataset('FCLK avg', '#00b4d8', h.fclkAvg, `devices[${i}].gpu_metrics.average_fclk_frequency`),
          makeDataset('SoC Clk',  '#e3cb41', h.socClk,  `devices[${i}].gpu_metrics.average_socclk_frequency`),
          makeDataset('VCN Clk',  '#3fb950', h.vclk,    `devices[${i}].gpu_metrics.average_vclk_frequency`),
        ]
      },
      {
        key: 'power', title: 'Package Power (W)', height: 150, yMax: null,
        datasets: () => [
          // makeDataset('PPT',           '#ffffff', h.ppt,    `/api/system hwmon powers[label=PPT] µW→W`),
          makeDataset('GPU', '#40e0d0', h.pwr,    `devices[${i}].Sensors['Average Power']`),
          makeDataset('CPU Cores Total',     '#388bfd', h.cpuPwr, `devices[${i}].gpu_metrics.average_all_core_power / 1000`),
          makeDataset('NPU',           '#bc8cff', h.npuPwr, `devices[${i}].gpu_metrics.average_ipu_power / 1000`),
        ]
      },
      {
        key: 'vram', title: 'VRAM + GTT Usage (GiB)', height: 150, yMax: null,
        tickFmt: v => (typeof v === 'number' ? v.toFixed(3) : String(v)),
        datasets: () => [
          makeDataset('Total', '#3fb950', h.vram,    `devices[${i}].VRAM: Total VRAM Usage + Total GTT Usage`, 3),
          makeDataset('VRAM',  '#388bfd', h.vramOnly, `devices[${i}].VRAM['Total VRAM Usage']`,               3),
          makeDataset('GTT',   '#bc8cff', h.gttOnly,  `devices[${i}].VRAM['Total GTT Usage']`,                3),
        ]
      },
      {
        key: 'core-pwr', title: 'CPU Core Power (W)', height: 150, yMax: null,
        coreData: () => h.corePwr, coreUnit: 'W',
        datasets: () => Array.from({length: 16}, (_, j) => ({
          label: `CPU ${coreLabel(j)}`,
          data: h.corePwr[j],
          sourcePath: `devices[${i}].gpu_metrics.average_core_power[${j}] / 1000`,
          borderColor: coreColor(j),
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.25,
          pointRadius: 0,
          borderWidth: 1,
        }))
      },
      {
        key: 'activity', title: 'GPU Activity (%)', height: 150, yMax: 100,
        datasets: () => [
          makeDataset('GFX',    '#e85d04', h.gfx,   `devices[${i}].gpu_activity['GFX']`),
          makeDataset('Memory', '#388bfd', h.mem,   `devices[${i}].gpu_activity['Memory']`),
          makeDataset('Media',  '#bc8cff', h.media, `devices[${i}].gpu_activity['MediaEngine']`),
        ]
      },
      {
        key: 'dram-bw', title: 'DRAM Bandwidth (MB/s)', height: 150, yMax: null,
        datasets: () => [
          makeDataset('Reads',  '#3fb950', h.dramReads,  `devices[${i}].gpu_metrics.average_dram_reads`),
          makeDataset('Writes', '#f85149', h.dramWrites, `devices[${i}].gpu_metrics.average_dram_writes`),
        ]
      },
      {
        key: 'npu-act', title: 'NPU Tile Activity (%)', height: 150, yMax: 100,
        coreData: () => h.npuBusy, coreUnit: '%',
        datasets: () => Array.from({length: 8}, (_, j) => ({
          label: `NPU Tile ${j}`,
          data: h.npuBusy[j],
          sourcePath: `devices[${i}].npu_metrics.npu_busy[${j}]`,
          borderColor: coreColor(j),
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.25,
          pointRadius: 0,
          borderWidth: 1,
        }))
      },
      {
        key: 'npu-clk', title: 'NPU Clocks (MHz)', height: 150, yMax: null,
        datasets: () => [
          makeDataset('NPU Clk',    '#bc8cff', h.npuClk,   `devices[${i}].npu_metrics.npuclk_freq`),
          makeDataset('MP-NPU Clk', '#8b949e', h.npuMpClk, `devices[${i}].npu_metrics.mpnpuclk_freq`),
        ]
      },
      {
        key: 'npu-bw', title: 'NPU Bandwidth (MB/s)', height: 150, yMax: null,
        datasets: () => [
          makeDataset('Reads',  '#3fb950', h.npuReads,  `devices[${i}].npu_metrics.npu_reads`),
          makeDataset('Writes', '#f85149', h.npuWrites, `devices[${i}].npu_metrics.npu_writes`),
        ]
      },
      {
        key: 'voltage', title: 'Voltage (mV)', height: 150, yMax: null,
        datasets: () => [
          makeDataset('VDDGFX', '#e3b341', h.vddgfx, `devices[${i}].Sensors['VDDGFX']`),
          makeDataset('VDDNB',  '#8b949e', h.vddnb,  `devices[${i}].Sensors['VDDNB']`),
        ]
      },
    ];

    chartDefs.forEach(def => {
      const chartKey = `${i}-${def.key}`;
      const box    = el('div', 'chart-box' + (def.wide ? ' chart-wide' : ''));
      box.id = `chart-box-${chartKey}`;
      box.style.display = 'none'; // revealed once data arrives
      const title  = el('div', 'chart-title', def.title);
      title.addEventListener('click', () => openOverlay(chartKey, def.title));
      const wrap   = el('div');
      wrap.style.height = (def.height || 160) + 'px';
      const canvas = el('canvas');
      wrap.appendChild(canvas);
      box.appendChild(title);
      box.appendChild(wrap);
      chartGrid.appendChild(box);

      const cfg = cloneDefaults();
      cfg.scales.x.ticks.stepSize = xStepSize(state.timeWidthMs);
      // Always use suggestedMin/Max (never hard min/max) so setAnnotations
      // can extend bounds with grace regardless of chart-setup defaults.
      if (!def.noYMin) cfg.scales.y.suggestedMin = 0;
      if (def.yMax != null) cfg.scales.y.suggestedMax = def.yMax;
      if (def.hideLegend) cfg.plugins.legend.display = false;
      cfg.plugins.tooltip.callbacks = def.coreData
        ? makeCoreChartCallbacks(h, def.coreData, def.coreUnit)
        : makeChartCallbacks(h);
      cfg.scales.y.ticks.callback = def.tickFmt ?? fmtTick;

      const chart = new Chart(canvas, {
        type: 'line',
        data: { labels: h.times, datasets: def.datasets() },
        options: cfg,
        plugins: def.coreData ? [verticalLinePlugin] : [],
      });
      chart._yFloorHint   = def.noYMin ? null : 0;
      chart._yCeilingHint = def.yMax ?? null;
      state.charts[chartKey] = chart;
    });

    panel.appendChild(chartGrid);

    // ── Per-CPU-core frequency plots (2 rows × 8) ──
    const coreFreqGrid = el('div', 'charts-cores');
    for (let j = 0; j < 16; j++) {
      const box    = el('div', 'chart-box');
      const title  = el('div', 'chart-title', `${coreLabel(j)} Clocks (MHz)`);
      title.addEventListener('click', () => openOverlay(`${i}-cpu-core-${j}`, `${coreLabel(j)} Clocks (MHz)`));
      const wrap   = el('div');
      wrap.style.height = '156px';
      const canvas = el('canvas');
      wrap.appendChild(canvas);
      box.appendChild(title);
      box.appendChild(wrap);
      coreFreqGrid.appendChild(box);

      const coreCfg = cloneDefaults();
      coreCfg.scales.x.ticks.stepSize = xStepSize(state.coreTimeWidthMs);
      coreCfg.scales.y.min = 0;
      coreCfg.scales.y.max = 6000;
      coreCfg.scales.x.grid = { color: '#21262d' };
      coreCfg.scales.y.grid = { display: true, color: 'rgba(48,54,61,0.8)' };
      coreCfg.plugins.legend.display  = true;
      coreCfg.plugins.legend.position = 'top';
      coreCfg.plugins.legend.align    = 'end';
      coreCfg.plugins.legend.labels   = {
        color: '#8b949e', font: { size: 9 },
        boxWidth: 14, boxHeight: 2, padding: 3,
        generateLabels: (chart) => chart.data.datasets.map((ds, k) => ({
          text:          ds._shortLabel || ds.label,
          fillStyle:     ds.borderColor,
          strokeStyle:   ds.borderColor,
          fontColor:     '#8b949e', // Chart.js doesn't fall back to labels.color here
          lineWidth:     ds.borderWidth || 1.5,
          lineDash:      ds.borderDash  || [],
          hidden:        !chart.isDatasetVisible(k),
          datasetIndex:  k,
        })),
      };
      coreCfg.plugins.tooltip.callbacks = makeChartCallbacks({ times: h.coreTimes });
      coreCfg.scales.y.ticks.callback = fmtTick;
      coreCfg.scales.y.ticks.font = { size: 9 };
      coreCfg.scales.y.ticks.maxTicksLimit = 7;
      coreCfg.scales.y.ticks.stepSize = 1000;

      state.charts[`${i}-cpu-core-${j}`] = new Chart(canvas, {
        type: 'line',
        data: {
          labels: h.coreTimes,
          datasets: [
            {
              label: 'Scaling',
              data: h.cpuScalingClk[j],
              sourcePath: `devices[${i}].Sensors['CPU Core freq'][${j}].cur_freq`,
              borderColor: coreColor(j),
              backgroundColor: 'transparent',
              fill: false,
              tension: 0.25,
              pointRadius: 0,
              borderWidth: 1.5,
            },
            {
              label: 'System Mgmt Unit',
              _shortLabel: 'SMU',
              data: h.coreClk[j],
              sourcePath: `devices[${i}].gpu_metrics.current_coreclk[${j}]`,
              borderColor: '#ffffff',
              backgroundColor: 'transparent',
              fill: false,
              tension: 0.25,
              pointRadius: 0,
              borderWidth: 1.5,
              borderDash: [3, 3],
            },
          ],
        },
        options: coreCfg,
      });
    }
    panel.appendChild(coreFreqGrid);



    // ── Process table ──
    const procSec = el('div', 'proc-section');
    procSec.appendChild(el('div', 'section-title', 'GPU / NPU Processes'));
    const tbl = el('table', 'proc-table');
    tbl.innerHTML = `
      <thead>
        <tr>
          <th>PID</th>
          <th>Name</th>
          <th>CPU%</th>
          <th>VRAM (MiB)</th>
          <th>GTT (MiB)</th>
          <th>GFX%</th>
          <th>Compute%</th>
          <th>DMA%</th>
          <th>Media%</th>
          <th>VCN%</th>
          <th>VPE%</th>
          <th>NPU%</th>
          <th>NPU Mem (MiB)</th>
        </tr>
      </thead>
      <tbody id="proc-body-${i}"></tbody>`;
    procSec.appendChild(tbl);
    panel.appendChild(procSec);

    main.appendChild(panel);
  });

  state.cur = 0;
  restoreCache();
}

function switchTab(idx) {
  if (idx === state.cur) return;
  document.querySelectorAll('.tab-btn').forEach((btn, i) => btn.classList.toggle('active', i === idx));
  document.querySelectorAll('.gpu-panel').forEach((p,  i) => p.classList.toggle('active',  i === idx));
  state.cur = idx;
  // Render newly visible tab's charts immediately (they may have skipped updates while hidden).
  const now = Date.now();
  for (const [key, c] of Object.entries(state.charts)) {
    if (parseInt(key, 10) !== idx) continue;
    const isCoreFreq = key.includes('-cpu-core-');
    c.options.scales.x.min = now - (isCoreFreq ? state.coreTimeWidthMs : state.timeWidthMs);
    c.options.scales.x.max = now;
    c.update('none');
  }
}

// ── Update helpers ───────────────────────────────────────────────────────────
function v(obj, key) {
  if (!obj || obj[key] == null) return null;
  const entry = obj[key];
  if (typeof entry === 'object' && 'value' in entry) return entry.value;
  if (typeof entry === 'number') return entry;
  return null;
}

function fmt(val, decimals) {
  if (val == null) return '—';
  return decimals != null ? val.toFixed(decimals) : String(Math.round(val));
}

function setCard(id, value, decimals) {
  const e = document.getElementById(id);
  if (!e) return;
  e.textContent = fmt(value, decimals);
  if (value != null && Number.isFinite(value)) state.cardLastData[id] = Date.now();
}

function setBar(id, pct) {
  const bar = document.getElementById(id + '-bar');
  if (bar) bar.style.width = (pct == null ? 0 : Math.min(100, Math.max(0, pct))) + '%';
}

function pushHistory(arr, val) {
  arr.copyWithin(0, 1);
  arr[arr.length - 1] = (val == null || !Number.isFinite(val)) ? NaN : val;
}

// Builds one vertical-line annotation for a process start/stop event.
// isCoreChart: label hidden by default, revealed on hover to save space.
function makeEventAnnotation(ev, isCoreChart) {
  const isStart    = ev.type === 'start';
  const lineColor  = isStart ? 'rgba(63,185,80,0.55)' : 'rgba(248,81,73,0.55)';
  const labelColor = isStart ? '#3fb950' : '#f85149';
  const ann = {
    type: 'line',
    xMin: ev.timeMs, xMax: ev.timeMs,
    drawTime: 'afterDraw',
    borderColor: lineColor, borderWidth: 1, borderDash: [3, 2],
    label: {
      display: !isCoreChart,
      content:  ev.pid != null ? [ev.name, `PID ${ev.pid}`] : [ev.name],
      rotation: -90,
      position: 'start',
      yAdjust:  0,
      color:    labelColor,
      font:     { size: 10 },
      backgroundColor: 'rgba(22,27,34,0.85)',
      padding:  { x: 3, y: 2 },
      xAdjust:  -16,
    },
  };
  if (isCoreChart) {
    ann.enter = function(ctx) {
      ctx.chart.options.plugins.annotation.annotations[ctx.id].label.display = true;
      ctx.chart.draw();
    };
    ann.leave = function(ctx) {
      ctx.chart.options.plugins.annotation.annotations[ctx.id].label.display = false;
      ctx.chart.draw();
    };
  }
  return ann;
}

// Keeps stable annotation objects for process events so hover state (label.display)
// survives across ticks.  New events get fresh objects; existing keys are reused.
// Also mutates chart.options.plugins.annotation.annotations in-place so event
// lines are visible without a full setAnnotations call (needed for core charts).
function syncEventAnnotations(chart, events, isCoreChart) {
  const prev = chart._eventAnnotations || {};
  const next = {};
  for (const ev of events) {
    const key = `ev_${ev.timeMs}_${ev.type}`;
    next[key] = prev[key] || makeEventAnnotation(ev, isCoreChart);
  }
  chart._eventAnnotations = next;
  const ann = chart.options.plugins.annotation.annotations;
  for (const k of Object.keys(ann)) if (k.startsWith('ev_')) delete ann[k];
  Object.assign(ann, next);
}

// Returns a min/max annotation object (does not modify the chart).
// Only considers values within the visible time window (times[k] >= windowStart).
// Labels are positioned below min and above max.
// Iterates directly to avoid intermediate array allocations on every tick.
function minMaxAnnotations(times, windowStart, ...arrays) {
  let minVal = Infinity, maxVal = -Infinity, count = 0;
  for (const arr of arrays) {
    for (let k = 0; k < arr.length; k++) {
      const v = arr[k];
      if (!Number.isFinite(v)) continue;
      if (windowStart != null && (times[k] == null || times[k] < windowStart)) continue;
      if (v < minVal) minVal = v;
      if (v > maxVal) maxVal = v;
      count++;
    }
  }
  if (count < 2) return {};
  const color    = 'rgba(139,148,158,0.6)';
  const fmtA     = x => (x.toFixed(3));
  const labelBase = { color, font: { size: 9 }, backgroundColor: 'rgba(22,27,34,0.92)', borderColor: 'transparent', borderWidth: 0, padding: { x: 3, y: 1 } };
  const out = {};
  out.minLine = {
    type: 'line', yMin: minVal, yMax: minVal, drawTime: 'afterDraw',
    borderColor: color, borderWidth: 1, borderDash: [3, 3],
    label: { ...labelBase, display: true, content: fmtA(minVal), position: 'start', yAdjust: 9 },
  };
  if (maxVal !== minVal) {
    out.maxLine = {
      type: 'line', yMin: maxVal, yMax: maxVal, drawTime: 'afterDraw',
      borderColor: color, borderWidth: 1, borderDash: [3, 3],
      label: { ...labelBase, display: true, content: fmtA(maxVal), position: 'end', yAdjust: -9 },
    };
  }
  return out;
}

function makeLimitLine(val, label, color, unit, position) {
  return {
    type: 'line', yMin: val, yMax: val, drawTime: 'afterDraw',
    borderColor: color, borderWidth: 1, borderDash: [6, 4],
    label: {
      display: true,
      content: `${label} ${val.toFixed(3)}${unit}`,
      position: position ?? 'center',
      color,
      font: { size: 9 },
      backgroundColor: 'rgba(22,27,34,0.85)',
      borderColor: 'transparent',
      borderWidth: 0,
      padding: { x: 4, y: 2 },
    },
  };
}

// Assigns evenly-spaced label positions ("20%", "40%", …) across present
// limit lines so their label backgrounds don't stack when values are close.
function staggerLimitPositions(specs) {
  const present = specs.filter(s => s.val != null);
  const n = present.length;
  if (n === 0) return [];
  const step = 100 / (n + 1);
  return present.map((s, i) => ({ ...s, position: `${Math.round(step * (i + 1))}%` }));
}

function powerLimitAnnotations() {
  const pl = state.powerLimits;
  const out = {};
  const specs = staggerLimitPositions([
    { key: 'stapLine',    val: pl.stapm_w,    label: 'STAPM',    color: '#e3b341', unit: 'W' },
    { key: 'fastLine',    val: pl.fast_w,     label: 'Fast',     color: '#f85149', unit: 'W' },
    { key: 'slowLine',    val: pl.slow_w,     label: 'Slow',     color: '#3fb950', unit: 'W' },
    { key: 'apuSlowLine', val: pl.apu_slow_w, label: 'APU Slow', color: '#bc8cff', unit: 'W' },
  ]);
  for (const s of specs) out[s.key] = makeLimitLine(s.val, s.label, s.color, s.unit, s.position);
  return out;
}

function temperatureLimitAnnotations() {
  const pl = state.powerLimits;
  const out = {};
  const specs = staggerLimitPositions([
    { key: 'thmCoreLine', val: pl.thm_core_c, label: 'THM Core', color: '#e3b341', unit: '°C' },
    { key: 'thmGfxLine',  val: pl.thm_gfx_c,  label: 'THM GFX',  color: '#f85149', unit: '°C' },
    { key: 'thmSocLine',  val: pl.thm_soc_c,  label: 'THM SoC',  color: '#388bfd', unit: '°C' },
  ]);
  for (const s of specs) out[s.key] = makeLimitLine(s.val, s.label, s.color, s.unit, s.position);
  return out;
}

// VRAM chart gets two ceiling lines: total GPU-addressable memory (VRAM+GTT)
// and total system physical memory. On unified-memory APUs the system RAM
// total already includes the VRAM carve-out, so we use it directly rather
// than summing with VRAM+GTT. Plotted in GiB to match the chart's y-axis.
function memoryLimitAnnotations(h) {
  const out = {};
  const combinedGiB = h.vramMax; // already GiB
  const ramGiB      = state.totalRAMMiB != null ? state.totalRAMMiB / 1024 : null;
  const specs = staggerLimitPositions([
    { key: 'vramGttLine', val: combinedGiB > 0 ? combinedGiB : null,
      label: 'VRAM+GTT', color: '#e3b341', unit: ' GiB' },
    { key: 'physLine',    val: ramGiB,
      label: 'Phys Mem', color: '#f85149', unit: ' GiB' },
  ]);
  for (const s of specs) out[s.key] = makeLimitLine(s.val, s.label, s.color, s.unit, s.position);
  return out;
}

function setAnnotations(chart, times, extra, ...arrays) {
  const mm = minMaxAnnotations(times, chart.options.scales.x.min, ...arrays);
  chart.options.plugins.annotation.annotations = { ...mm, ...extra };

  // Always re-apply %-of-range grace. Range covers data min/max AND any
  // line-type annotation values (limit lines) so that explicitly-set limits
  // are never pushed off-screen by a narrow data range.
  const opts = chart.options.scales.y;
  let lo = Infinity, hi = -Infinity;
  if (mm.minLine) { lo = Math.min(lo, mm.minLine.yMin); hi = Math.max(hi, mm.minLine.yMin); }
  if (mm.maxLine) { lo = Math.min(lo, mm.maxLine.yMax); hi = Math.max(hi, mm.maxLine.yMax); }
  for (const ann of Object.values(extra || {})) {
    if (ann?.type === 'line' && Number.isFinite(ann.yMin)) {
      lo = Math.min(lo, ann.yMin);
      hi = Math.max(hi, ann.yMin);
    }
  }
  if (Number.isFinite(lo) && Number.isFinite(hi)) {
    const range = (hi - lo) || Math.max(Math.abs(hi), 1);
    const pad   = range * 0.18;
    const floor = chart._yFloorHint;
    const ceil  = chart._yCeilingHint;
    opts.suggestedMin = floor != null ? Math.min(lo - pad, floor) : lo - pad;
    opts.suggestedMax = ceil  != null ? Math.max(hi + pad, ceil)  : hi + pad;
  }
}

function updateDevice(i, dev) {
  if (i === 0) { state.lastDev0 = dev; updateDeviceInfoHeader(dev); }
  const h     = state.hist[i];
  const act   = dev.gpu_activity || {};
  const vram  = dev.VRAM         || {};
  const sens  = dev.Sensors      || {};
  const grbm  = dev.GRBM         || {};
  const grbm2 = dev.GRBM2        || {};

  // ── Read values ──
  const gfx    = v(act,  'GFX');
  const mem    = v(act,  'Memory');
  const media  = v(act,  'MediaEngine');
  const vramU  = v(vram, 'Total VRAM Usage');
  const vramT  = v(vram, 'Total VRAM');
  const gttU   = v(vram, 'Total GTT Usage');
  const gttT   = v(vram, 'Total GTT');
  const sclk   = v(sens, 'GFX_SCLK');
  const mclk   = v(sens, 'GFX_MCLK');
  const fclk   = v(sens, 'FCLK');
  const gfxPwr = v(sens, 'GFX Power');
  const pwr    = v(sens, 'Average Power') ?? v(sens, 'Socket Power') ?? v(sens, 'Input Power') ?? gfxPwr;
  const tempE  = v(sens, 'Edge Temperature');
  const cputmp = v(sens, 'CPU Tctl');
  const vddgfx = v(sens, 'VDDGFX') || null;  // 0 = sensor not populated, treat as no-data
  const vddnb  = v(sens, 'VDDNB')  || null;
  const gm = dev.gpu_metrics || {};
  const tempSRaw   = gm.temperature_soc     ?? null;
  const tempS      = tempSRaw   != null ? tempSRaw   / 100 : null;
  const tempGfxRaw = gm.temperature_gfx     ?? null;
  const tempGfx    = tempGfxRaw != null ? tempGfxRaw / 100 : null;
  const tempHotRaw = gm.temperature_hotspot ?? null;
  const tempHot    = tempHotRaw != null ? tempHotRaw / 100 : null;
  const tempMemRaw = gm.temperature_mem     ?? null;
  const tempMem    = tempMemRaw != null ? tempMemRaw / 100 : null;

  const combinedU = (vramU != null && gttU != null) ? vramU + gttU
                  : (vramU ?? gttU);
  const combinedT = (vramT != null && gttT != null) ? vramT + gttT
                  : (vramT ?? gttT);

  // ── Stat cards ──
  setCard(`c-gfx-${i}`,    gfx);
  setCard(`c-media-${i}`,  media);
  setCard(`c-sclk-${i}`,   sclk);
  setCard(`c-mclk-${i}`,   mclk);
  setCard(`c-fclk-${i}`,   fclk);
  setCard(`c-pwr-${i}`,    pwr,    1);
  setCard(`c-etmp-${i}`,   tempE,  1);
  setCard(`c-cputmp-${i}`, cputmp, 1);
  setCard(`c-vddgfx-${i}`, vddgfx);
  setCard(`c-vddnb-${i}`,  vddnb);

  // Total GPU memory card: combined (VRAM+GTT) usage as a percentage
  const vmemEl = document.getElementById(`c-vmem-${i}`);
  if (vmemEl) {
    const vmemPct = combinedT > 0 ? combinedU / combinedT * 100 : null;
    vmemEl.textContent = vmemPct != null ? vmemPct.toFixed(3) : '—';
    if (combinedU != null || combinedT != null) state.cardLastData[`c-vmem-${i}`] = Date.now();
  }

  // VRAM card: two spans — used (c-vram-${i}-u) and total (c-vram-${i}-t)
  const vramUEl = document.getElementById(`c-vram-${i}-u`);
  const vramTEl = document.getElementById(`c-vram-${i}-t`);
  if (vramUEl) vramUEl.textContent = vramU != null ? (vramU/1024).toFixed(3) : '—';
  if (vramTEl) vramTEl.textContent = vramT != null ? (vramT/1024).toFixed(3) : '—';
  if (vramU != null || vramT != null) state.cardLastData[`c-vram-${i}`] = Date.now();

  // GTT card: two spans — used (c-gtt-${i}-u) and total (c-gtt-${i}-t)
  const gttUEl = document.getElementById(`c-gtt-${i}-u`);
  const gttTEl = document.getElementById(`c-gtt-${i}-t`);
  if (gttUEl) gttUEl.textContent = gttU != null ? (gttU/1024).toFixed(3) : '—';
  if (gttTEl) gttTEl.textContent = gttT != null ? (gttT/1024).toFixed(3) : '—';
  if (gttU != null || gttT != null) state.cardLastData[`c-gtt-${i}`] = Date.now();

  // CPU usage card (sourced from /api/system 1 Hz push)
  const cpuNow = Date.now();
  const cpuFresh = state.lastCPU.value != null && (cpuNow - state.lastCPU.receivedAt) < 3000;
  setCard(`c-cpu-${i}`, cpuFresh ? state.lastCPU.value : null, 1);

  // ── Memory overview bar ──
  const sysInfo = state.systemInfo;
  if (sysInfo && vramT > 0) {
    const mk       = sysInfo.meminfo_kb    ?? {};
    const memRes   = sysInfo.mem_reservation ?? {};
    const drmMem   = sysInfo.drm_mem        ?? {};
    const totalKB  = mk.MemTotal ?? (sysInfo.total_ram_mib * 1024);

    // All /proc/meminfo values are in kB.  GTT/VRAM come from amdgpu in MiB.
    const gttKB      = (gttU ?? 0) * 1024;
    const drmCpuKB   = drmMem.total_cpu_kib ?? 0;       // DRM pinned in CPU/system domain
    const anonKB     = mk.AnonPages    ?? 0;
    const shmemKB    = mk.Shmem        ?? 0;
    const bufKB      = mk.Buffers      ?? 0;
    const cachedAllKB = mk.Cached      ?? 0;
    const cachedKB   = Math.max(0, cachedAllKB - shmemKB); // file cache only
    const sreclmKB   = mk.SReclaimable ?? 0;
    const sunrecKB   = mk.SUnreclaim   ?? 0;
    // Percpu is a subset of VmallocUsed on modern kernels — do NOT add it.
    const vmallocKB  = mk.VmallocUsed  ?? 0;
    const kstackKB   = mk.KernelStack  ?? 0;
    const ptablesKB  = (mk.PageTables  ?? 0) + (mk.SecPageTables ?? 0);
    const netbufKB   = sysInfo.sock_mem_kb ?? 0;
    const freeKB     = mk.MemFree      ?? 0;

    // Driver Pages: residual after every named bucket.  Represents direct
    // alloc_pages() by kernel drivers that isn't covered by slab, vmalloc,
    // stack, page tables, socket buffers, or DRM accounting — typically
    // DMA-coherent allocations, NIC page_pool buffers, and small driver state.
    const namedKB  = gttKB + drmCpuKB + anonKB + shmemKB + cachedKB + bufKB
                   + sreclmKB + sunrecKB + vmallocKB + kstackKB + ptablesKB
                   + netbufKB;
    const drvpgKB  = Math.max(0, totalKB - freeKB - namedKB);

    // Kernel-reserved DRAM: in e820 System RAM but not MemTotal
    // (crashkernel, initrd, kernel image, early-boot reservations).
    const sysRamMiB    = memRes.system_ram_mib ?? 0;
    const kernelResMiB = Math.max(0, sysRamMiB - totalKB / 1024);

    // Firmware-reserved DRAM (non-VRAM part).  VRAM is its own segment.
    const fwReservedMiB = Math.max(0, (sysInfo.firmware_reserved_mib ?? 0) - vramT);

    // Authoritative installed DRAM from MSRs; fall back otherwise.
    const installedMiB = memRes.installed_mib
                      ?? (vramT + fwReservedMiB + kernelResMiB + totalKB / 1024);

    // VRAM visible/invisible split from /sys/class/drm/*/mem_info_*.
    // amdgpu_top used/total are in MiB; sysfs fields in MiB via Go conversion.
    const vramUsed      = vramU ?? 0;
    const vramVisUsed   = drmMem.vis_vram_used_mib ?? vramUsed;
    const vramInvUsed   = Math.max(0, vramUsed - vramVisUsed);

    const byId = id => document.getElementById(id);

    // Outer bar geometry — widths expressed as % of installed DRAM.
    const pctInst = mib => `${mib / installedMiB * 100}%`;
    const vramPartEl = byId(`mem-vram-part-${i}`);
    if (vramPartEl) vramPartEl.style.width = pctInst(vramT);
    const setSegMiB = (el, mib) => { if (!el) return; el.style.width = pctInst(mib); el.style.minWidth = mib > 0 ? '1px' : ''; };
    const vramVisEl = byId(`mem-vram-vis-${i}`);
    if (vramVisEl) { vramVisEl.style.width = `${vramVisUsed / vramT * 100}%`; vramVisEl.style.minWidth = vramVisUsed > 0 ? '1px' : ''; }
    const vramInvEl = byId(`mem-vram-inv-${i}`);
    if (vramInvEl) { vramInvEl.style.width = `${vramInvUsed / vramT * 100}%`; vramInvEl.style.minWidth = vramInvUsed > 0 ? '1px' : ''; }
    setSegMiB(byId(`mem-kres-${i}`), kernelResMiB);
    setSegMiB(byId(`mem-fw-${i}`),   fwReservedMiB);

    // Inside sys-part each sub-segment is a fraction of MemTotal (sys-part
    // itself flexes to fill MemTotal's share).  The free segment is flex:1
    // and swallows the remainder.
    const pctSys = kb => `${kb / totalKB * 100}%`;
    const setSeg = (id, kb) => { const e = byId(id); if (e) { e.style.width = pctSys(kb); e.style.minWidth = kb > 0 ? "1px" : ""; } };
    setSeg(`mem-gtt-used-${i}`, gttKB);
    setSeg(`mem-drmcpu-${i}`,   drmCpuKB);
    setSeg(`mem-anon-${i}`,     anonKB);
    setSeg(`mem-shmem-${i}`,    shmemKB);
    setSeg(`mem-cached-${i}`,   cachedKB);
    setSeg(`mem-buf-${i}`,      bufKB);
    setSeg(`mem-sreclm-${i}`,   sreclmKB);
    setSeg(`mem-sunrec-${i}`,   sunrecKB);
    setSeg(`mem-vmalloc-${i}`,  vmallocKB);
    setSeg(`mem-kstack-${i}`,   kstackKB);
    setSeg(`mem-ptables-${i}`,  ptablesKB);
    setSeg(`mem-netbuf-${i}`,   netbufKB);
    setSeg(`mem-drvpg-${i}`,    drvpgKB);

    const fmtGiB = kb => `${(kb / 1024 / 1024).toFixed(3)} GiB`;
    const set = (id, v) => { const e = byId(id); if (e) e.textContent = v; };
    set(`mem-lbl-vram-free-${i}`, fmtGiB((vramT - vramUsed) * 1024));
    set(`mem-lbl-vram-vis-${i}`,  fmtGiB(vramVisUsed * 1024));
    set(`mem-lbl-vram-inv-${i}`,  fmtGiB(vramInvUsed * 1024));
    set(`mem-lbl-gtt-${i}`,       fmtGiB(gttKB));
    set(`mem-lbl-drmcpu-${i}`,    fmtGiB(drmCpuKB));
    set(`mem-lbl-anon-${i}`,      fmtGiB(anonKB));
    set(`mem-lbl-shmem-${i}`,     fmtGiB(shmemKB));
    set(`mem-lbl-cached-${i}`,    fmtGiB(cachedKB));
    set(`mem-lbl-buf-${i}`,       fmtGiB(bufKB));
    set(`mem-lbl-sreclm-${i}`,    fmtGiB(sreclmKB));
    set(`mem-lbl-sunrec-${i}`,    fmtGiB(sunrecKB));
    set(`mem-lbl-vmalloc-${i}`,   fmtGiB(vmallocKB));
    set(`mem-lbl-kstack-${i}`,    fmtGiB(kstackKB));
    set(`mem-lbl-ptables-${i}`,   fmtGiB(ptablesKB));
    set(`mem-lbl-netbuf-${i}`,    fmtGiB(netbufKB));
    set(`mem-lbl-drvpg-${i}`,     fmtGiB(drvpgKB));
    set(`mem-lbl-free-${i}`,      fmtGiB(freeKB));
    set(`mem-lbl-kres-${i}`,      fmtGiB(kernelResMiB * 1024));
    set(`mem-lbl-fw-${i}`,        fmtGiB(fwReservedMiB * 1024));
    set(`mem-lbl-dmabuf-${i}`,    fmtGiB((sysInfo.dma_buf_bytes ?? 0) / 1024));
    set(`mem-lbl-total-${i}`,     (installedMiB / 1024).toFixed(3));

    const usedKB = totalKB - freeKB;
    const nonGttTotalKB = totalKB - (gttT ?? 0) * 1024;
    const marginKB      = nonGttTotalKB - (usedKB - gttKB);
    set(`mem-lbl-nongtt-${i}`,  (nonGttTotalKB / 1024 / 1024).toFixed(3));
    set(`mem-lbl-margin-${i}`,  (marginKB / 1024 / 1024).toFixed(3));
    const marginEl = byId(`mem-lbl-margin-${i}`);
    if (marginEl) marginEl.style.color = marginKB < 0 ? 'var(--red)' : '';
  }

  // Progress bars
  setBar(`c-gfx-${i}`,   gfx);
  setBar(`c-media-${i}`, media);
  setBar(`c-vmem-${i}`,  combinedT > 0 ? combinedU / combinedT * 100 : null);
  setBar(`c-vram-${i}`,  vramT  > 0 ? vramU  / vramT  * 100 : null);
  setBar(`c-gtt-${i}`,   gttT   > 0 ? gttU   / gttT   * 100 : null);
  setBar(`c-cpu-${i}`,   cpuFresh ? state.lastCPU.value : null);

  // ── History ──
  const nowMs = Date.now();
  // If the gap since the last sample exceeds the idle threshold (same 10%-of-
  // window debounce used to suppress idle charts in scheduleRender), inject NaN
  // so Chart.js breaks the line instead of connecting across the discontinuity.
  // This catches WebSocket reconnects after reboots/pauses without a page reload.
  const idleMs = state.timeWidthMs * 0.1;
  if (nowMs - h.times[h.times.length - 1] > idleMs)
    shiftHistGap(h, Math.round((nowMs - h.times[h.times.length - 1]) / state.intervalMs), state.intervalMs);

  pushHistory(h.times,     nowMs);
  pushHistory(h.coreTimes, nowMs);
  pushHistory(h.gfx,   gfx);
  pushHistory(h.mem,   mem);
  pushHistory(h.media, media);
  pushHistory(h.vram,    combinedU != null ? combinedU / 1024 : null);
  pushHistory(h.vramOnly, vramU   != null ? vramU    / 1024 : null);
  pushHistory(h.gttOnly,  gttU    != null ? gttU     / 1024 : null);
  const cpuPwrAllMW = typeof gm.average_all_core_power === 'number' ? gm.average_all_core_power : null;
  const npuPwrMW    = typeof gm.average_ipu_power     === 'number' ? gm.average_ipu_power     : null;
  pushHistory(h.pwr,    pwr);
  // PPT comes from /api/system at ~1 Hz; drop it if the last poll is stale
  // (e.g. server paused) so the chart line breaks rather than flat-lining.
  const pptFresh = state.lastPPT.value != null && (nowMs - state.lastPPT.receivedAt) < 3000;
  pushHistory(h.ppt,    pptFresh ? state.lastPPT.value : null);
  // Fan comes from /api/system at ~1 Hz; drop it if the last poll is stale
  // (e.g. server paused) so the chart line breaks rather than flat-lining.
  const fanFresh = state.lastFan.value != null && (nowMs - state.lastFan.receivedAt) < 3000;
  pushHistory(h.fan,    fanFresh ? state.lastFan.value : null);
  pushHistory(h.cpuPwr, cpuPwrAllMW != null ? cpuPwrAllMW / 1000 : null);
  pushHistory(h.npuPwr, npuPwrMW    != null ? npuPwrMW    / 1000 : null);
  pushHistory(h.tempE,  tempE);
  pushHistory(h.tempC,  cputmp);
  pushHistory(h.tempS,  tempS);
  pushHistory(h.tempGfx, tempGfx);
  pushHistory(h.tempHot, tempHot);
  pushHistory(h.tempMem, tempMem);
  pushHistory(h.sclk,   sclk);
  pushHistory(h.mclk,   mclk);
  pushHistory(h.fclk,   fclk);
  pushHistory(h.fclkAvg, typeof gm.average_fclk_frequency  === 'number' ? gm.average_fclk_frequency  : null);
  pushHistory(h.socClk,  typeof gm.average_socclk_frequency === 'number' ? gm.average_socclk_frequency : null);
  pushHistory(h.vclk,    typeof gm.average_vclk_frequency  === 'number' ? gm.average_vclk_frequency  : null);
  pushHistory(h.vddgfx,  vddgfx);
  pushHistory(h.vddnb,   vddnb);
  pushHistory(h.dramReads,  typeof gm.average_dram_reads  === 'number' ? gm.average_dram_reads  : null);
  pushHistory(h.dramWrites, typeof gm.average_dram_writes === 'number' ? gm.average_dram_writes : null);

  const nm = dev.npu_metrics || {};
  const npuBusyArr = Array.isArray(nm.npu_busy) ? nm.npu_busy : [];
  for (let j = 0; j < 8; j++) {
    const bv = npuBusyArr[j];
    pushHistory(h.npuBusy[j], (bv != null && bv < 65535) ? bv : null);
  }
  pushHistory(h.npuClk,   typeof nm.npuclk_freq   === 'number' ? nm.npuclk_freq   : null);
  pushHistory(h.npuMpClk, typeof nm.mpnpuclk_freq === 'number' ? nm.mpnpuclk_freq : null);
  pushHistory(h.npuReads,  typeof nm.npu_reads  === 'number' ? nm.npu_reads  : null);
  pushHistory(h.npuWrites, typeof nm.npu_writes === 'number' ? nm.npu_writes : null);

  const sensFreqs  = Array.isArray(sens['CPU Core freq']) ? sens['CPU Core freq'] : [];
  const avgCorePwr = Array.isArray(gm.average_core_power) ? gm.average_core_power : [];
  const curCoreClk = Array.isArray(gm.current_coreclk)   ? gm.current_coreclk   : [];
  for (let j = 0; j < 16; j++) {
    const pwrMW      = (avgCorePwr[j] != null && avgCorePwr[j] < 65535) ? avgCorePwr[j] : null;
    const clkMHz     = (curCoreClk[j] != null && curCoreClk[j] < 65535) ? curCoreClk[j] : null;
    const scalingMHz = sensFreqs[j]?.cur_freq ?? null;
    pushHistory(h.corePwr[j],       pwrMW != null ? pwrMW / 1000 : null);
    pushHistory(h.coreClk[j],       clkMHz);
    pushHistory(h.cpuScalingClk[j], scalingMHz);
  }

  if (combinedT != null && combinedT > 0) h.vramMax = combinedT / 1024;  // MiB → GiB

  // ── Chart options (scale/annotations) — rendering is batched via scheduleRender ──
  const cAct     = state.charts[`${i}-activity`];
  const cVram    = state.charts[`${i}-vram`];
  const cPwr     = state.charts[`${i}-power`];
  const cFan     = state.charts[`${i}-fan`];
  const cTemp    = state.charts[`${i}-temp`];
  const cGfxClk  = state.charts[`${i}-gfx-clk`];
  const cCorePwr = state.charts[`${i}-core-pwr`];
  const cVoltage = state.charts[`${i}-voltage`];
  const cDramBw  = state.charts[`${i}-dram-bw`];
  const cNpuAct  = state.charts[`${i}-npu-act`];
  const cNpuClk  = state.charts[`${i}-npu-clk`];
  const cNpuBw   = state.charts[`${i}-npu-bw`];

  if (cVram) cVram._yCeilingHint = h.vramMax;

  if (cAct)     setAnnotations(cAct,    h.times, {},                          h.gfx, h.mem, h.media);
  if (cVram)    setAnnotations(cVram,   h.times, memoryLimitAnnotations(h),   h.vram, h.vramOnly, h.gttOnly);
  if (cPwr)     setAnnotations(cPwr,    h.times, powerLimitAnnotations(),     h.pwr, h.ppt, h.cpuPwr, h.npuPwr);
  if (cFan)     setAnnotations(cFan,    h.times, {},                          h.fan);
  if (cTemp)    setAnnotations(cTemp,   h.times, temperatureLimitAnnotations(), h.tempE, h.tempC, h.tempS, h.tempGfx, h.tempHot, h.tempMem);
  if (cGfxClk)  setAnnotations(cGfxClk, h.times, {},                         h.sclk, h.mclk, h.fclk, h.fclkAvg, h.socClk, h.vclk);
  if (cVoltage) setAnnotations(cVoltage, h.times, {},                         h.vddgfx, h.vddnb);
  if (cCorePwr) setAnnotations(cCorePwr, h.times, {},                         ...h.corePwr);
  if (cDramBw)  setAnnotations(cDramBw,  h.times, {},                         h.dramReads, h.dramWrites);
  if (cNpuAct)  setAnnotations(cNpuAct,  h.times, {},                         ...h.npuBusy);
  if (cNpuClk)  setAnnotations(cNpuClk,  h.times, {},                         h.npuClk, h.npuMpClk);
  if (cNpuBw)   setAnnotations(cNpuBw,   h.times, {},                         h.npuReads, h.npuWrites);

  if (state.overlayChart && state.overlayChartKey) {
    const oc  = state.overlayChartKey;
    const ovl = state.overlayChart;
    if      (oc === `${i}-activity`) setAnnotations(ovl, h.times, {},                             h.gfx, h.mem, h.media);
    else if (oc === `${i}-vram`)   { ovl._yCeilingHint = h.vramMax;
                                     setAnnotations(ovl, h.times, memoryLimitAnnotations(h),      h.vram, h.vramOnly, h.gttOnly); }
    else if (oc === `${i}-power`)    setAnnotations(ovl, h.times, powerLimitAnnotations(),        h.pwr, h.ppt, h.cpuPwr, h.npuPwr);
    else if (oc === `${i}-fan`)      setAnnotations(ovl, h.times, {},                             h.fan);
    else if (oc === `${i}-temp`)     setAnnotations(ovl, h.times, temperatureLimitAnnotations(),  h.tempE, h.tempC, h.tempS, h.tempGfx, h.tempHot, h.tempMem);
    else if (oc === `${i}-gfx-clk`) setAnnotations(ovl, h.times, {},                             h.sclk, h.mclk, h.fclk, h.fclkAvg, h.socClk, h.vclk);
    else if (oc === `${i}-voltage`) setAnnotations(ovl, h.times, {},                             h.vddgfx, h.vddnb);
    else if (oc === `${i}-core-pwr`) setAnnotations(ovl, h.times, {},                            ...h.corePwr);
    else if (oc === `${i}-dram-bw`)  setAnnotations(ovl, h.times, {},                            h.dramReads, h.dramWrites);
    else if (oc === `${i}-npu-act`)  setAnnotations(ovl, h.times, {},                            ...h.npuBusy);
    else if (oc === `${i}-npu-clk`)  setAnnotations(ovl, h.times, {},                            h.npuClk, h.npuMpClk);
    else if (oc === `${i}-npu-bw`)   setAnnotations(ovl, h.times, {},                            h.npuReads, h.npuWrites);
  }

  // Mark which charts received finite data this tick so scheduleRender can
  // skip charts that are entirely idle (e.g. NPU on a non-NPU system).
  const devPrefix = `${i}-`;
  for (const [key, chart] of Object.entries(state.charts)) {
    if (!key.startsWith(devPrefix)) continue;
    const hasData = chart.config.data.datasets.some(
      ds => ds.data?.length && Number.isFinite(ds.data[ds.data.length - 1])
    );
    if (hasData) state.chartLastData[key] = nowMs;
  }

  scheduleRender();

  // ── GRBM performance counters ──
  GRBM_KEYS.forEach((key, ki) => {
    const val = v(grbm, key);
    const ve  = document.getElementById(`grbm-val-${i}-${ki}`);
    const be  = document.getElementById(`grbm-bar-${i}-${ki}`);
    if (ve) ve.textContent = val != null ? val.toFixed(0) + '%' : '—';
    if (be) be.style.width = (val != null ? Math.min(100, Math.max(0, val)) : 0) + '%';
    pushHistory(h.grbm[ki], val);
  });

  GRBM2_KEYS.forEach((key, ki) => {
    const val = v(grbm2, key);
    const ve  = document.getElementById(`grbm2-val-${i}-${ki}`);
    const be  = document.getElementById(`grbm2-bar-${i}-${ki}`);
    if (ve) ve.textContent = val != null ? val.toFixed(0) + '%' : '—';
    if (be) be.style.width = (val != null ? Math.min(100, Math.max(0, val)) : 0) + '%';
    pushHistory(h.grbm2[ki], val);
  });

  // ── Process table ──
  const tbody = document.getElementById(`proc-body-${i}`);
  if (!tbody) return;

  // amdgpu_top nests metrics at proc.usage.usage; fall back to proc.usage or proc
  // for older versions that use shallower nesting.
  const getUsage = (p) => p?.usage?.usage || p?.usage || p;

  // Merge GPU fdinfo and XDNA (NPU) fdinfo by PID into a single map.
  const fdinfo     = dev.fdinfo      || {};
  const xdnaFdinfo = dev.xdna_fdinfo || {};
  const procMap    = {};
  for (const [pid, proc] of Object.entries(fdinfo))     procMap[pid] = { gpuProc: proc, npuProc: null };
  for (const [pid, proc] of Object.entries(xdnaFdinfo)) {
    if (procMap[pid]) procMap[pid].npuProc = proc;
    else              procMap[pid] = { gpuProc: null, npuProc: proc };
  }

  const pids = Object.keys(procMap);

  // ── Process start/stop event detection ──
  const currentProcNames = new Map();
  for (const pid of pids) {
    const proc = procMap[pid].gpuProc || procMap[pid].npuProc;
    currentProcNames.set(pid, proc?.name || `PID ${pid}`);
  }
  for (const [pid] of currentProcNames) {
    if (!h.prevProcNames.has(pid) && !h.earlyStartedPids.has(pid)) {
      const name = currentProcNames.get(pid);
      h.events.push({ timeMs: nowMs, type: 'start', name, pid: Number(pid) });
      appendLog(`Process start: ${name} (PID ${pid})`, 'ok');
    }
  }
  for (const [pid, name] of h.prevProcNames) {
    if (!currentProcNames.has(pid)) {
      h.events.push({ timeMs: nowMs, type: 'stop', name, pid: Number(pid) });
      h.earlyStartedPids.delete(pid); // allow re-detection if PID is reused
      appendLog(`Process stop: ${name} (PID ${pid})`, 'warn');
    }
  }
  h.prevProcNames = currentProcNames;
  const oldest = nowMs - Math.max(state.timeWidthMs, state.coreTimeWidthMs);
  while (h.events.length && h.events[0].timeMs < oldest) h.events.shift();
  for (const [key, chart] of Object.entries(state.charts)) {
    if (key.startsWith(devPrefix))
      syncEventAnnotations(chart, h.events, key.includes('-cpu-core-'));
  }

  if (pids.length === 0) {
    tbody.innerHTML = `<tr><td colspan="13" class="proc-empty" style="padding:12px 16px">No GPU / NPU processes</td></tr>`;
    return;
  }

  const gpuVram = (gpuProc) => {
    if (!gpuProc) return 0;
    const u = getUsage(gpuProc);
    return v(u, 'VRAM') ?? v(u, 'vram_usage') ?? v(u, 'vram') ?? 0;
  };
  pids.sort((a, b) => gpuVram(procMap[b].gpuProc) - gpuVram(procMap[a].gpuProc));

  tbody.innerHTML = pids.map(pid => {
    const { gpuProc, npuProc } = procMap[pid];
    const proc    = gpuProc || npuProc;
    const u       = gpuProc ? getUsage(gpuProc) : null;
    const nu      = npuProc ? getUsage(npuProc) : null;
    const vram    = u ? (v(u, 'VRAM')       ?? v(u, 'vram_usage') ?? v(u, 'vram'))  : null;
    const gtt     = u ? (v(u, 'GTT')        ?? v(u, 'gtt_usage')  ?? v(u, 'gtt'))   : null;
    const gfx     = u ? v(u, 'GFX')         : null;
    const compute = u ? v(u, 'Compute')     : null;
    const dma     = u ? v(u, 'DMA')         : null;
    const media   = u ? v(u, 'Media')       : null;
    const vcn     = u ? (v(u, 'VCN_Unified') ?? v(u, 'VCN_JPEG') ?? v(u, 'Decode')) : null;
    const vpe     = u ? v(u, 'VPE')         : null;
    const cpu     = u ? (v(u, 'CPU')        ?? v(u, 'cpu_usage')  ?? v(u, 'cpu'))   : null;
    const npu     = nu ? v(nu, 'NPU')       : null;
    const npuMem  = nu ? (v(nu, 'NPU Mem') ?? v(nu, 'npu_mem') ?? v(nu, 'npu_memory')) : null;
    return `<tr>
      <td class="proc-pid">${pid}</td>
      <td class="proc-name">${proc.name || '?'}</td>
      <td data-src="devices[${i}].fdinfo[${pid}].usage.CPU">${fmt(cpu,         0)}</td>
      <td data-src="devices[${i}].fdinfo[${pid}].usage.VRAM">${fmt(vram,       0)}</td>
      <td data-src="devices[${i}].fdinfo[${pid}].usage.GTT">${fmt(gtt,         0)}</td>
      <td data-src="devices[${i}].fdinfo[${pid}].usage.GFX">${fmt(gfx,         0)}</td>
      <td data-src="devices[${i}].fdinfo[${pid}].usage.Compute">${fmt(compute, 0)}</td>
      <td data-src="devices[${i}].fdinfo[${pid}].usage.DMA">${fmt(dma,         0)}</td>
      <td data-src="devices[${i}].fdinfo[${pid}].usage.Media">${fmt(media,     0)}</td>
      <td data-src="devices[${i}].fdinfo[${pid}].usage.VCN_Unified">${fmt(vcn, 0)}</td>
      <td data-src="devices[${i}].fdinfo[${pid}].usage.VPE">${fmt(vpe,         0)}</td>
      <td data-src="devices[${i}].xdna_fdinfo[${pid}].usage.NPU">${fmt(npu,    0)}</td>
      <td data-src="devices[${i}].xdna_fdinfo[${pid}].usage['NPU Mem']">${fmt(npuMem, 0)}</td>
    </tr>`;
  }).join('');
}

// ── WebSocket ────────────────────────────────────────────────────────────────
let ws              = null;
let retryMs         = 1000;
let retryTimer      = null;
let countdownTimer  = null;
const MAX_RETRY = 30000;

function clearCountdown() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
}

function connect() {
  clearCountdown();
  if (ws && ws.readyState < 2) ws.close(); // CONNECTING or OPEN → close before replacing
  setConnStatus('connecting', 'Connecting…');
  ws = new WebSocket(`ws://${location.host}/ws`);

  ws.addEventListener('open', () => {
    retryMs = 1000;
    setConnStatus('connected', 'Connected');
    appendLog('WebSocket connected', 'ok');
    fetchPowerLimits();
    fetchCoreRanks();
    fetchConfig();
  });

  ws.addEventListener('message', evt => {
    let data;
    try { data = JSON.parse(evt.data); } catch { return; }
    if (!data) return;

    // Server-pushed system info (fan, temp, power, RAM, uptime).
    if (data.type === 'system') { renderSystemInfo(data); return; }

    // Immediate shutdown/reboot alert pushed by the inotify watcher.
    if (data.type === 'system_alert') {
      if (data.shutdown_pending) {
        const mode = data.shutdown_pending.split(' ')[0];
        if (state.lastShutdownMode !== mode) {
          state.lastShutdownMode = mode;
          appendLog('system: ' + data.shutdown_pending, 'err');
        }
      }
      return;
    }

    // Server-side early process detection (KFD watcher / known-proc watcher).
    if (data.type === 'proc_event' && data.event === 'start') {
      const pidStr = String(data.pid);
      for (const h of state.hist) {
        if (!h.earlyStartedPids.has(pidStr)) {
          h.earlyStartedPids.add(pidStr);
          h.events.push({ timeMs: data.time_ms, type: 'start', name: data.name, pid: data.pid });
        }
      }
      appendLog(`Process start: ${data.name} (PID ${data.pid}) [early]`, 'ok');
      return;
    }

    if (!Array.isArray(data.devices)) return;

    const _t = new Date();
    document.getElementById('period-label').textContent =
      _t.toLocaleTimeString([], { hour12: false }) + '.' + String(_t.getMilliseconds()).padStart(3, '0');

    state.lastDevices = data.devices;
    if (state.n !== data.devices.length) { buildDom(data.devices); }
    data.devices.forEach((dev, i) => updateDevice(i, dev));
  });

  ws.addEventListener('close', () => {
    const delaySec = retryMs / 1000;
    appendLog(`WebSocket disconnected — reconnecting in ${delaySec}s`, 'warn');
    const reconnectAt = Date.now() + retryMs;
    const tick = () => {
      const rem = Math.ceil((reconnectAt - Date.now()) / 1000);
      setConnStatus('disconnected', rem > 0 ? `Reconnecting in ${rem}s…` : 'Reconnecting…');
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
    retryTimer = setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, MAX_RETRY);
  });

  ws.addEventListener('error', () => ws.close());
}

// When the tab becomes visible again, skip the remaining backoff and reconnect
// immediately rather than waiting up to MAX_RETRY (30 s) for the timer to fire.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && (!ws || ws.readyState >= 2)) {
    clearTimeout(retryTimer);
    clearCountdown();
    retryMs = 1000;
    appendLog('Tab visible — reconnecting immediately', 'warn');
    connect();
  }
});

// ── Device info header ───────────────────────────────────────────────────────
function updateDeviceInfoHeader(dev) {
  const el = document.getElementById('device-info');
  if (!el) return;
  const info = dev.Info || {};
  const name = info.DeviceName || info['ASIC Name'] || '';
  const asic = info['ASIC Name'] || '';
  const rocm = info['ROCm Version'] || null;

  const nameParts = [];
  if (name) nameParts.push(`<span data-src="devices[0].Info.DeviceName">${name}</span>`);
  if (asic && asic !== name) nameParts.push(`<span data-src="devices[0].Info['ASIC Name']">${asic}</span>`);
  if (rocm) nameParts.push(`<span data-src="devices[0].Info['ROCm Version']">ROCm ${rocm}</span>`);
  const nameStr = nameParts.join('<span class="di-sep"> ◆ </span>');
  const metaHtml = '';

  const specsParts = [];
  const cu = info['Compute Unit'] ?? info['Compute Units'] ?? null;
  if (cu != null) specsParts.push(`<span data-src="devices[0].Info['Compute Unit']">${cu} CUs</span>`);
  const vramTotalMiB = (dev.VRAM ? (dev.VRAM['Total VRAM']?.value ?? dev.VRAM['Total VRAM'] ?? null) : null);
  if (vramTotalMiB != null) {
    const gib = vramTotalMiB / 1024;
    specsParts.push(`<span data-src="devices[0].VRAM['Total VRAM'].value (MiB → GiB)">${gib.toFixed(3)} GiB VRAM</span>`);
  }
  const vramType = info['VRAM Type'] ?? null;
  if (vramType) specsParts.push(`<span data-src="devices[0].Info['VRAM Type']">${vramType}</span>`);
  const bw = info['Memory Bandwidth'] ?? null;
  if (bw != null) specsParts.push(`<span data-src="devices[0].Info['Memory Bandwidth']">${typeof bw === 'number' ? bw.toFixed(3) : bw} GB/s BW</span>`);
  const fp32Raw = v(info, 'Peak FP32') ?? v(info, 'Peak GFLOPS') ?? null;
  const fp32Num = fp32Raw != null ? Number(fp32Raw) : null;
  if (fp32Num != null && !isNaN(fp32Num)) specsParts.push(`<span data-src="devices[0].Info['Peak FP32' || 'Peak GFLOPS'] / 1000">${(fp32Num / 1000).toFixed(3)} TFLOPS</span>`);
  const npuName = info['IPU'] ?? info['NPU'] ?? null;
  if (npuName) specsParts.push(`<span data-src="devices[0].Info['IPU' || 'NPU']">NPU: ${npuName}</span>`);
  const specsHtml = specsParts.length ? `<div class="di-specs">${specsParts.join('<span class="di-sep"> ◆ </span>')}</div>` : '';

  const pl = state.powerLimits;
  let limitsHtml = '';
  const limitParts = [];
  if (pl.stapm_w    != null) limitParts.push(`<span class="di-limit-stapm"  data-src="/api/limits → stapm_w (ryzenadj STAPM LIMIT)">STAPM ${pl.stapm_w.toFixed(3)}W</span>`);
  if (pl.fast_w     != null) limitParts.push(`<span class="di-limit-fast"   data-src="/api/limits → fast_w (ryzenadj FAST PPT LIMIT)">Fast ${pl.fast_w.toFixed(3)}W</span>`);
  if (pl.slow_w     != null) limitParts.push(`<span class="di-limit-slow"   data-src="/api/limits → slow_w (ryzenadj SLOW PPT LIMIT)">Slow ${pl.slow_w.toFixed(3)}W</span>`);
  if (pl.apu_slow_w != null) limitParts.push(`<span class="di-limit-apu-slow" data-src="/api/limits → apu_slow_w (ryzenadj APU SLOW LIMIT)">APU Slow ${pl.apu_slow_w.toFixed(3)}W</span>`);
  if (pl.thm_core_c != null) limitParts.push(`<span class="di-limit-thm-core" data-src="/api/limits → thm_core_c (ryzenadj THM CORE LIMIT)">THM Core ${pl.thm_core_c.toFixed(3)}°C</span>`);
  if (pl.thm_gfx_c  != null) limitParts.push(`<span class="di-limit-thm-gfx"  data-src="/api/limits → thm_gfx_c (ryzenadj THM GFX LIMIT)">THM GFX ${pl.thm_gfx_c.toFixed(3)}°C</span>`);
  if (pl.thm_soc_c  != null) limitParts.push(`<span class="di-limit-thm-soc"  data-src="/api/limits → thm_soc_c (ryzenadj THM SOC LIMIT)">THM SoC ${pl.thm_soc_c.toFixed(3)}°C</span>`);
  if (limitParts.length) {
    limitsHtml = `<div class="di-limits"><span class="di-limit-label">ryzenadj limits:</span> ${limitParts.join(' ◆ ')}</div>`;
  }

  el.innerHTML = (nameStr ? `<div class="di-name">${nameStr}</div>` : '') + metaHtml + specsHtml + limitsHtml;
}

// ── CPU core performance ranks ────────────────────────────────────────────────

// 16-color categorical palette hand-picked for a dark background. Arranged so
// that consecutive indices land in different hue families (e.g. red→blue→
// yellow→purple) and neighboring cores never share a look-alike tone.
const CORE_COLORS = [
  '#ff6b6b', // red
  '#4dc9f6', // sky blue
  '#ffd93d', // yellow
  '#a78bfa', // violet
  '#3fb950', // green
  '#ff4d94', // pink
  '#40e0d0', // turquoise
  '#ffa500', // orange
  '#388bfd', // blue
  '#a0e85f', // lime
  '#e879f9', // magenta
  '#1dd1a1', // teal
  '#c08968', // tan
  '#5d6dff', // indigo
  '#a0522d', // sienna brown
  '#fb7185', // rose
];
function coreColor(j) { return CORE_COLORS[j % CORE_COLORS.length]; }

function coreLabel(j) {
  const rank = state.coreRanks[j];
  return rank != null ? `C${j} (R#${rank})` : `C${j}`;
}

function fetchCoreRanks() {
  fetch('/api/cpu-ranks')
    .then(r => r.ok ? r.json() : null)
    .then(d => {
      if (d?.ranks?.length) {
        const changed = d.ranks.length !== state.coreRanks.length ||
          d.ranks.some((r, j) => r !== state.coreRanks[j]);
        state.coreRanks = d.ranks;
        if (changed && state.lastDevices) buildDom(state.lastDevices);
      }
    })
    .catch(() => {});
}

// ── System info (fan / voltage / power / temp / RAM via /api/system) ────────
// Polled at low frequency (1 Hz) since these metrics change slowly and the
// endpoint is cheap to serve but not instant.
function fetchSystem() {
  fetch('/api/system')
    .then(r => r.ok ? r.json() : null)
    .then(sys => { if (sys) renderSystemInfo(sys); })
    .catch(() => {});
}

function renderSystemInfo(sys) {
  state.systemInfo = sys;

  // Surface any new server-side diagnostics (MSR/ptrace/debugfs permissions,
  // missing kernel modules, etc.) into the dashboard log pane.  The server
  // ships the full sticky list on every tick; dedupe client-side so a given
  // message only appears once no matter how many frames carry it.
  if (Array.isArray(sys.errors) && sys.errors.length) {
    state.seenErrors ??= new Set();
    for (const msg of sys.errors) {
      if (state.seenErrors.has(msg)) continue;
      state.seenErrors.add(msg);
      appendLog('server: ' + msg, 'err');
    }
  }

  // Shutdown/reboot detection: log once when mode first appears, re-log if mode changes.
  if (sys.shutdown_pending) {
    const mode = sys.shutdown_pending.split(' ')[0];
    if (state.lastShutdownMode !== mode) {
      state.lastShutdownMode = mode;
      appendLog('system: ' + sys.shutdown_pending, 'err');
    }
  } else {
    state.lastShutdownMode = undefined;
  }

  // Push the current value into every device's copy of a permanent card.
  // (On multi-GPU systems each tab gets its own card row, but system values
  // are global — same value goes into all copies.)
  const update = (prefix, text) => {
    for (let i = 0; i < state.n; i++) {
      const el = document.getElementById(`${prefix}-${i}`);
      if (el) el.textContent = text;
    }
  };

  const fan = (sys.fans || []).find(f => f.value != null);
  // Stash for the Fan Speed chart.
  // Some hwmon drivers omit the fan sensor entry entirely when RPM is 0 rather
  // than reporting value 0 — once we've seen the sensor, treat its absence as
  // "fan stopped" (0 RPM) instead of "no sensor / data unavailable".
  if (fan) {
    state.seenFanSensor = true;
    state.lastFan = { value: fan.value, receivedAt: Date.now() };
  } else if (state.seenFanSensor) {
    state.lastFan = { value: 0, receivedAt: Date.now() };
  } else {
    state.lastFan = { value: null, receivedAt: 0 };
  }
  update('c-fan', fan ? String(Math.round(fan.value)) : state.seenFanSensor ? '0' : '—');

  const cpuPct = sys.cpu_usage_pct ?? null;
  state.lastCPU = cpuPct != null
    ? { value: cpuPct, receivedAt: Date.now() }
    : { value: null, receivedAt: 0 };

  const ppt = (sys.powers || []).find(p => /^ppt$/i.test(p.label) && p.value > 0);
  // Stash for the Package Power chart; µW → W.
  state.lastPPT = ppt
    ? { value: ppt.value / 1_000_000, receivedAt: Date.now() }
    : { value: null, receivedAt: 0 };
  update('c-ppt', ppt ? state.lastPPT.value.toFixed(3) : '—');

  if (sys.uptime_sec != null && sys.uptime_sec > 0)
    update('c-uptime', formatUptime(sys.uptime_sec));

  // The dynamic `#system-cards` row is intentionally left empty. Its
  // infrastructure (div + CSS + this function's `state.systemInfo` capture)
  // is preserved so future collapsible system sensors can populate it.
}

// Formats seconds as D/HH:MM:SS.mmm — e.g. 90061.5 → "1/01:01:01.500".
function formatUptime(totalSec) {
  const days = Math.floor(totalSec / 86400);
  const rem  = totalSec - days * 86400;
  const h    = Math.floor(rem / 3600);
  const m    = Math.floor((rem % 3600) / 60);
  const sRaw = rem % 60;
  const sInt = Math.floor(sRaw);
  const ms   = Math.floor((sRaw - sInt) * 1000);
  const pad  = (n, w) => String(n).padStart(w, '0');
  return `${days}/${pad(h, 2)}:${pad(m, 2)}:${pad(sInt, 2)}.${pad(ms, 3)}`;
}

// ── Power limits ─────────────────────────────────────────────────────────────
function fetchPowerLimits() {
  fetch('/api/limits')
    .then(r => r.json())
    .then(d => {
      const pl  = state.powerLimits;
      const nxt = {
        stapm_w:    d.stapm_w    ?? null,
        fast_w:     d.fast_w     ?? null,
        slow_w:     d.slow_w     ?? null,
        apu_slow_w: d.apu_slow_w ?? null,
        thm_core_c: d.thm_core_c ?? null,
        thm_gfx_c:  d.thm_gfx_c  ?? null,
        thm_soc_c:  d.thm_soc_c  ?? null,
      };
      const changed = Object.keys(nxt).some(k => nxt[k] !== pl[k]);
      Object.assign(pl, nxt);
      // Refresh header once limits are loaded (device may already be shown).
      if (state.hist.length > 0 && state.lastDev0) updateDeviceInfoHeader(state.lastDev0);
      if (!changed) return;
      const parts = [];
      if (pl.stapm_w    != null) parts.push(`STAPM ${pl.stapm_w.toFixed(3)}W`);
      if (pl.fast_w     != null) parts.push(`Fast ${pl.fast_w.toFixed(3)}W`);
      if (pl.slow_w     != null) parts.push(`Slow ${pl.slow_w.toFixed(3)}W`);
      if (pl.apu_slow_w != null) parts.push(`APU Slow ${pl.apu_slow_w.toFixed(3)}W`);
      if (pl.thm_core_c != null) parts.push(`THM Core ${pl.thm_core_c.toFixed(3)}°C`);
      if (pl.thm_gfx_c  != null) parts.push(`THM GFX ${pl.thm_gfx_c.toFixed(3)}°C`);
      if (pl.thm_soc_c  != null) parts.push(`THM SoC ${pl.thm_soc_c.toFixed(3)}°C`);
      if (parts.length) appendLog(`Power limits: ${parts.join('  ')}`, 'warn');
    })
    .catch(() => {});
}

// ── [data-src] hover tooltips (process table cells) ──────────────────────────
function initDataSrcTooltip() {
  document.addEventListener('mouseover', e => {
    const target = e.target.closest('[data-src]');
    if (!target) return;
    const el = getTooltipEl();
    el.innerHTML = `<div style="color:#6e7681;font-size:10px">${target.dataset.src}</div>`;
    const tw = el.offsetWidth;
    const th = el.offsetHeight;
    let left = e.clientX + 12;
    let top  = e.clientY - Math.round(th / 2);
    if (left + tw > window.innerWidth  - 4) left = e.clientX - tw - 12;
    if (top < 4)                             top  = 4;
    if (top + th > window.innerHeight  - 4) top  = window.innerHeight - th - 4;
    el.style.left    = left + 'px';
    el.style.top     = top  + 'px';
    el.style.opacity = '1';
  });
  document.addEventListener('mouseout', e => {
    if (!e.target.closest('[data-src]')) return;
    if (e.relatedTarget?.closest('[data-src]')) return;
    getTooltipEl().style.opacity = '0';
  });
}

// ── Persist user settings across reloads (localStorage) ──────────────────────
function loadSavedSettings() {
  const iv  = parseInt(localStorage.getItem('atopweb.intervalMs'),      10);
  const pw  = parseInt(localStorage.getItem('atopweb.timeWidthMs'),      10);
  const cpw = parseInt(localStorage.getItem('atopweb.coreTimeWidthMs'), 10);
  if (!isNaN(iv)  && iv  >= 50 && iv  <= 60000) {
    state.intervalMs = iv;
    document.getElementById('interval-input').value  = iv;
    fetch(`/api/interval?ms=${iv}`, { method: 'POST' }).catch(() => {});
  }
  if (!isNaN(pw)  && pw  >= 5000 && pw  <= 3600000) {
    state.timeWidthMs = pw;
    document.getElementById('plotwidth-input').value = pw / 1000;
  }
  if (!isNaN(cpw) && cpw >= 5000 && cpw <= 3600000) {
    state.coreTimeWidthMs = cpw;
    document.getElementById('corewidth-input').value = cpw / 1000;
  }
}

// ── Config fetch (version check + subtitle refresh) ───────────────────────────
function fetchConfig() {
  fetch('/api/config')
    .then(r => r.json())
    .then(cfg => {
      if (!localStorage.getItem('atopweb.intervalMs')) {
        state.intervalMs = cfg.interval_ms;
        document.getElementById('interval-input').value = cfg.interval_ms;
      }
      const newVer = cfg.atopweb_version || '';
      document.getElementById('page-title').textContent = 'atopweb ' + (newVer ? `v${newVer}` : '');
      const subSpans = [];
      if (cfg.amdgpu_top_version) subSpans.push(`<span data-src="/api/config → amdgpu_top_version">${cfg.amdgpu_top_version}</span>`);
      if (cfg.kernel_version)     subSpans.push(`<span data-src="/api/config → kernel_version (/proc/sys/kernel/osrelease)">Linux v${cfg.kernel_version}</span>`);
      if (cfg.nixos_version)      subSpans.push(`<span data-src="/api/config → nixos_version (/etc/os-release VERSION_ID)">NixOS v${cfg.nixos_version}</span>`);
      if (cfg.nixos_generation)   subSpans.push(`<span data-src="/api/config → nixos_generation (/nix/var/nix/profiles/system symlink)">Nix Profile Gen ${cfg.nixos_generation}</span>`);
      if (cfg.cpu_gov)            subSpans.push(`<span data-src="/api/config → cpu_gov (/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor)">CPU Gov: ${cfg.cpu_gov}</span>`);
      const subtitleEl = document.getElementById('page-subtitle');
      subtitleEl.innerHTML = subSpans.join('<span class="subtitle-sep"> ◆ </span>');
      if (cfg.total_ram_mib) state.totalRAMMiB = cfg.total_ram_mib;
      if (state.serverVersion === null && newVer) {
        state.serverVersion = newVer;                   // record version this page was loaded with
      } else if (state.serverVersion && newVer && newVer !== state.serverVersion) {
        showVersionBanner(state.serverVersion, newVer); // server updated while page is open
      }

      const snap = {
        kernel_version:     cfg.kernel_version     || null,
        nixos_version:      cfg.nixos_version      || null,
        nixos_generation:   cfg.nixos_generation   ?? null,
        cpu_gov:            cfg.cpu_gov            || null,
        amdgpu_top_version: cfg.amdgpu_top_version || null,
      };
      const lc = state.lastConfig;
      if (lc === null) {
        // First load — log a one-time snapshot of all present values.
        const parts = [];
        if (snap.amdgpu_top_version) parts.push(snap.amdgpu_top_version);
        if (snap.kernel_version)     parts.push(`Linux v${snap.kernel_version}`);
        if (snap.nixos_version)      parts.push(`NixOS v${snap.nixos_version}`);
        if (snap.nixos_generation != null) parts.push(`Nix Gen ${snap.nixos_generation}`);
        if (snap.cpu_gov)            parts.push(`CPU Gov: ${snap.cpu_gov}`);
        if (parts.length) appendLog(`System: ${parts.join('  ')}`);
      } else {
        const chk = (label, prev, next) => {
          if (next !== prev) appendLog(`${label} changed: ${prev ?? '—'} → ${next ?? '—'}`, 'warn');
        };
        chk('Linux kernel',    lc.kernel_version,     snap.kernel_version);
        chk('NixOS',           lc.nixos_version,      snap.nixos_version);
        chk('Nix generation',  lc.nixos_generation,   snap.nixos_generation);
        chk('CPU governor',    lc.cpu_gov,             snap.cpu_gov);
        chk('amdgpu_top',      lc.amdgpu_top_version, snap.amdgpu_top_version);
      }
      state.lastConfig = snap;
    })
    .catch(() => {});
}

function showVersionBanner(loadedVer, serverVer) {
  const banner = document.getElementById('version-banner');
  const msg    = document.getElementById('version-banner-msg');
  if (!banner || !msg) return;
  msg.textContent =
    `atopweb updated on server: v${loadedVer} → v${serverVer}. Refresh the page to run the new version.`;
  banner.hidden = false;
  appendLog(`atopweb server updated: v${loadedVer} → v${serverVer} — refresh to update`, 'warn');
}

// ── Interval control ─────────────────────────────────────────────────────────
function initIntervalCtrl() {
  fetchConfig();

  const apply = () => {
    const ms = parseInt(document.getElementById('interval-input').value, 10);
    if (isNaN(ms) || ms < 50 || ms > 60000) return;
    state.intervalMs = ms;
    localStorage.setItem('atopweb.intervalMs', ms);
    if (state.lastDevices) buildDom(state.lastDevices);
    fetch(`/api/interval?ms=${ms}`, { method: 'POST' });
    appendLog(`Interval set to ${ms}ms`);
  };

  document.getElementById('interval-btn').addEventListener('click', apply);
  document.getElementById('interval-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') apply();
  });
}

// ── Plot / core width controls ────────────────────────────────────────────────
function initPlotWidthCtrl() {
  const applyWidth = (stateKey, inputId) => {
    const s = parseInt(document.getElementById(inputId).value, 10);
    if (isNaN(s) || s < 5 || s > 3600) return;
    state[stateKey] = s * 1000;
    localStorage.setItem(`atopweb.${stateKey}`, state[stateKey]);
    if (state.lastDevices) buildDom(state.lastDevices);
    const label = stateKey === 'coreTimeWidthMs' ? 'Core clock width' : 'Plot width';
    appendLog(`${label} set to ${s}s`);
  };
  const bind = (stateKey, inputId, btnId) => {
    document.getElementById(btnId).addEventListener('click', () => applyWidth(stateKey, inputId));
    document.getElementById(inputId).addEventListener('keydown', e => { if (e.key === 'Enter') applyWidth(stateKey, inputId); });
  };
  bind('timeWidthMs',     'plotwidth-input', 'plotwidth-btn');
  bind('coreTimeWidthMs', 'corewidth-input', 'corewidth-btn');
}

function initPauseBtn() {
  const btn = document.getElementById('pause-btn');
  btn.addEventListener('click', () => {
    state.paused = !state.paused;
    btn.textContent = state.paused ? '▶' : '⏸';
    btn.classList.toggle('paused', state.paused);
    appendLog(state.paused ? 'Paused' : 'Resumed');
    if (!state.paused) scheduleRender();
  });
}

// Build a CSV snapshot of every value rendered in the memory bar (for device
// index `i`) plus the summary totals (Installed/Non-GTT/Margin).  All values
// are raw bytes — no units, no scaling — so they can be summed in Excel to
// verify the accounting.
function buildMemorySnapshotCSV(i = 0) {
  const sysInfo = state.systemInfo;
  if (!sysInfo) return null;
  const dev = state.lastDevices?.[i];
  if (!dev) return null;

  const mk     = sysInfo.meminfo_kb      ?? {};
  const memRes = sysInfo.mem_reservation ?? {};
  const drmMem = sysInfo.drm_mem         ?? {};

  const kib = 1024, mib = 1024 * 1024;
  const fromKB  = k => (mk[k] ?? 0) * kib;
  const fromMiB = m => m * mib;

  const vramTotalMiB = dev.VRAM?.['Total VRAM']?.value        ?? 0;
  const vramUsedMiB  = dev.VRAM?.['Total VRAM Usage']?.value  ?? 0;
  const gttTotalMiB  = dev.VRAM?.['Total GTT']?.value         ?? 0;
  const gttUsedMiB   = dev.VRAM?.['Total GTT Usage']?.value   ?? 0;
  const visUsedMiB   = drmMem.vis_vram_used_mib ?? vramUsedMiB;
  const invUsedMiB   = Math.max(0, vramUsedMiB - visUsedMiB);

  const totalKB    = mk.MemTotal ?? (sysInfo.total_ram_mib * 1024);
  const freeKB     = mk.MemFree ?? 0;
  const cachedKB   = Math.max(0, (mk.Cached ?? 0) - (mk.Shmem ?? 0));
  const ptablesKB  = (mk.PageTables ?? 0) + (mk.SecPageTables ?? 0);
  const drmCpuKB   = drmMem.total_cpu_kib ?? 0;
  const netbufKB   = sysInfo.sock_mem_kb ?? 0;

  const namedKB = (gttUsedMiB * 1024) + drmCpuKB + (mk.AnonPages ?? 0)
                + (mk.Shmem ?? 0) + cachedKB + (mk.Buffers ?? 0)
                + (mk.SReclaimable ?? 0) + (mk.SUnreclaim ?? 0)
                + (mk.VmallocUsed ?? 0) + (mk.KernelStack ?? 0)
                + ptablesKB + netbufKB;
  const drvpgKB = Math.max(0, totalKB - freeKB - namedKB);

  const sysRamMiB    = memRes.system_ram_mib ?? 0;
  const kernelResMiB = Math.max(0, sysRamMiB - totalKB / 1024);
  const fwTotalMiB   = sysInfo.firmware_reserved_mib ?? 0;
  const fwNonVramMiB = Math.max(0, fwTotalMiB - vramTotalMiB);
  const installedMiB = memRes.installed_mib
                    ?? (vramTotalMiB + fwTotalMiB + kernelResMiB + totalKB / 1024);

  // Summary totals shown in the legend right-side group.
  const usedKB         = totalKB - freeKB;
  const nonGttTotalKB  = totalKB - gttTotalMiB * 1024;
  const marginKB       = nonGttTotalKB - (usedKB - gttUsedMiB * 1024);

  // Sections correspond to the physical zones of the bar.  Each section's
  // leading rows are the exact byte values used to size the segments in that
  // zone; the final freeform section carries supporting/context values that
  // don't themselves drive a segment width.
  const sections = [
    // ── VRAM zone (left) ──
    [
      ['vram_free',           fromMiB(vramTotalMiB - vramUsedMiB)],
      ['vram_invisible_used', fromMiB(invUsedMiB)],
      ['vram_visible_used',   fromMiB(visUsedMiB)],
    ],
    // ── System RAM zone (middle sys-part, left-to-right) ──
    [
      ['gtt_used',         fromMiB(gttUsedMiB)],
      ['drm_cpu',          drmCpuKB * kib],
      ['apps_anonpages',   fromKB('AnonPages')],
      ['shared_shmem',     fromKB('Shmem')],
      ['file_cache',       cachedKB * kib],
      ['buffers',          fromKB('Buffers')],
      ['slab_reclaimable', fromKB('SReclaimable')],
      ['slab_unreclaim',   fromKB('SUnreclaim')],
      ['vmalloc_used',     fromKB('VmallocUsed')],
      ['kernel_stack',     fromKB('KernelStack')],
      ['page_tables',      ptablesKB * kib],
      ['net_buffers',      netbufKB * kib],
      ['driver_pages',     drvpgKB * kib],
      ['mem_free',         freeKB * kib],
    ],
    // ── Reserved zone (right, unavailable at runtime) ──
    [
      ['kernel_reserved',   fromMiB(kernelResMiB)],
      ['firmware_non_vram', fromMiB(fwNonVramMiB)],
    ],
    // ── Legend totals / margin readouts ──
    [
      ['installed',     fromMiB(installedMiB)],
      ['non_gtt_total', nonGttTotalKB * kib],
      ['system_margin', marginKB * kib],
    ],
    // ── Supporting detail (not rendered as bar segments) ──
    [
      ['mem_total',       totalKB * kib],
      ['system_ram_e820', fromMiB(sysRamMiB)],
      ['vram_total',      fromMiB(vramTotalMiB)],
      ['vram_used',       fromMiB(vramUsedMiB)],
      ['gtt_total',       fromMiB(gttTotalMiB)],
      ['firmware_total',  fromMiB(fwTotalMiB)],
      ['dma_buf_total',   sysInfo.dma_buf_bytes ?? 0],
      ['top_mem_msr',     memRes.top_mem_bytes   ?? 0],
      ['top_mem2_msr',    memRes.top_mem2_bytes  ?? 0],
      ['tseg_base_msr',   memRes.tseg_base_bytes ?? 0],
      ['tseg_size_msr',   memRes.tseg_size_bytes ?? 0],
    ],
  ];
  const lines = ['bucket,bytes'];
  sections.forEach((rows, idx) => {
    if (idx > 0) lines.push('');
    for (const r of rows) lines.push(r.join(','));
  });
  return lines.join('\n');
}

function initMemSnapBtn() {
  const btn = document.getElementById('memsnap-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const csv = buildMemorySnapshotCSV(0);
    if (!csv) {
      appendLog('Memory snapshot: no data yet', 'warn');
      return;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(csv);
      } else {
        // Fallback for HTTP on non-localhost (no secure context).
        const ta = document.createElement('textarea');
        ta.value = csv;
        ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      appendLog('Memory snapshot copied to clipboard');
    } catch (err) {
      appendLog('Memory snapshot: clipboard write failed — ' + (err?.message || err), 'warn');
    }
  });
}

// ── Status bar ────────────────────────────────────────────────────────────────
function appendLog(msg, cls) {
  const log = document.getElementById('status-log');
  if (!log) return;
  const atBottom = log.scrollHeight - log.scrollTop <= log.clientHeight + 4;
  const now = new Date();
  const ts  = now.toLocaleTimeString([], { hour12: false }) + '.' +
              String(now.getMilliseconds()).padStart(3, '0');
  const span = document.createElement('span');
  span.className = 'log-line' + (cls ? ' ' + cls : '');
  span.textContent = `[${ts}]  ${msg}`;
  log.appendChild(span);
  if (atBottom) log.scrollTop = log.scrollHeight;
  const el = document.getElementById('status-bar-text');
  if (el) el.textContent = msg;
}

function initStatusBar() {
  document.getElementById('status-bar-main').addEventListener('click', () => {
    const bar = document.getElementById('status-bar');
    bar.classList.toggle('expanded');
    if (bar.classList.contains('expanded'))
      document.getElementById('status-log').scrollTop =
        document.getElementById('status-log').scrollHeight;
  });

  const handle = document.getElementById('status-resize-handle');
  let startY = 0, startH = 180;
  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    startY = e.clientY;
    startH = parseInt(getComputedStyle(document.documentElement)
      .getPropertyValue('--log-height'), 10) || 180;
    handle.classList.add('dragging');
    const onMove = ev => {
      const h = Math.max(60, Math.min(500, startH + (startY - ev.clientY)));
      document.documentElement.style.setProperty('--log-height', h + 'px');
    };
    const onUp = () => {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  const bar = document.getElementById('status-bar');
  new ResizeObserver(() => {
    document.body.style.paddingBottom = bar.offsetHeight + 'px';
    updateOverlayPosition();
  }).observe(bar);
}

// ── Sticky card offset ────────────────────────────────────────────────────────
function updateStickyOffset() {
  const headerH = document.querySelector('header')?.offsetHeight || 0;
  const tabsH   = document.getElementById('tabs')?.offsetHeight  || 0;
  document.documentElement.style.setProperty('--sticky-top', (headerH + tabsH) + 'px');
}

// ── Plot maximize overlay ─────────────────────────────────────────────────────
function updateOverlayPosition() {
  const overlay = document.getElementById('plot-overlay');
  if (!overlay) return;
  // Use the bottom of the sticky cards (viewport-relative) so the overlay
  // never covers the digitals.  Fall back to header bottom if cards aren't
  // built yet.
  const cardsEl = document.querySelector('.gpu-panel.active .cards');
  const anchorEl = cardsEl || document.querySelector('header');
  const topPx = anchorEl ? anchorEl.getBoundingClientRect().bottom : 0;
  const statusH = document.getElementById('status-bar')?.offsetHeight || 0;
  overlay.style.top    = Math.round(topPx) + 'px';
  overlay.style.bottom = statusH + 'px';
}

function openOverlay(chartKey, title) {
  const src = state.charts[chartKey];
  if (!src) return;

  if (state.overlayChart) { state.overlayChart.destroy(); state.overlayChart = null; }

  document.getElementById('plot-overlay-title').textContent = title;
  const overlay = document.getElementById('plot-overlay');
  overlay.hidden = false;
  updateOverlayPosition();

  const canvas = document.getElementById('plot-overlay-canvas');
  const srcOpts = JSON.parse(JSON.stringify(src.options));
  // Restore functions stripped by JSON round-trip
  srcOpts.plugins.tooltip.external = externalTooltip;
  srcOpts.plugins.tooltip.itemSort = tooltipItemSort;
  srcOpts.scales.y.ticks.callback  = src.options.scales.y.ticks.callback;

  // coreData charts (core-pwr, npu-act) use a compact aggregate tooltip to
  // save space in the small inline chart.  In the full-screen overlay there's
  // room to show all series individually, so switch to the standard callbacks.
  const isCoreData = src.config.plugins?.some(p => p.id === 'verticalLine');
  if (isCoreData) {
    const devIdx = parseInt(chartKey, 10);
    srcOpts.plugins.tooltip.callbacks = makeChartCallbacks(state.hist[devIdx]);
    srcOpts.plugins.tooltip.mode = 'index';
  } else {
    srcOpts.plugins.tooltip.callbacks = src.options.plugins.tooltip.callbacks;
  }
  // Give the larger overlay canvas more breathing room for annotation labels
  srcOpts.layout.padding = { top: 20, right: 12, bottom: 24, left: 12 };

  state.overlayChart = new Chart(canvas, {
    type: src.config.type,
    data: src.config.data,
    options: srcOpts,
    plugins: src.config.plugins || [],
  });

  const isCoreFreq = chartKey.includes('-cpu-core-');
  state.overlayWidthMs  = isCoreFreq ? state.coreTimeWidthMs : state.timeWidthMs;
  state.overlayChartKey = chartKey;
  appendLog(`Maximized: ${title}`);
}

function closeOverlay() {
  document.getElementById('plot-overlay').hidden = true;
  if (state.overlayChart) { state.overlayChart.destroy(); state.overlayChart = null; }
  state.overlayChartKey = null;
  scheduleRender();
  appendLog('Closed maximized plot');
}

function initOverlay() {
  document.getElementById('plot-overlay-close').addEventListener('click', closeOverlay);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.getElementById('plot-overlay').hidden) closeOverlay();
  });
  new ResizeObserver(() => { updateStickyOffset(); updateOverlayPosition(); })
    .observe(document.querySelector('header'));
  new ResizeObserver(() => { updateStickyOffset(); updateOverlayPosition(); })
    .observe(document.getElementById('tabs'));
  window.addEventListener('resize', updateOverlayPosition);
  window.addEventListener('scroll', () => {
    if (!document.getElementById('plot-overlay').hidden) updateOverlayPosition();
  }, { passive: true });
}

loadSavedSettings();
initDataSrcTooltip();
initIntervalCtrl();
initPlotWidthCtrl();
initPauseBtn();
initMemSnapBtn();
initStatusBar();
initOverlay();
updateStickyOffset();
fetchPowerLimits();
setInterval(fetchPowerLimits, 300_000);
fetchCoreRanks();
setInterval(fetchCoreRanks, 300_000);
setInterval(fetchConfig, 60_000);
fetchSystem(); // immediate data on load; server pushes updates via WebSocket thereafter
setInterval(saveCache, CACHE_SAVE_MS);
window.addEventListener('beforeunload', saveCache);
connect();
