// ── Plot maximize overlay ─────────────────────────────────────────────────────
function updateOverlayPosition() {
  const overlay = document.getElementById('plot-overlay');
  if (!overlay) return;
  const anchorEl = document.querySelector('.gpu-panel.active .fixed-stats')
                ?? document.querySelector('header');
  const topPx   = anchorEl ? anchorEl.getBoundingClientRect().bottom : 0;
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
  state.overlayChart._minMaxFmt  = src._minMaxFmt ?? null;
  state.overlayChart._showDramMax = src._showDramMax ?? true;

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
