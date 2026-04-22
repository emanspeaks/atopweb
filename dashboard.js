'use strict';
// chartjs-plugin-annotation auto-registers itself when loaded from CDN after Chart.js.

// ── Constants ────────────────────────────────────────────────────────────────
const HISTORY = 60;

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

const CHART_DEFAULTS = {
  animation: false,
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: {
      labels: { color: '#8b949e', boxWidth: 10, font: { size: 11 } }
    },
    tooltip: {
      backgroundColor: '#1c2128',
      borderColor: '#30363d',
      borderWidth: 1,
      titleColor: '#e6edf3',
      bodyColor: '#8b949e',
    },
    annotation: { annotations: {} }
  },
  scales: {
    x: {
      ticks: { display: false },
      grid:  { color: '#21262d' },
      border: { color: '#30363d' }
    },
    y: {
      ticks: { color: '#8b949e', font: { size: 11 } },
      grid:  { color: '#21262d' },
      border: { color: '#30363d' }
    }
  }
};

function makeDataset(label, color, data) {
  return {
    label,
    data,
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
  if (_rafPending) return;
  _rafPending = true;
  requestAnimationFrame(() => {
    _rafPending = false;
    for (const c of Object.values(state.charts)) c.update('none');
  });
}

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  cur:         -1,
  n:            0,
  hist:        [],
  charts:      {},
  powerLimits: { stapm_w: null, fast_w: null, slow_w: null },
  lastDev0:    null,
};

function makeHist() {
  return {
    labels:  Array(HISTORY).fill(''),
    times:   Array(HISTORY).fill(null),  // epoch ms per slot for tooltip
    gfx:     Array(HISTORY).fill(null),
    mem:     Array(HISTORY).fill(null),
    media:   Array(HISTORY).fill(null),
    vram:    Array(HISTORY).fill(null),  // VRAM+GTT combined used GiB
    pwr:     Array(HISTORY).fill(null),
    tempE:   Array(HISTORY).fill(null),
    tempC:   Array(HISTORY).fill(null),
    tempS:   Array(HISTORY).fill(null),
    sclk:    Array(HISTORY).fill(null),
    mclk:    Array(HISTORY).fill(null),
    fclk:    Array(HISTORY).fill(null),
    corePwr: Array.from({length: 16}, () => Array(HISTORY).fill(null)),
    coreClk: Array.from({length: 16}, () => Array(HISTORY).fill(null)),
    vramMax: 1,  // VRAM+GTT combined total GiB
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
      const str = isNaN(raw) ? String(item.raw) :
        (Number.isInteger(raw) ? String(raw) : raw.toFixed(1));
      return ` ${item.dataset.label}: ${str}`;
    },
  };
}

function fmtTick(v) {
  if (typeof v !== 'number') return String(v);
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

// ── Build DOM (once per device-count change) ─────────────────────────────────
function buildDom(devices) {
  const tabs = document.getElementById('tabs');
  const main = document.getElementById('main');
  tabs.innerHTML = '';
  main.innerHTML = '';

  state.n = devices.length;
  state.hist = devices.map(() => makeHist());
  state.charts = {};

  if (devices.length > 1) tabs.classList.add('visible');

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
        key: 'activity', title: 'GPU Activity (%)', height: 140, yMax: 100,
        datasets: () => [
          makeDataset('GFX',    '#e85d04', h.gfx),
          makeDataset('Memory', '#388bfd', h.mem),
          makeDataset('Media',  '#bc8cff', h.media),
        ]
      },
      {
        key: 'vram', title: 'VRAM + GTT Usage (GiB)', height: 140, yMax: null,
        datasets: () => [makeDataset('VRAM+GTT', '#3fb950', h.vram)]
      },
      {
        key: 'temp', title: 'Temperature (°C)', height: 140, yMax: null,
        datasets: () => [
          makeDataset('Edge',     '#f85149', h.tempE),
          makeDataset('CPU Tctl', '#e3b341', h.tempC),
          makeDataset('SoC',      '#bc8cff', h.tempS),
        ]
      },
      {
        key: 'core-pwr', title: 'Core Power (W)', height: 140, yMax: null, hideLegend: true,
        datasets: () => Array.from({length: 16}, (_, j) => ({
          label: `Core ${j}`,
          data: h.corePwr[j],
          borderColor: `hsl(${Math.round(j * 22.5)}, 65%, 55%)`,
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
          makeDataset('SCLK', '#e85d04', h.sclk),
          makeDataset('MCLK', '#388bfd', h.mclk),
          makeDataset('FCLK', '#3fb950', h.fclk),
        ]
      },
      {
        key: 'core-clk', title: 'Core Clocks (MHz)', height: 140, yMax: null, hideLegend: true,
        datasets: () => Array.from({length: 16}, (_, j) => ({
          label: `Core ${j}`,
          data: h.coreClk[j],
          borderColor: `hsl(${Math.round(j * 22.5)}, 65%, 55%)`,
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.25,
          pointRadius: 0,
          borderWidth: 1,
        }))
      },
      {
        key: 'power', title: 'Package Power (W)', height: 140, yMax: null, wide: true,
        datasets: () => [makeDataset('Power', '#e3b341', h.pwr)]
      },
    ];

    chartDefs.forEach(def => {
      const box    = el('div', 'chart-box' + (def.wide ? ' chart-wide' : ''));
      const title  = el('div', 'chart-title', def.title);
      const wrap   = el('div');
      wrap.style.height = (def.height || 160) + 'px';
      const canvas = el('canvas');
      wrap.appendChild(canvas);
      box.appendChild(title);
      box.appendChild(wrap);
      chartGrid.appendChild(box);

      const cfg = JSON.parse(JSON.stringify(CHART_DEFAULTS));
      cfg.scales.y.min = 0;
      if (def.yMax != null) cfg.scales.y.max = def.yMax;
      if (def.hideLegend) cfg.plugins.legend.display = false;
      cfg.plugins.tooltip.callbacks = makeChartCallbacks(h);
      cfg.scales.y.ticks.callback   = fmtTick;

      state.charts[`${i}-${def.key}`] = new Chart(canvas, {
        type: 'line',
        data: { labels: h.labels, datasets: def.datasets() },
        options: cfg,
      });
    });

    panel.appendChild(chartGrid);

    // ── GRBM / GRBM2 performance counters ──
    const grbmSec = el('div', 'grbm-section');
    grbmSec.appendChild(el('div', 'section-title', 'Performance Counters'));
    const grbmGrid = el('div', 'grbm-grid');

    const buildPCCol = (colTitle, keys, prefix, barCls) => {
      const col = el('div', 'grbm-col');
      col.appendChild(el('div', 'grbm-col-title', colTitle));
      keys.forEach((key, ki) => {
        const label = key.length > 30 ? key.slice(0, 28) + '…' : key;
        const item = el('div', 'grbm-item');
        item.innerHTML = `
          <div class="grbm-item-header">
            <span class="grbm-item-label" title="${key}">${label}</span>
            <span class="grbm-item-val" id="${prefix}-val-${i}-${ki}">—</span>
          </div>
          <div class="grbm-bar-wrap">
            <div class="grbm-bar ${barCls}" id="${prefix}-bar-${i}-${ki}"></div>
          </div>`;
        col.appendChild(item);
      });
      return col;
    };

    grbmGrid.appendChild(buildPCCol('GRBM',  GRBM_KEYS,  'grbm',  'grbm-orange'));
    grbmGrid.appendChild(buildPCCol('GRBM2', GRBM2_KEYS, 'grbm2', 'grbm-blue'));
    grbmSec.appendChild(grbmGrid);
    panel.appendChild(grbmSec);

    // ── Process table ──
    const procSec = el('div', 'proc-section');
    procSec.appendChild(el('div', 'section-title', 'GPU Processes'));
    const tbl = el('table', 'proc-table');
    tbl.innerHTML = `
      <thead>
        <tr>
          <th>PID</th><th>Name</th>
          <th>VRAM (GiB)</th><th>GTT (GiB)</th><th>CPU%</th>
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
  arr.shift();
  arr.push(val);
}

// Returns a min/max annotation object (does not modify the chart).
function minMaxAnnotations(...arrays) {
  const allVals = arrays.flat().filter(x => x != null);
  const out = {};
  if (allVals.length >= 2) {
    const minVal = Math.min(...allVals);
    const maxVal = Math.max(...allVals);
    const color  = 'rgba(139,148,158,0.6)';
    const fmtA   = x => (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(1));
    out.minLine = {
      type: 'line', yMin: minVal, yMax: minVal,
      borderColor: color, borderWidth: 1, borderDash: [3, 3],
      label: { display: true, content: fmtA(minVal), position: 'start', color, font: { size: 9 }, backgroundColor: 'transparent', padding: 2, yAdjust: 10 }
    };
    if (maxVal !== minVal) {
      out.maxLine = {
        type: 'line', yMin: maxVal, yMax: maxVal,
        borderColor: color, borderWidth: 1, borderDash: [3, 3],
        label: { display: true, content: fmtA(maxVal), position: 'end', color, font: { size: 9 }, backgroundColor: 'transparent', padding: 2, yAdjust: -10 }
      };
    }
  }
  return out;
}

// Returns annotation lines for the three APU power limits.
function powerLimitAnnotations() {
  const out = {};
  const defs = [
    { key: 'staplLine', label: 'STAPM', val: state.powerLimits.stapm_w, color: '#e3b341' },
    { key: 'fastLine',  label: 'Fast',  val: state.powerLimits.fast_w,  color: '#f85149' },
    { key: 'slowLine',  label: 'Slow',  val: state.powerLimits.slow_w,  color: '#3fb950' },
  ];
  defs.forEach(({ key, label, val, color }) => {
    if (val == null) return;
    out[key] = {
      type: 'line', yMin: val, yMax: val,
      borderColor: color, borderWidth: 1, borderDash: [6, 4],
      label: {
        display: true,
        content: `${label} ${val.toFixed(0)}W`,
        position: 'center',
        color,
        font: { size: 9 },
        backgroundColor: 'transparent',
        padding: 2,
      },
    };
  });
  return out;
}

function setAnnotations(chart, extra, ...arrays) {
  chart.options.plugins.annotation.annotations = {
    ...minMaxAnnotations(...arrays),
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
  const tempSRaw = dev.gpu_metrics?.temperature_soc ?? null;
  const tempS    = tempSRaw != null ? tempSRaw / 100 : null;

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

  // VRAM card: "used / total GiB"
  const vramEl = document.getElementById(`c-vram-${i}`);
  if (vramEl) vramEl.textContent =
    (vramU != null ? (vramU/1024).toFixed(1) : '—') + ' / ' + (vramT != null ? (vramT/1024).toFixed(1) : '—');

  // GTT card: "used / total GiB"
  const gttEl = document.getElementById(`c-gtt-${i}`);
  if (gttEl) gttEl.textContent =
    (gttU != null ? (gttU/1024).toFixed(1) : '—') + ' / ' + (gttT != null ? (gttT/1024).toFixed(1) : '—');

  // Progress bars
  setBar(`c-gfx-${i}`,   gfx);
  setBar(`c-media-${i}`, media);
  setBar(`c-vram-${i}`,  vramT  > 0 ? vramU  / vramT  * 100 : null);
  setBar(`c-gtt-${i}`,   gttT   > 0 ? gttU   / gttT   * 100 : null);

  // ── History ──
  pushHistory(h.times, Date.now());
  pushHistory(h.gfx,   gfx);
  pushHistory(h.mem,   mem);
  pushHistory(h.media, media);
  pushHistory(h.vram,  combinedU != null ? combinedU / 1024 : null);  // MiB → GiB
  pushHistory(h.pwr,   pwr);
  pushHistory(h.tempE, tempE);
  pushHistory(h.tempC, cputmp);
  pushHistory(h.tempS, tempS);
  pushHistory(h.sclk,  sclk);
  pushHistory(h.mclk,  mclk);
  pushHistory(h.fclk,  fclk);

  const gm = dev.gpu_metrics || {};
  const avgCorePwr = Array.isArray(gm.average_core_power) ? gm.average_core_power : [];
  const curCoreClk = Array.isArray(gm.current_coreclk)   ? gm.current_coreclk   : [];
  for (let j = 0; j < 16; j++) {
    const pwrMW  = (avgCorePwr[j] != null && avgCorePwr[j] < 65535) ? avgCorePwr[j] : null;
    const clkMHz = (curCoreClk[j] != null && curCoreClk[j] < 65535) ? curCoreClk[j] : null;
    pushHistory(h.corePwr[j], pwrMW  != null ? pwrMW / 1000 : null);
    pushHistory(h.coreClk[j], clkMHz);
  }

  if (combinedT != null && combinedT > 0) h.vramMax = combinedT / 1024;  // MiB → GiB

  // ── Chart options (scale/annotations) — rendering is batched via scheduleRender ──
  const cAct    = state.charts[`${i}-activity`];
  const cVram   = state.charts[`${i}-vram`];
  const cPwr    = state.charts[`${i}-power`];
  const cTemp   = state.charts[`${i}-temp`];
  const cGfxClk = state.charts[`${i}-gfx-clk`];

  if (cVram) cVram.options.scales.y.max = h.vramMax;

  // Ensure power chart y-axis includes the ryzenadj limit lines.
  if (cPwr) {
    const limitMax = Math.max(
      state.powerLimits.stapm_w ?? 0,
      state.powerLimits.fast_w  ?? 0,
      state.powerLimits.slow_w  ?? 0,
    );
    if (limitMax > 0) {
      const dataMax = Math.max(...h.pwr.filter(x => x != null), 0);
      cPwr.options.scales.y.max = Math.max(limitMax, dataMax) * 1.1;
    }
  }

  if (cAct)    setAnnotations(cAct,    {},                      h.gfx, h.mem, h.media);
  if (cVram)   setAnnotations(cVram,   {},                      h.vram);
  if (cPwr)    setAnnotations(cPwr,    powerLimitAnnotations(), h.pwr);
  if (cTemp)   setAnnotations(cTemp,   {},                      h.tempE, h.tempC, h.tempS);
  if (cGfxClk) setAnnotations(cGfxClk, {},                     h.sclk, h.mclk, h.fclk);

  scheduleRender();

  // ── GRBM performance counters ──
  GRBM_KEYS.forEach((key, ki) => {
    const val = v(grbm, key);
    const ve  = document.getElementById(`grbm-val-${i}-${ki}`);
    const be  = document.getElementById(`grbm-bar-${i}-${ki}`);
    if (ve) ve.textContent = val != null ? val.toFixed(0) + '%' : '—';
    if (be) be.style.width = (val != null ? Math.min(100, Math.max(0, val)) : 0) + '%';
  });

  GRBM2_KEYS.forEach((key, ki) => {
    const val = v(grbm2, key);
    const ve  = document.getElementById(`grbm2-val-${i}-${ki}`);
    const be  = document.getElementById(`grbm2-bar-${i}-${ki}`);
    if (ve) ve.textContent = val != null ? val.toFixed(0) + '%' : '—';
    if (be) be.style.width = (val != null ? Math.min(100, Math.max(0, val)) : 0) + '%';
  });

  // ── Process table ──
  const tbody = document.getElementById(`proc-body-${i}`);
  if (!tbody) return;

  const fdinfo = dev.fdinfo || {};
  const pids   = Object.keys(fdinfo);

  if (pids.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="proc-empty" style="padding:12px 16px">No GPU processes</td></tr>`;
    return;
  }

  // amdgpu_top may store per-process fields directly on the object or under
  // a nested "usage" key depending on version; try both.
  const getUsage = (p) => p.usage || p;

  const getVramMiB = (proc) => {
    const u = getUsage(proc);
    return v(u, 'VRAM') ?? v(u, 'vram_usage') ?? v(u, 'vram') ?? 0;
  };
  pids.sort((a, b) => getVramMiB(fdinfo[b]) - getVramMiB(fdinfo[a]));

  tbody.innerHTML = pids.map(pid => {
    const proc    = fdinfo[pid];
    const u       = getUsage(proc);
    const vramMiB = v(u, 'VRAM')  ?? v(u, 'vram_usage') ?? v(u, 'vram');
    const gttMiB  = v(u, 'GTT')   ?? v(u, 'gtt_usage')  ?? v(u, 'gtt');
    const cpu     = v(u, 'CPU')   ?? v(u, 'cpu_usage')   ?? v(u, 'cpu');
    return `<tr>
      <td class="proc-pid">${pid}</td>
      <td class="proc-name">${proc.name || '?'}</td>
      <td>${fmt(vramMiB != null ? vramMiB / 1024 : null, 2)}</td>
      <td>${fmt(gttMiB  != null ? gttMiB  / 1024 : null, 2)}</td>
      <td>${fmt(cpu, 1)}</td>
    </tr>`;
  }).join('');
}

// ── WebSocket ────────────────────────────────────────────────────────────────
let ws      = null;
let retryMs = 1000;
const MAX_RETRY = 30000;

function connect() {
  setConnStatus('connecting', 'Connecting…');
  ws = new WebSocket(`ws://${location.host}/ws`);

  ws.addEventListener('open', () => {
    retryMs = 1000;
    setConnStatus('connected', 'Connected');
    fetchPowerLimits();
  });

  ws.addEventListener('message', evt => {
    let data;
    try { data = JSON.parse(evt.data); } catch { return; }
    if (!data || !Array.isArray(data.devices)) return;

    const _t = new Date();
    document.getElementById('period-label').textContent =
      _t.toLocaleTimeString([], { hour12: false }) + '.' + String(_t.getMilliseconds()).padStart(3, '0');

    if (state.n !== data.devices.length) buildDom(data.devices);
    data.devices.forEach((dev, i) => updateDevice(i, dev));
  });

  ws.addEventListener('close', () => {
    setConnStatus('disconnected', `Reconnecting in ${(retryMs / 1000).toFixed(0)}s…`);
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, MAX_RETRY);
  });

  ws.addEventListener('error', () => ws.close());
}

// ── Device info header ───────────────────────────────────────────────────────
function updateDeviceInfoHeader(dev) {
  const el = document.getElementById('device-info');
  if (!el) return;
  const info = dev.Info || {};
  const name = info.DeviceName || info['ASIC Name'] || '';
  const asic = info['ASIC Name'] || '';
  const nameStr = (name && asic && asic !== name) ? `${name} — ${asic}` : (name || asic);

  const { stapm_w, fast_w, slow_w } = state.powerLimits;
  let limitsHtml = '';
  if (stapm_w != null || fast_w != null || slow_w != null) {
    const parts = [];
    if (stapm_w != null) parts.push(`<span class="di-limit-stapm">STAPM ${stapm_w.toFixed(0)}W</span>`);
    if (fast_w  != null) parts.push(`<span class="di-limit-fast">Fast ${fast_w.toFixed(0)}W</span>`);
    if (slow_w  != null) parts.push(`<span class="di-limit-slow">Slow ${slow_w.toFixed(0)}W</span>`);
    limitsHtml = `<div class="di-limits">${parts.join('  ')}</div>`;
  }

  el.innerHTML = (nameStr ? `<div class="di-name">${nameStr}</div>` : '') + limitsHtml;
}

// ── Power limits ─────────────────────────────────────────────────────────────
function fetchPowerLimits() {
  fetch('/api/power-limits')
    .then(r => r.json())
    .then(d => {
      state.powerLimits.stapm_w = d.stapm_w ?? null;
      state.powerLimits.fast_w  = d.fast_w  ?? null;
      state.powerLimits.slow_w  = d.slow_w  ?? null;
      // Refresh header once limits are loaded (device may already be shown).
      if (state.hist.length > 0 && state.lastDev0) updateDeviceInfoHeader(state.lastDev0);
    })
    .catch(() => {});
}

// ── Interval control ─────────────────────────────────────────────────────────
function initIntervalCtrl() {
  fetch('/api/config')
    .then(r => r.json())
    .then(cfg => {
      document.getElementById('interval-input').value = cfg.interval_ms;
      document.getElementById('page-title').textContent = 'atopweb ' + (cfg.atopweb_version || '');
      if (cfg.amdgpu_top_version) {
        document.getElementById('page-subtitle').textContent = cfg.amdgpu_top_version;
      }
    })
    .catch(() => {});

  const apply = () => {
    const ms = parseInt(document.getElementById('interval-input').value, 10);
    if (isNaN(ms) || ms < 50 || ms > 60000) return;
    fetch(`/api/interval?ms=${ms}`, { method: 'POST' });
  };

  document.getElementById('interval-btn').addEventListener('click', apply);
  document.getElementById('interval-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') apply();
  });
}

initIntervalCtrl();
fetchPowerLimits();
setInterval(fetchPowerLimits, 30_000);
connect();
