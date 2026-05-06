'use strict';
// ── Server-Sent Events ───────────────────────────────────────────────────────
// EventSource auto-reconnects with browser-managed backoff — no manual retry
// loop needed.  All server→client data flows through one SSE pipe; the only
// REST traffic from this page is the interval-change POST (/api/interval).
let es = null;

function connectSSE() {
  if (es) { es.close(); es = null; }
  setConnStatus('connecting', 'Connecting…');
  es = new EventSource('/events');

  es.addEventListener('open', () => {
    setConnStatus('connected', 'Connected');
    appendLog('SSE connected', 'ok');
    setShutdownBadge(null);
  });

  es.addEventListener('error', () => {
    setConnStatus('disconnected', 'Reconnecting…');
    appendLog('SSE error — browser will retry', 'warn');
  });

  es.addEventListener('config', evt => {
    try { applyConfig(JSON.parse(evt.data)); } catch {}
  });

  es.addEventListener('limits', evt => {
    try { applyLimits(JSON.parse(evt.data)); } catch {}
  });

  es.addEventListener('cpu-ranks', evt => {
    try { applyCoreRanks(JSON.parse(evt.data)); } catch {}
  });

  es.addEventListener('system', evt => {
    try { renderSystemInfo(JSON.parse(evt.data)); } catch {}
  });

  es.addEventListener('mem', evt => {
    let data;
    try { data = JSON.parse(evt.data); } catch { return; }
    if (!state.systemInfo) state.systemInfo = {};
    state.systemInfo.meminfo_kb      = data.meminfo_kb;
    state.systemInfo.drm_mem         = data.drm_mem;
    state.systemInfo.dma_buf_bytes   = data.dma_buf_bytes;
    state.systemInfo.sock_mem_kb     = data.sock_mem_kb;
    state.systemInfo.gpu_anon_pss_kb = data.gpu_anon_pss_kb;
    state.systemInfo.dram_read_bps   = data.dram_read_bps;
    state.systemInfo.dram_write_bps  = data.dram_write_bps;
  });

  es.addEventListener('gpu', evt => {
    let data;
    try { data = JSON.parse(evt.data); } catch { return; }
    if (!Array.isArray(data.devices)) return;

    const _t = new Date();
    document.getElementById('period-label').textContent =
      _t.toLocaleTimeString([], { hour12: false }) + '.' + String(_t.getMilliseconds()).padStart(3, '0');

    state.lastDevices = data.devices;
    if (state.n !== data.devices.length) { buildDom(data.devices); }
    data.devices.forEach((dev, i) => updateDevice(i, dev));
  });

  es.addEventListener('proc', evt => {
    let data;
    try { data = JSON.parse(evt.data); } catch { return; }
    if (data.event !== 'start') return;
    const pidStr = String(data.pid);
    for (const h of state.hist) {
      if (!h.earlyStartedPids.has(pidStr)) {
        h.earlyStartedPids.add(pidStr);
        h.events.push({ timeMs: data.time_ms, type: 'start', name: data.name, pid: data.pid });
        h.eventsDirty = true;
      }
    }
    const cmdSuffix = data.cmdline ? ` — ${data.cmdline}` : '';
    appendLog(`Process start: ${data.name} (PID ${data.pid})${cmdSuffix} [early]`, 'ok');
  });

  es.addEventListener('alert', evt => {
    let data;
    try { data = JSON.parse(evt.data); } catch { return; }
    if (data.shutdown_pending) {
      const mode = data.shutdown_pending.split(' ')[0];
      if (state.lastShutdownMode !== mode) {
        state.lastShutdownMode = mode;
        appendLog('system: ' + data.shutdown_pending, 'err');
        setShutdownBadge(data.shutdown_pending);
      }
    }
  });
}
