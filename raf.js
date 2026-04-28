// ── RAF render loop ──────────────────────────────────────────────────────────
// Chart.js defers actual canvas drawing to requestAnimationFrame even with
// animation:false, so calling update() directly in the WebSocket handler can
// only render at 1 Hz when the browser coalesces those calls. Instead we mark
// charts dirty and flush once per animation frame — this ties visual updates
// to the display refresh rate (60 fps) while still consuming every data point.
let _rafPending = false;
function scheduleRender() {
  const hasOverlay  = !!state.overlayChart;
  const hasTreemap  = state.memTreemapDev != null;
  if (state.paused && !hasOverlay && !hasTreemap) return;
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
    if (state.memTreemapDev != null) {
      if (state.paused || _tmHovered) updateMemTreemapValues(state.memTreemapDev);
      else                            renderMemTreemap(state.memTreemapDev);
    }
  });
}
