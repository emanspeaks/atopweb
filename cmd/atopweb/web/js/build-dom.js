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
    const panel = buildDevicePanel(i, dev);
    main.appendChild(panel);
  });

  state.cur = 0;
  applyGttMarginVisibility();
  restoreCache();
}

function buildDevicePanel(i, dev) {
  const name = (dev.Info && (dev.Info.DeviceName || dev.Info['ASIC Name'])) || `GPU ${i}`;

  // Tab button
  const btn = el('button', 'tab-btn' + (i === 0 ? ' active' : ''), name);
  btn.dataset.idx = i;
  btn.addEventListener('click', () => switchTab(i));
  document.getElementById('tabs').appendChild(btn);

  // GPU panel
  const panel = el('div', 'gpu-panel' + (i === 0 ? ' active' : ''));
  panel.id = `panel-${i}`;

  // ── Fixed stats bar (sticky container: stat cards + memory bar) ──
  const fixedStats = el('div', 'fixed-stats');
  const cards = buildStatCards(i);
  const memSec = buildMemoryBar(i);
  memSec.querySelector('.mem-bar-outer').addEventListener('click', () => openMemTreemap(i));
  fixedStats.appendChild(cards);
  fixedStats.appendChild(memSec);
  panel.appendChild(fixedStats);

  const h = state.hist[i];

  // ── GRBM / GRBM2 performance counters ──
  const grbmSec = buildGRBMSection(i, h);
  panel.appendChild(grbmSec);

  // ── Charts ──
  const chartGrid = buildCharts(i, h);
  panel.appendChild(chartGrid);

  // ── Per-CPU-core frequency plots (2 rows × 8) ──
  const coreFreqGrid = buildCoreFreqGrid(i, h);
  panel.appendChild(coreFreqGrid);

  // ── Process table ──
  const procSec = buildProcessTable(i);
  panel.appendChild(procSec);

  return panel;
}
