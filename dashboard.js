'use strict';

// ── Constants ────────────────────────────────────────────────────────────────
const HISTORY = 60;

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
    }
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

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  cur: -1,   // active GPU tab index
  n:    0,   // total GPU count (once known)
  hist: [],  // per-GPU history objects
  charts: {} // keyed by "i-name"
};

function makeHist() {
  const labels = Array(HISTORY).fill('');
  return {
    labels,
    gfx:    Array(HISTORY).fill(null),
    mem:    Array(HISTORY).fill(null),
    media:  Array(HISTORY).fill(null),
    vram:   Array(HISTORY).fill(null),
    pwr:    Array(HISTORY).fill(null),
    tempE:  Array(HISTORY).fill(null),
    tempJ:  Array(HISTORY).fill(null),
    vramMax: 1,
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
  const dot  = document.getElementById('conn-dot');
  const span = document.getElementById('conn-label');
  dot.className  = 'conn-dot ' + status;
  span.textContent = label;
}

// ── Build DOM (once) ─────────────────────────────────────────────────────────
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
      { id: `c-gfx-${i}`,   cls: 'c-gfx',   label: 'GFX',        unit: '%',   bar: true },
      { id: `c-mem-${i}`,   cls: 'c-mem',   label: 'Memory',     unit: '%',   bar: true },
      { id: `c-media-${i}`, cls: 'c-media', label: 'Media',      unit: '%',   bar: true },
      { id: `c-vram-${i}`,  cls: 'c-vram',  label: 'VRAM',       unit: 'MiB', bar: true },
      { id: `c-gtt-${i}`,   cls: 'c-gtt',   label: 'GTT Used',   unit: 'MiB', bar: false },
      { id: `c-sclk-${i}`,  cls: 'c-sclk',  label: 'GFX Clock',  unit: 'MHz', bar: false },
      { id: `c-mclk-${i}`,  cls: 'c-mclk',  label: 'Mem Clock',  unit: 'MHz', bar: false },
      { id: `c-pwr-${i}`,   cls: 'c-pwr',   label: 'Power',      unit: 'W',   bar: false },
      { id: `c-etmp-${i}`,  cls: 'c-etmp',  label: 'Edge Temp',  unit: '°C',  bar: false },
      { id: `c-jtmp-${i}`,  cls: 'c-jtmp',  label: 'Jnct Temp',  unit: '°C',  bar: false },
      { id: `c-fan-${i}`,   cls: 'c-fan',   label: 'Fan',        unit: 'RPM', bar: false },
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

    const chartDefs = [
      {
        key: 'activity', title: 'GPU Activity (%)',
        height: 160,
        yMax: 100,
        datasets: (h) => [
          makeDataset('GFX',    '#e85d04', h.gfx),
          makeDataset('Memory', '#388bfd', h.mem),
          makeDataset('Media',  '#bc8cff', h.media),
        ]
      },
      {
        key: 'vram', title: 'VRAM Usage (MiB)',
        height: 160,
        yMax: null,
        datasets: (h) => [
          makeDataset('VRAM', '#3fb950', h.vram),
        ]
      },
      {
        key: 'power', title: 'Power (W)',
        height: 160,
        yMax: null,
        datasets: (h) => [
          makeDataset('Power', '#e3b341', h.pwr),
        ]
      },
      {
        key: 'temp', title: 'Temperature (°C)',
        height: 160,
        datasets: (h) => [
          makeDataset('Edge',     '#f85149', h.tempE),
          makeDataset('Junction', '#ff8080', h.tempJ),
        ]
      },
    ];

    chartDefs.forEach(def => {
      const box    = el('div', 'chart-box');
      const title  = el('div', 'chart-title', def.title);
      const wrap   = el('div');
      wrap.style.height = (def.height || 160) + 'px';
      const canvas = el('canvas');
      wrap.appendChild(canvas);
      box.appendChild(title);
      box.appendChild(wrap);
      chartGrid.appendChild(box);

      const h   = state.hist[i];
      const cfg = JSON.parse(JSON.stringify(CHART_DEFAULTS));

      // y-axis max
      if (def.yMax != null) {
        cfg.scales.y.max = def.yMax;
        cfg.scales.y.min = 0;
      } else {
        cfg.scales.y.min = 0;
      }

      state.charts[`${i}-${def.key}`] = new Chart(canvas, {
        type: 'line',
        data: { labels: h.labels, datasets: def.datasets(h) },
        options: cfg,
      });
    });

    panel.appendChild(chartGrid);

    // ── Process table ──
    const procSec = el('div', 'proc-section');
    procSec.appendChild(el('div', 'proc-title', 'GPU Processes'));
    const tbl = el('table', 'proc-table');
    tbl.innerHTML = `
      <thead>
        <tr>
          <th>PID</th><th>Name</th>
          <th>VRAM (MiB)</th><th>GTT (MiB)</th>
          <th>GFX%</th><th>Compute%</th><th>Media%</th><th>DMA%</th>
        </tr>
      </thead>
      <tbody id="proc-body-${i}"></tbody>
    `;
    procSec.appendChild(tbl);
    panel.appendChild(procSec);

    main.appendChild(panel);
  });

  state.cur = 0;
}

function switchTab(idx) {
  if (idx === state.cur) return;

  document.querySelectorAll('.tab-btn').forEach((btn, i) => {
    btn.classList.toggle('active', i === idx);
  });
  document.querySelectorAll('.gpu-panel').forEach((p, i) => {
    p.classList.toggle('active', i === idx);
  });
  state.cur = idx;
}

// ── Update helpers ───────────────────────────────────────────────────────────
function v(obj, key) {
  if (!obj || obj[key] == null) return null;
  const entry = obj[key];
  if (typeof entry === 'object' && 'value' in entry) return entry.value;
  return null;
}

function fmt(val, decimals) {
  if (val == null) return '—';
  return decimals != null ? val.toFixed(decimals) : String(val);
}

function setCard(id, value, decimals) {
  const el = document.getElementById(id);
  if (el) el.textContent = fmt(value, decimals);
}

function setBar(id, pct) {
  const bar = document.getElementById(id + '-bar');
  if (bar) bar.style.width = (pct == null ? 0 : Math.min(100, Math.max(0, pct))) + '%';
}

function pushHistory(arr, val) {
  arr.shift();
  arr.push(val);
}

function updateDevice(i, dev) {
  const h    = state.hist[i];
  const act  = dev.gpu_activity || {};
  const vram = dev.VRAM || {};
  const sens = dev.Sensors || {};

  // ── Read values ──
  const gfx    = v(act, 'GFX');
  const mem    = v(act, 'Memory');
  const media  = v(act, 'MediaEngine');
  const vramU  = v(vram, 'Total VRAM Usage');
  const vramT  = v(vram, 'Total VRAM');
  const gttU   = v(vram, 'Total GTT Usage');
  const sclk   = v(sens, 'GFX_SCLK');
  const mclk   = v(sens, 'GFX_MCLK');
  const pwr    = v(sens, 'GFX Power') ?? v(sens, 'Average Power') ?? v(sens, 'Input Power');
  const tempE  = v(sens, 'Edge Temperature');
  const tempJ  = v(sens, 'Junction Temperature');
  const fan    = v(sens, 'Fan');

  // ── Stat cards ──
  setCard(`c-gfx-${i}`,   gfx);
  setCard(`c-mem-${i}`,   mem);
  setCard(`c-media-${i}`, media);
  setCard(`c-sclk-${i}`,  sclk);
  setCard(`c-mclk-${i}`,  mclk);
  setCard(`c-pwr-${i}`,   pwr, 1);
  setCard(`c-etmp-${i}`,  tempE);
  setCard(`c-jtmp-${i}`,  tempJ);
  setCard(`c-fan-${i}`,   fan);
  setCard(`c-gtt-${i}`,   gttU);

  // VRAM card: "used / total"
  const vramEl = document.getElementById(`c-vram-${i}`);
  if (vramEl) {
    vramEl.textContent = (vramU != null ? vramU : '—') + ' / ' + (vramT != null ? vramT : '—');
  }

  // Progress bars (percentage-based)
  setBar(`c-gfx-${i}`,   gfx);
  setBar(`c-mem-${i}`,   mem);
  setBar(`c-media-${i}`, media);
  setBar(`c-vram-${i}`,  vramT != null && vramU != null ? (vramU / vramT * 100) : null);

  // ── History ──
  pushHistory(h.gfx,   gfx);
  pushHistory(h.mem,   mem);
  pushHistory(h.media, media);
  pushHistory(h.vram,  vramU);
  pushHistory(h.pwr,   pwr);
  pushHistory(h.tempE, tempE);
  pushHistory(h.tempJ, tempJ);

  if (vramT != null) h.vramMax = vramT;

  // ── Charts ──
  const cAct  = state.charts[`${i}-activity`];
  const cVram = state.charts[`${i}-vram`];
  const cPwr  = state.charts[`${i}-power`];
  const cTemp = state.charts[`${i}-temp`];

  if (cVram) cVram.options.scales.y.max = h.vramMax;

  [cAct, cVram, cPwr, cTemp].forEach(c => { if (c) c.update('none'); });

  // ── Process table ──
  const tbody = document.getElementById(`proc-body-${i}`);
  if (!tbody) return;

  const fdinfo = dev.fdinfo || {};
  const pids   = Object.keys(fdinfo);

  if (pids.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="proc-empty" style="padding:12px 16px">No GPU processes</td></tr>`;
    return;
  }

  // Sort by VRAM usage descending
  pids.sort((a, b) => {
    const av = v(fdinfo[a].usage, 'VRAM') ?? 0;
    const bv = v(fdinfo[b].usage, 'VRAM') ?? 0;
    return bv - av;
  });

  tbody.innerHTML = pids.map(pid => {
    const proc  = fdinfo[pid];
    const u     = proc.usage || {};
    const media = v(u, 'Media') ?? v(u, 'VCN_Unified');

    return `<tr>
      <td class="proc-pid">${pid}</td>
      <td class="proc-name">${proc.name || '?'}</td>
      <td>${fmt(v(u, 'VRAM'))}</td>
      <td>${fmt(v(u, 'GTT'))}</td>
      <td>${fmt(v(u, 'GFX'))}</td>
      <td>${fmt(v(u, 'Compute'))}</td>
      <td>${fmt(media)}</td>
      <td>${fmt(v(u, 'DMA'))}</td>
    </tr>`;
  }).join('');
}

// ── WebSocket ────────────────────────────────────────────────────────────────
let ws        = null;
let retryMs   = 1000;
const MAX_RETRY = 30000;

function connect() {
  setConnStatus('connecting', 'Connecting…');

  const url = `ws://${location.host}/ws`;
  ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    retryMs = 1000;
    setConnStatus('connected', 'Connected');
  });

  ws.addEventListener('message', evt => {
    let data;
    try { data = JSON.parse(evt.data); } catch { return; }
    if (!data || !Array.isArray(data.devices)) return;

    // Update title
    if (data.title) document.getElementById('page-title').textContent = data.title;

    // Update period label
    if (data.period) {
      document.getElementById('period-label').textContent =
        `${data.period.duration} ${data.period.unit}`;
    }

    const devices = data.devices;

    // Build DOM once
    if (state.n !== devices.length) {
      buildDom(devices);
    }

    // Update each device
    devices.forEach((dev, i) => updateDevice(i, dev));
  });

  ws.addEventListener('close', () => {
    setConnStatus('disconnected', `Reconnecting in ${(retryMs / 1000).toFixed(0)}s…`);
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, MAX_RETRY);
  });

  ws.addEventListener('error', () => {
    ws.close();
  });
}

connect();
