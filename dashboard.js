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
      labels: { color: '#8b949e', boxWidth: 8, padding: 8, font: { size: 10 } }
    },
    tooltip: { enabled: false },
    annotation: { drawTime: 'afterDraw', annotations: {} }
  },
  layout: { padding: { top: 14, right: 6, bottom: 18, left: 6 } },
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

// Deep-clone CHART_DEFAULTS and restore non-serialisable function references.
// JSON.stringify silently drops functions, so externalTooltip must be re-applied
// after each clone — never rely on CHART_DEFAULTS to carry it directly.
function cloneDefaults() {
  const cfg = JSON.parse(JSON.stringify(CHART_DEFAULTS));
  cfg.plugins.tooltip.external = externalTooltip;
  return cfg;
}

function makeDataset(label, color, data, sourcePath, decimals) {
  return {
    label,
    data,
    sourcePath: sourcePath || null,
    decimals:   decimals  ?? 1,
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
    for (const [key, c] of Object.entries(state.charts)) {
      const isCoreFreq = key.includes('-cpu-core-');
      const widthMs    = isCoreFreq ? state.coreTimeWidthMs : state.timeWidthMs;
      c.options.scales.x.min = now - widthMs;
      c.options.scales.x.max = now;
      // Skip repaint when paused, when overlay is covering the main view,
      // or when this chart has received no finite data within 10% of its window.
      const debounceMs  = widthMs * 0.1;
      const chartActive = (now - (state.chartLastData[key] || 0)) <= debounceMs;
      if (!state.paused && !hasOverlay && chartActive &&
          (state.n <= 1 || parseInt(key, 10) === state.cur))
        c.update('none');
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
  coreRanks:       [],
  lastDev0:        null,
  lastDevices:     null,
  intervalMs:      1000,
  timeWidthMs:     120_000,
  coreTimeWidthMs: 60_000,
  paused:          false,
  overlayChart:    null,
  overlayWidthMs:  0,
  chartLastData:   {},   // chartKey → ms timestamp of last tick with any finite data
};

// History size = time window / update interval, so the x-axis always shows a
// fixed duration regardless of how fast samples arrive.
function getHistorySize()     { return Math.max(2, Math.ceil(state.timeWidthMs     / state.intervalMs)); }
function getCoreHistorySize() { return Math.max(2, Math.ceil(state.coreTimeWidthMs / state.intervalMs)); }

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
    events:        [],         // [{timeMs, type:'start'|'stop', name}]
    prevProcNames: new Map(),  // pid → name, previous tick
  };
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
      const dec = item.dataset.decimals ?? 1;
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
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
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
        lines.push(`Min: ${Math.min(...vals).toFixed(1)} ${unit}`);
        lines.push(`Max: ${Math.max(...vals).toFixed(1)} ${unit}`);
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
      { id: `c-gfx-${i}`,    cls: 'c-gfx',    label: 'GFX',       unit: '%',   bar: true  },
      { id: `c-media-${i}`,  cls: 'c-media',  label: 'Media',     unit: '%',   bar: true  },
      { id: `c-vram-${i}`,   cls: 'c-vram',   label: 'VRAM',      unit: 'GiB', bar: true  },
      { id: `c-gtt-${i}`,    cls: 'c-gtt',    label: 'GTT Used',  unit: 'GiB', bar: true  },
      { id: `c-sclk-${i}`,   cls: 'c-sclk',   label: 'GFX Clock', unit: 'MHz', bar: false },
      { id: `c-mclk-${i}`,   cls: 'c-mclk',   label: 'Mem Clock', unit: 'MHz', bar: false },
      { id: `c-fclk-${i}`,   cls: 'c-fclk',   label: 'FCLK',      unit: 'MHz', bar: false },
      { id: `c-pwr-${i}`,    cls: 'c-pwr',    label: 'Power',     unit: 'W',   bar: false },
      { id: `c-etmp-${i}`,   cls: 'c-etmp',   label: 'Edge Temp', unit: '°C',  bar: false },
      { id: `c-cputmp-${i}`, cls: 'c-cputmp', label: 'CPU Tctl',  unit: '°C',  bar: false },
      { id: `c-vddgfx-${i}`, cls: 'c-vddgfx', label: 'VDDGFX',   unit: 'mV',  bar: false },
      { id: `c-vddnb-${i}`,  cls: 'c-vddnb',  label: 'VDDNB',    unit: 'mV',  bar: false },
    ];

    cardDefs.forEach(def => {
      const card = el('div', `card ${def.cls}`);
      card.innerHTML = `
        <div class="card-label">${def.label}</div>
        <div>
          <span class="card-value" id="${def.id}">—</span>
          <span class="card-unit">${def.unit}</span>
        </div>
        ${def.bar ? `<div class="card-bar-wrap"><div class="card-bar" id="${def.id}-bar"></div></div>` : ''}
      `;
      cards.appendChild(card);
    });
    panel.appendChild(cards);

    // ── Charts ──
    const chartGrid = el('div', 'charts');
    const h = state.hist[i];

    const chartDefs = [
      {
        key: 'temp', title: 'Temperature (°C)', height: 140, yMax: null, wide: true, noYMin: true,
        datasets: () => [
          makeDataset('Edge',     '#f85149', h.tempE,   `devices[${i}].Sensors['Edge Temperature']`),
          makeDataset('CPU Tctl', '#e3b341', h.tempC,   `devices[${i}].Sensors['CPU Tctl']`),
          makeDataset('SoC',      '#bc8cff', h.tempS,   `devices[${i}].gpu_metrics.temperature_soc / 100`),
          makeDataset('GFX',      '#388bfd', h.tempGfx, `devices[${i}].gpu_metrics.temperature_gfx / 100`),
          makeDataset('Hotspot',  '#ff9500', h.tempHot, `devices[${i}].gpu_metrics.temperature_hotspot / 100`),
          makeDataset('Mem',      '#3fb950', h.tempMem, `devices[${i}].gpu_metrics.temperature_mem / 100`),
        ]
      },
      {
        key: 'activity', title: 'GPU Activity (%)', height: 140, yMax: 100,
        datasets: () => [
          makeDataset('GFX',    '#e85d04', h.gfx,   `devices[${i}].gpu_activity['GFX']`),
          makeDataset('Memory', '#388bfd', h.mem,   `devices[${i}].gpu_activity['Memory']`),
          makeDataset('Media',  '#bc8cff', h.media, `devices[${i}].gpu_activity['MediaEngine']`),
        ]
      },
      {
        key: 'vram', title: 'VRAM + GTT Usage (GiB)', height: 140, yMax: null,
        tickFmt: v => (typeof v === 'number' ? v.toFixed(3) : String(v)),
        datasets: () => [
          makeDataset('Total', '#3fb950', h.vram,    `devices[${i}].VRAM: Total VRAM Usage + Total GTT Usage`, 3),
          makeDataset('VRAM',  '#388bfd', h.vramOnly, `devices[${i}].VRAM['Total VRAM Usage']`,               3),
          makeDataset('GTT',   '#bc8cff', h.gttOnly,  `devices[${i}].VRAM['Total GTT Usage']`,                3),
        ]
      },
      {
        key: 'core-pwr', title: 'CPU Core Power (W)', height: 140, yMax: null,
        coreData: () => h.corePwr, coreUnit: 'W',
        datasets: () => Array.from({length: 16}, (_, j) => ({
          label: `CPU ${coreLabel(j)}`,
          data: h.corePwr[j],
          sourcePath: `devices[${i}].gpu_metrics.average_core_power[${j}] / 1000`,
          borderColor: `hsl(${Math.round(j * 137.5) % 360}, 65%, 55%)`,
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.25,
          pointRadius: 0,
          borderWidth: 1,
        }))
      },
      {
        key: 'gfx-clk', title: 'Clocks (MHz)', height: 140, yMax: null,
        datasets: () => [
          makeDataset('SCLK',     '#e85d04', h.sclk,    `devices[${i}].Sensors['GFX_SCLK']`),
          makeDataset('MCLK',     '#388bfd', h.mclk,    `devices[${i}].Sensors['GFX_MCLK']`),
          makeDataset('FCLK',     '#3fb950', h.fclk,    `devices[${i}].Sensors['FCLK']`),
          makeDataset('FCLK avg', '#00b4d8', h.fclkAvg, `devices[${i}].gpu_metrics.average_fclk_frequency`),
          makeDataset('SoC Clk',  '#e3b341', h.socClk,  `devices[${i}].gpu_metrics.average_socclk_frequency`),
          makeDataset('VCN Clk',  '#f85149', h.vclk,    `devices[${i}].gpu_metrics.average_vclk_frequency`),
        ]
      },
      {
        key: 'power', title: 'Package Power (W)', height: 140, yMax: null,
        datasets: () => [
          makeDataset('Power',     '#ffffff', h.pwr,    `devices[${i}].Sensors['Average Power']`),
          makeDataset('CPU Cores', '#388bfd', h.cpuPwr, `devices[${i}].gpu_metrics.average_all_core_power / 1000`),
          makeDataset('NPU',       '#bc8cff', h.npuPwr, `devices[${i}].gpu_metrics.average_ipu_power / 1000`),
        ]
      },
      {
        key: 'voltage', title: 'Voltage (mV)', height: 140, yMax: null,
        datasets: () => [
          makeDataset('VDDGFX', '#e3b341', h.vddgfx, `devices[${i}].Sensors['VDDGFX']`),
          makeDataset('VDDNB',  '#8b949e', h.vddnb,  `devices[${i}].Sensors['VDDNB']`),
        ]
      },
      {
        key: 'dram-bw', title: 'DRAM Bandwidth (MB/s)', height: 140, yMax: null,
        datasets: () => [
          makeDataset('Reads',  '#3fb950', h.dramReads,  `devices[${i}].gpu_metrics.average_dram_reads`),
          makeDataset('Writes', '#f85149', h.dramWrites, `devices[${i}].gpu_metrics.average_dram_writes`),
        ]
      },
      {
        key: 'npu-act', title: 'NPU Tile Activity (%)', height: 140, yMax: 100,
        coreData: () => h.npuBusy, coreUnit: '%',
        datasets: () => Array.from({length: 8}, (_, j) => ({
          label: `NPU Tile ${j}`,
          data: h.npuBusy[j],
          sourcePath: `devices[${i}].npu_metrics.npu_busy[${j}]`,
          borderColor: `hsl(${Math.round(j * 137.5) % 360}, 65%, 55%)`,
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.25,
          pointRadius: 0,
          borderWidth: 1,
        }))
      },
      {
        key: 'npu-clk', title: 'NPU Clocks (MHz)', height: 140, yMax: null,
        datasets: () => [
          makeDataset('NPU Clk',    '#bc8cff', h.npuClk,   `devices[${i}].npu_metrics.npuclk_freq`),
          makeDataset('MP-NPU Clk', '#8b949e', h.npuMpClk, `devices[${i}].npu_metrics.mpnpuclk_freq`),
        ]
      },
      {
        key: 'npu-bw', title: 'NPU Bandwidth (MB/s)', height: 140, yMax: null,
        datasets: () => [
          makeDataset('Reads',  '#3fb950', h.npuReads,  `devices[${i}].npu_metrics.npu_reads`),
          makeDataset('Writes', '#f85149', h.npuWrites, `devices[${i}].npu_metrics.npu_writes`),
        ]
      },
    ];

    chartDefs.forEach(def => {
      const box    = el('div', 'chart-box' + (def.wide ? ' chart-wide' : ''));
      const title  = el('div', 'chart-title', def.title);
      title.addEventListener('click', () => openOverlay(`${i}-${def.key}`, def.title));
      const wrap   = el('div');
      wrap.style.height = (def.height || 160) + 'px';
      const canvas = el('canvas');
      wrap.appendChild(canvas);
      box.appendChild(title);
      box.appendChild(wrap);
      chartGrid.appendChild(box);

      const cfg = cloneDefaults();
      if (!def.noYMin) cfg.scales.y.min = 0;
      cfg.scales.y.grace = '20%';
      if (def.yMax != null) cfg.scales.y.max = def.yMax;
      if (def.hideLegend) cfg.plugins.legend.display = false;
      cfg.plugins.tooltip.callbacks = def.coreData
        ? makeCoreChartCallbacks(h, def.coreData, def.coreUnit)
        : makeChartCallbacks(h);
      cfg.scales.y.ticks.callback = def.tickFmt ?? fmtTick;

      state.charts[`${i}-${def.key}`] = new Chart(canvas, {
        type: 'line',
        data: { labels: h.times, datasets: def.datasets() },
        options: cfg,
        plugins: def.coreData ? [verticalLinePlugin] : [],
      });
    });

    panel.appendChild(chartGrid);

    // ── Per-CPU-core frequency plots (2 rows × 8) ──
    const coreFreqGrid = el('div', 'charts-cores');
    for (let j = 0; j < 16; j++) {
      const box    = el('div', 'chart-box');
      const title  = el('div', 'chart-title', `${coreLabel(j)} Clocks`);
      title.addEventListener('click', () => openOverlay(`${i}-cpu-core-${j}`, `${coreLabel(j)} Clocks`));
      const wrap   = el('div');
      wrap.style.height = '125px';
      const canvas = el('canvas');
      wrap.appendChild(canvas);
      box.appendChild(title);
      box.appendChild(wrap);
      coreFreqGrid.appendChild(box);

      const coreCfg = cloneDefaults();
      coreCfg.scales.y.min = 0;
      coreCfg.scales.y.max = 6000;
      coreCfg.scales.x.grid = { display: false };
      coreCfg.scales.y.grid = { display: true, color: 'rgba(48,54,61,0.8)' };
      coreCfg.plugins.legend.display = false;
      coreCfg.plugins.tooltip.callbacks = makeChartCallbacks({ times: h.coreTimes });
      coreCfg.scales.y.ticks.callback = fmtTick;
      coreCfg.scales.y.ticks.font = { size: 9 };
      coreCfg.scales.y.ticks.maxTicksLimit = 3;

      const hue = Math.round(j * 137.5) % 360;
      state.charts[`${i}-cpu-core-${j}`] = new Chart(canvas, {
        type: 'line',
        data: {
          labels: h.coreTimes,
          datasets: [
            {
              label: 'Scaling',
              data: h.cpuScalingClk[j],
              sourcePath: `devices[${i}].Sensors['CPU Core freq'][${j}].cur_freq`,
              borderColor: '#8b949e',
              backgroundColor: 'transparent',
              fill: false,
              tension: 0.25,
              pointRadius: 0,
              borderWidth: 1.5,
              borderDash: [3, 3],
            },
            {
              label: 'System Mgmt Unit',
              data: h.coreClk[j],
              sourcePath: `devices[${i}].gpu_metrics.current_coreclk[${j}]`,
              borderColor: `hsl(${hue}, 65%, 55%)`,
              backgroundColor: 'transparent',
              fill: false,
              tension: 0.25,
              pointRadius: 0,
              borderWidth: 1.5,
            },
          ],
        },
        options: coreCfg,
      });
    }
    panel.appendChild(coreFreqGrid);

    // ── GRBM / GRBM2 performance counters ──
    const grbmSec = el('div', 'grbm-section');
    grbmSec.appendChild(el('div', 'section-title', 'Performance Counters'));
    const grbmGrid = el('div', 'grbm-grid');

    const buildPCCol = (colTitle, keys, prefix, histArr, color, barCls, srcObj) => {
      const col = el('div', 'grbm-col');
      col.appendChild(el('div', 'grbm-col-title', colTitle));
      keys.forEach((key, ki) => {
        const label = key.length > 30 ? key.slice(0, 28) + '…' : key;
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
          item.classList.toggle('expanded');
          if (item.classList.contains('expanded')) {
            // Lazy-create the chart on first expand.
            if (!state.charts[chartKey]) {
              const canvas = el('canvas');
              chartWrap.appendChild(canvas);
              const pcCfg = cloneDefaults();
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

    // ── Process table ──
    const procSec = el('div', 'proc-section');
    procSec.appendChild(el('div', 'section-title', 'GPU / NPU Processes'));
    const tbl = el('table', 'proc-table');
    tbl.innerHTML = `
      <thead>
        <tr>
          <th>PID</th><th>Name</th>
          <th>VRAM (MiB)</th><th>GTT (MiB)</th>
          <th>GFX%</th><th>Compute%</th><th>DMA%</th><th>Media%</th>
          <th>VCN%</th><th>VPE%</th><th>CPU%</th><th>NPU%</th><th>NPU Mem (MiB)</th>
        </tr>
      </thead>
      <tbody id="proc-body-${i}"></tbody>`;
    procSec.appendChild(tbl);
    panel.appendChild(procSec);

    main.appendChild(panel);
  });

  state.cur = 0;
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
  if (e) e.textContent = fmt(value, decimals);
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
      content:  `${ev.type}: ${ev.name}`,
      rotation: -90,
      position: 'end',
      yAdjust:  -6,
      color:    labelColor,
      font:     { size: 8 },
      backgroundColor: 'rgba(22,27,34,0.85)',
      padding:  { x: 3, y: 2 },
      xAdjust:  8,
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
  const fmtA     = x => (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(1));
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

function makeLimitLine(val, label, color, unit) {
  return {
    type: 'line', yMin: val, yMax: val, drawTime: 'afterDraw',
    borderColor: color, borderWidth: 1, borderDash: [6, 4],
    label: {
      display: true,
      content: `${label} ${val.toFixed(0)}${unit}`,
      position: 'center',
      color,
      font: { size: 9 },
      backgroundColor: 'transparent',
      padding: 2,
    },
  };
}

function powerLimitAnnotations() {
  const pl = state.powerLimits;
  const out = {};
  if (pl.stapm_w    != null) out.stapLine    = makeLimitLine(pl.stapm_w,    'STAPM',    '#e3b341', 'W');
  if (pl.fast_w     != null) out.fastLine    = makeLimitLine(pl.fast_w,     'Fast',     '#f85149', 'W');
  if (pl.slow_w     != null) out.slowLine    = makeLimitLine(pl.slow_w,     'Slow',     '#3fb950', 'W');
  if (pl.apu_slow_w != null) out.apuSlowLine = makeLimitLine(pl.apu_slow_w, 'APU Slow', '#bc8cff', 'W');
  return out;
}

function temperatureLimitAnnotations() {
  const pl = state.powerLimits;
  const out = {};
  if (pl.thm_core_c != null) out.thmCoreLine = makeLimitLine(pl.thm_core_c, 'THM Core', '#e3b341', '°C');
  if (pl.thm_gfx_c  != null) out.thmGfxLine  = makeLimitLine(pl.thm_gfx_c,  'THM GFX',  '#f85149', '°C');
  if (pl.thm_soc_c  != null) out.thmSocLine  = makeLimitLine(pl.thm_soc_c,  'THM SoC',  '#388bfd', '°C');
  return out;
}

function setAnnotations(chart, times, extra, ...arrays) {
  chart.options.plugins.annotation.annotations = {
    ...minMaxAnnotations(times, chart.options.scales.x.min, ...arrays),
    ...extra,
  };
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
  const vddgfx = v(sens, 'VDDGFX');
  const vddnb  = v(sens, 'VDDNB');
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

  // VRAM card: "used / total GiB"
  const vramEl = document.getElementById(`c-vram-${i}`);
  if (vramEl) vramEl.textContent =
    (vramU != null ? (vramU/1024).toFixed(3) : '—') + ' / ' + (vramT != null ? (vramT/1024).toFixed(3) : '—');

  // GTT card: "used / total GiB"
  const gttEl = document.getElementById(`c-gtt-${i}`);
  if (gttEl) gttEl.textContent =
    (gttU != null ? (gttU/1024).toFixed(3) : '—') + ' / ' + (gttT != null ? (gttT/1024).toFixed(3) : '—');

  // Progress bars
  setBar(`c-gfx-${i}`,   gfx);
  setBar(`c-media-${i}`, media);
  setBar(`c-vram-${i}`,  vramT  > 0 ? vramU  / vramT  * 100 : null);
  setBar(`c-gtt-${i}`,   gttT   > 0 ? gttU   / gttT   * 100 : null);

  // ── History ──
  const nowMs = Date.now();
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
  const cTemp    = state.charts[`${i}-temp`];
  const cGfxClk  = state.charts[`${i}-gfx-clk`];
  const cCorePwr = state.charts[`${i}-core-pwr`];
  const cVoltage = state.charts[`${i}-voltage`];
  const cDramBw  = state.charts[`${i}-dram-bw`];
  const cNpuAct  = state.charts[`${i}-npu-act`];
  const cNpuClk  = state.charts[`${i}-npu-clk`];
  const cNpuBw   = state.charts[`${i}-npu-bw`];

  if (cVram) cVram.options.scales.y.max = h.vramMax;

  // Ensure power chart y-axis includes the ryzenadj limit lines.
  if (cPwr) {
    const limitMax = Math.max(
      state.powerLimits.stapm_w    ?? 0,
      state.powerLimits.fast_w     ?? 0,
      state.powerLimits.slow_w     ?? 0,
      state.powerLimits.apu_slow_w ?? 0,
    );
    if (limitMax > 0) {
      const dataMax = Math.max(
        ...h.pwr.filter(x => x != null),
        ...h.cpuPwr.filter(x => x != null),
        ...h.npuPwr.filter(x => x != null),
        0,
      );
      cPwr.options.scales.y.max = Math.max(limitMax, dataMax) * 1.1;
    }
  }

  if (cAct)     setAnnotations(cAct,    h.times, {},                          h.gfx, h.mem, h.media);
  if (cVram)    setAnnotations(cVram,   h.times, {},                          h.vram, h.vramOnly, h.gttOnly);
  if (cPwr)     setAnnotations(cPwr,    h.times, powerLimitAnnotations(),     h.pwr, h.cpuPwr, h.npuPwr);
  if (cTemp)    setAnnotations(cTemp,   h.times, temperatureLimitAnnotations(), h.tempE, h.tempC, h.tempS, h.tempGfx, h.tempHot, h.tempMem);
  if (cGfxClk)  setAnnotations(cGfxClk, h.times, {},                         h.sclk, h.mclk, h.fclk, h.fclkAvg, h.socClk, h.vclk);
  if (cVoltage) setAnnotations(cVoltage, h.times, {},                         h.vddgfx, h.vddnb);
  if (cCorePwr) setAnnotations(cCorePwr, h.times, {},                         ...h.corePwr);
  if (cDramBw)  setAnnotations(cDramBw,  h.times, {},                         h.dramReads, h.dramWrites);
  if (cNpuAct)  setAnnotations(cNpuAct,  h.times, {},                         ...h.npuBusy);
  if (cNpuClk)  setAnnotations(cNpuClk,  h.times, {},                         h.npuClk, h.npuMpClk);
  if (cNpuBw)   setAnnotations(cNpuBw,   h.times, {},                         h.npuReads, h.npuWrites);

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
    if (!h.prevProcNames.has(pid))
      h.events.push({ timeMs: nowMs, type: 'start', name: currentProcNames.get(pid) });
  }
  for (const [pid, name] of h.prevProcNames) {
    if (!currentProcNames.has(pid))
      h.events.push({ timeMs: nowMs, type: 'stop', name });
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
      <td data-src="devices[${i}].fdinfo[${pid}].usage.VRAM">${fmt(vram,    1)}</td>
      <td data-src="devices[${i}].fdinfo[${pid}].usage.GTT">${fmt(gtt,     1)}</td>
      <td data-src="devices[${i}].fdinfo[${pid}].usage.GFX">${fmt(gfx,     1)}</td>
      <td data-src="devices[${i}].fdinfo[${pid}].usage.Compute">${fmt(compute, 1)}</td>
      <td data-src="devices[${i}].fdinfo[${pid}].usage.DMA">${fmt(dma,     1)}</td>
      <td data-src="devices[${i}].fdinfo[${pid}].usage.Media">${fmt(media,   1)}</td>
      <td data-src="devices[${i}].fdinfo[${pid}].usage.VCN_Unified">${fmt(vcn,     1)}</td>
      <td data-src="devices[${i}].fdinfo[${pid}].usage.VPE">${fmt(vpe,     1)}</td>
      <td data-src="devices[${i}].fdinfo[${pid}].usage.CPU">${fmt(cpu,     1)}</td>
      <td data-src="devices[${i}].xdna_fdinfo[${pid}].usage.NPU">${fmt(npu,     1)}</td>
      <td data-src="devices[${i}].xdna_fdinfo[${pid}].usage['NPU Mem']">${fmt(npuMem,  1)}</td>
    </tr>`;
  }).join('');
}

// ── WebSocket ────────────────────────────────────────────────────────────────
let ws         = null;
let retryMs    = 1000;
let retryTimer = null;
const MAX_RETRY = 30000;

function connect() {
  if (ws && ws.readyState < 2) ws.close(); // CONNECTING or OPEN → close before replacing
  setConnStatus('connecting', 'Connecting…');
  ws = new WebSocket(`ws://${location.host}/ws`);

  ws.addEventListener('open', () => {
    retryMs = 1000;
    setConnStatus('connected', 'Connected');
    appendLog('WebSocket connected', 'ok');
    fetchPowerLimits();
  });

  ws.addEventListener('message', evt => {
    let data;
    try { data = JSON.parse(evt.data); } catch { return; }
    if (!data || !Array.isArray(data.devices)) return;

    const _t = new Date();
    document.getElementById('period-label').textContent =
      _t.toLocaleTimeString([], { hour12: false }) + '.' + String(_t.getMilliseconds()).padStart(3, '0');

    state.lastDevices = data.devices;
    if (state.n !== data.devices.length) buildDom(data.devices);
    data.devices.forEach((dev, i) => updateDevice(i, dev));
  });

  ws.addEventListener('close', () => {
    const delaySec = (retryMs / 1000).toFixed(0);
    setConnStatus('disconnected', `Reconnecting in ${delaySec}s…`);
    appendLog(`WebSocket disconnected — reconnecting in ${delaySec}s`, 'warn');
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
  const nameStr = (name && asic && asic !== name) ? `${name} — ${asic}` : (name || asic);
  const rocm = info['ROCm Version'] || null;

  const metaParts = [];
  if (rocm) metaParts.push(`ROCm ${rocm}`);
  const metaHtml = metaParts.length ? `<div class="di-meta">${metaParts.join('  ')}</div>` : '';

  const specsParts = [];
  const cu = info['Compute Unit'] ?? info['Compute Units'] ?? null;
  if (cu != null) specsParts.push(`${cu} CUs`);
  const vramType = info['VRAM Type'] ?? null;
  if (vramType) specsParts.push(vramType);
  const vramTotalMiB = (dev.VRAM ? (dev.VRAM['Total VRAM']?.value ?? dev.VRAM['Total VRAM'] ?? null) : null);
  if (vramTotalMiB != null) {
    const gib = vramTotalMiB / 1024;
    specsParts.push(`${gib.toFixed(3)} GiB VRAM`);
  }
  const bw = info['Memory Bandwidth'] ?? null;
  if (bw != null) specsParts.push(`${typeof bw === 'number' ? bw.toFixed(0) : bw} GB/s BW`);
  const fp32Raw = v(info, 'Peak FP32') ?? v(info, 'Peak GFLOPS') ?? null;
  const fp32Num = fp32Raw != null ? Number(fp32Raw) : null;
  if (fp32Num != null && !isNaN(fp32Num)) specsParts.push(`${(fp32Num / 1000).toFixed(1)} TFLOPS`);
  const npuName = info['IPU'] ?? info['NPU'] ?? null;
  if (npuName) specsParts.push(`NPU: ${npuName}`);
  const specsHtml = specsParts.length ? `<div class="di-specs">${specsParts.join(' ◆ ')}</div>` : '';

  const pl = state.powerLimits;
  let limitsHtml = '';
  const limitParts = [];
  if (pl.stapm_w    != null) limitParts.push(`<span class="di-limit-stapm">STAPM ${pl.stapm_w.toFixed(0)}W</span>`);
  if (pl.fast_w     != null) limitParts.push(`<span class="di-limit-fast">Fast ${pl.fast_w.toFixed(0)}W</span>`);
  if (pl.slow_w     != null) limitParts.push(`<span class="di-limit-slow">Slow ${pl.slow_w.toFixed(0)}W</span>`);
  if (pl.apu_slow_w != null) limitParts.push(`<span class="di-limit-apu-slow">APU Slow ${pl.apu_slow_w.toFixed(0)}W</span>`);
  if (pl.thm_core_c != null) limitParts.push(`<span class="di-limit-thm-core">THM Core ${pl.thm_core_c.toFixed(0)}°C</span>`);
  if (pl.thm_gfx_c  != null) limitParts.push(`<span class="di-limit-thm-gfx">THM GFX ${pl.thm_gfx_c.toFixed(0)}°C</span>`);
  if (pl.thm_soc_c  != null) limitParts.push(`<span class="di-limit-thm-soc">THM SoC ${pl.thm_soc_c.toFixed(0)}°C</span>`);
  if (limitParts.length) {
    limitsHtml = `<div class="di-limits"><span class="di-limit-label">ryzenadj limits:</span>  ${limitParts.join('  ')}</div>`;
  }

  el.innerHTML = (nameStr ? `<div class="di-name">${nameStr}</div>` : '') + metaHtml + specsHtml + limitsHtml;
}

// ── CPU core performance ranks ────────────────────────────────────────────────

function coreLabel(j) {
  const rank = state.coreRanks[j];
  return rank != null ? `C${j} (R#${rank})` : `C${j}`;
}

function fetchCoreRanks() {
  fetch('/api/cpu-ranks')
    .then(r => r.ok ? r.json() : null)
    .then(d => {
      if (d?.ranks?.length) {
        state.coreRanks = d.ranks;
        if (state.lastDevices) buildDom(state.lastDevices);
      }
    })
    .catch(() => {});
}

// ── Power limits ─────────────────────────────────────────────────────────────
function fetchPowerLimits() {
  fetch('/api/limits')
    .then(r => r.json())
    .then(d => {
      state.powerLimits.stapm_w    = d.stapm_w    ?? null;
      state.powerLimits.fast_w     = d.fast_w     ?? null;
      state.powerLimits.slow_w     = d.slow_w     ?? null;
      state.powerLimits.apu_slow_w = d.apu_slow_w ?? null;
      state.powerLimits.thm_core_c = d.thm_core_c ?? null;
      state.powerLimits.thm_gfx_c  = d.thm_gfx_c  ?? null;
      state.powerLimits.thm_soc_c  = d.thm_soc_c  ?? null;
      // Refresh header once limits are loaded (device may already be shown).
      if (state.hist.length > 0 && state.lastDev0) updateDeviceInfoHeader(state.lastDev0);
      const pl = state.powerLimits;
      const parts = [];
      if (pl.stapm_w    != null) parts.push(`STAPM ${pl.stapm_w.toFixed(0)}W`);
      if (pl.fast_w     != null) parts.push(`Fast ${pl.fast_w.toFixed(0)}W`);
      if (pl.slow_w     != null) parts.push(`Slow ${pl.slow_w.toFixed(0)}W`);
      if (pl.apu_slow_w != null) parts.push(`APU Slow ${pl.apu_slow_w.toFixed(0)}W`);
      if (pl.thm_core_c != null) parts.push(`THM Core ${pl.thm_core_c.toFixed(0)}°C`);
      if (pl.thm_gfx_c  != null) parts.push(`THM GFX ${pl.thm_gfx_c.toFixed(0)}°C`);
      if (pl.thm_soc_c  != null) parts.push(`THM SoC ${pl.thm_soc_c.toFixed(0)}°C`);
      if (parts.length) appendLog(`Power limits: ${parts.join('  ')}`);
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

// ── Interval control ─────────────────────────────────────────────────────────
function initIntervalCtrl() {
  fetch('/api/config')
    .then(r => r.json())
    .then(cfg => {
      if (!localStorage.getItem('atopweb.intervalMs')) {
        state.intervalMs = cfg.interval_ms;
        document.getElementById('interval-input').value = cfg.interval_ms;
      }
      document.getElementById('page-title').textContent = 'atopweb ' + (cfg.atopweb_version || '');
      if (cfg.amdgpu_top_version) {
        document.getElementById('page-subtitle').textContent = cfg.amdgpu_top_version;
      }
    })
    .catch(() => {});

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
  const headerH = document.querySelector('header')?.offsetHeight || 0;
  const tabsH   = document.getElementById('tabs')?.offsetHeight  || 0;
  const statusH = document.getElementById('status-bar')?.offsetHeight || 0;
  overlay.style.top    = (headerH + tabsH) + 'px';
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
  srcOpts.plugins.tooltip.external = externalTooltip;
  srcOpts.layout.padding = { top: 20, right: 12, bottom: 24, left: 12 };

  state.overlayChart = new Chart(canvas, {
    type: src.config.type,
    data: src.config.data,
    options: srcOpts,
    plugins: src.config.plugins || [],
  });

  const isCoreFreq = chartKey.includes('-cpu-core-');
  state.overlayWidthMs = isCoreFreq ? state.coreTimeWidthMs : state.timeWidthMs;
  appendLog(`Maximized: ${title}`);
}

function closeOverlay() {
  document.getElementById('plot-overlay').hidden = true;
  if (state.overlayChart) { state.overlayChart.destroy(); state.overlayChart = null; }
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
}

loadSavedSettings();
initDataSrcTooltip();
initIntervalCtrl();
initPlotWidthCtrl();
initPauseBtn();
initStatusBar();
initOverlay();
updateStickyOffset();
fetchPowerLimits();
setInterval(fetchPowerLimits, 300_000);
fetchCoreRanks();
connect();
