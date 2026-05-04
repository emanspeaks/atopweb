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
    setShutdownBadge(null);
    fetchPowerLimits();
    fetchCoreRanks();
    fetchConfig();
  });

  ws.addEventListener('message', evt => {
    let data;
    try { data = JSON.parse(evt.data); } catch { return; }
    if (!data) return;

    // Fast-refresh memory snapshot (pushed at amdgpu_top cadence).
    if (data.type === 'mem') {
      if (!state.systemInfo) state.systemInfo = {};
      state.systemInfo.meminfo_kb      = data.meminfo_kb;
      state.systemInfo.drm_mem         = data.drm_mem;
      state.systemInfo.dma_buf_bytes   = data.dma_buf_bytes;
      state.systemInfo.sock_mem_kb     = data.sock_mem_kb;
      state.systemInfo.gpu_anon_pss_kb = data.gpu_anon_pss_kb;
      state.systemInfo.dram_read_bps   = data.dram_read_bps;
      state.systemInfo.dram_write_bps  = data.dram_write_bps;
      return;
    }

    // Server-pushed system info (fan, temp, power, RAM, uptime).
    if (data.type === 'system') { renderSystemInfo(data); return; }

    // Immediate shutdown/reboot alert pushed by the inotify watcher.
    if (data.type === 'system_alert') {
      if (data.shutdown_pending) {
        const mode = data.shutdown_pending.split(' ')[0];
        if (state.lastShutdownMode !== mode) {
          state.lastShutdownMode = mode;
          appendLog('system: ' + data.shutdown_pending, 'err');
          setShutdownBadge(data.shutdown_pending);
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
