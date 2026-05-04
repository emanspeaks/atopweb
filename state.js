// ── State ────────────────────────────────────────────────────────────────────
const state = {
  cur:             -1,
  n:                0,
  hist:            [],
  charts:          {},
  powerLimits:     { stapm_w: null, fast_w: null, slow_w: null, apu_slow_w: null, thm_core_c: null, thm_gfx_c: null, thm_soc_c: null },
  totalRAMMiB:     null,
  systemInfo:      null,
  lastPPT:         { value: null, receivedAt: 0 },  // W; reused on each GPU tick
  lastFan:         { value: null, receivedAt: 0 },  // RPM; reused on each GPU tick
  seenFanSensor:   false,  // latched true when any fan sensor has been observed
  lastCPU:         { value: null, receivedAt: 0 },  // %; reused on each GPU tick
  coreRanks:       [],
  lastDev0:        null,
  lastDevices:     null,
  intervalMs:      1000,
  timeWidthMs:     120_000,
  coreTimeWidthMs: 60_000,
  paused:          false,
  overlayChart:    null,
  overlayChartKey: null,
  overlayWidthMs:  0,
  chartLastData:   {},   // chartKey → ms timestamp of last tick with any finite data
  cardLastData:    {},   // cardId   → ms timestamp of last tick with any finite value
  serverVersion:   null, // atopweb version string as reported by /api/config on first load
  lastConfig:      null, // last seen /api/config snapshot for change detection
  dramMaxBWKiBs:   0,    // theoretical DRAM bandwidth ceiling in KiB/s (from dmidecode via /api/config)
  showGttMargin:   false,
  memTreemapDev:   null, // device index whose treemap is currently open, or null
};

// History size = time window / update interval, so the x-axis always shows a
// fixed duration regardless of how fast samples arrive.
function getHistorySize()     { return Math.max(2, Math.ceil(state.timeWidthMs     / state.intervalMs)); }
function getCoreHistorySize() { return Math.max(2, Math.ceil(state.coreTimeWidthMs / state.intervalMs)); }
// x-axis tick count: one tick per 5 s, plus 1 for the fencepost.
// Pick the smallest "nice" step size (in ms) that yields ≤ 24 grid lines.
function xStepSize(widthMs) {
  const steps = [5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 1800000, 3600000];
  const target = widthMs / 24;
  return steps.find(s => s >= target) ?? steps[steps.length - 1];
}

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
    fan:      a(size),
    ppt:      a(size),
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
    events:           [],         // [{timeMs, type:'start'|'stop', name, pid}]
    prevProcNames:    new Map(),  // pid → name, previous tick
    earlyStartedPids: new Set(),  // pids emitted via server proc_event; skip fdinfo re-emit
  };
}
