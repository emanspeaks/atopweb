'use strict';
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

    // Two-phase render: first do all the layout-mutating writes (display
    // toggles, scale-range updates) so the browser reflows at most once;
    // then call chart.update() which reads canvas geometry. Without this
    // separation each chart.update reads layout after a previous iteration's
    // setDisplay, forcing a synchronous reflow every loop iteration.
    const toUpdate = [];
    for (const [key, c] of Object.entries(state.charts)) {
      const isCoreFreq = key.includes('-cpu-core-');
      const widthMs    = isCoreFreq ? state.coreTimeWidthMs : state.timeWidthMs;
      c.options.scales.x.min = now - widthMs;
      c.options.scales.x.max = now;
      const debounceMs  = widthMs * 0.1;
      const chartActive = (now - (state.chartLastData[key] || 0)) <= debounceMs;
      setDisplay(document.getElementById(`chart-box-${key}`), chartActive);
      if (!state.paused && !hasOverlay && chartActive &&
          (state.n <= 1 || parseInt(key, 10) === state.cur))
        toUpdate.push(c);
    }
    const cardDebounce = state.timeWidthMs * 0.1;
    for (const id in state.cardLastData) {
      // Permanent system cards are always visible regardless of data flow.
      if (id.startsWith('c-fan-') || id.startsWith('c-ppt-') || id.startsWith('c-uptime-')) continue;
      const active = (now - state.cardLastData[id]) <= cardDebounce;
      const el = document.getElementById(id);
      setDisplay(el?.closest('.card'), active);
    }
    // Refresh dataset.data and labels to current circular-buffer views.  The
    // subarray references go stale every push (head advances), so we re-take
    // them just before drawing.  `_buf` and `_labelBuf` were tagged when the
    // chart was constructed (build-charts.js / build-core-freq.js).
    for (const c of toUpdate) {
      if (c._labelBuf) c.data.labels = bufView(c._labelBuf);
      const dss = c.data.datasets;
      for (let k = 0; k < dss.length; k++) {
        const ds = dss[k];
        if (ds._buf) ds.data = bufView(ds._buf);
      }
      c.update('none');
    }
    if (hasOverlay && !state.paused) {
      const o = state.overlayChart;
      o.options.scales.x.min = now - state.overlayWidthMs;
      o.options.scales.x.max = now;
      if (o._labelBuf) o.data.labels = bufView(o._labelBuf);
      const dss = o.data.datasets;
      for (let k = 0; k < dss.length; k++) {
        const ds = dss[k];
        if (ds._buf) ds.data = bufView(ds._buf);
      }
      o.update('none');
    }
    if (state.memTreemapDev != null) {
      if (state.paused || _tmHovered) updateMemTreemapValues(state.memTreemapDev);
      else                            renderMemTreemap(state.memTreemapDev);
    }
  });
}
