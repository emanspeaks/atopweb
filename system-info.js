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
  if (!state.systemInfo) state.systemInfo = {};
  Object.assign(state.systemInfo, sys);

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
      setShutdownBadge(sys.shutdown_pending);
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
