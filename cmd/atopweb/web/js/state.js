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

// History buffers are circular: each channel is a 2N-sized typed array with a
// head pointer.  pushHistory writes at head and advances; the visible window is
// always buf.subarray(head - size, head).  When head reaches the end of the
// backing array we slide the last N values back to position 0 in a single
// copyWithin (one O(N) copy per N pushes) instead of shifting on every push
// (the previous Array-based approach was O(N) per push at 10 Hz).
function makeBuf(size) {
  return { buf: new Float32Array(2 * size).fill(NaN), head: size, size };
}
function makeBufN(rows, size) {
  return Array.from({ length: rows }, () => makeBuf(size));
}

function makeHist(size, coreSize) {
  const ms  = state.intervalMs;
  const now = Date.now();
  // Time axes use Float64 because epoch ms can't be stored exactly in Float32.
  // Pre-fill so the x-axis is valid before any sample arrives.
  const tBuf = (n) => {
    const b = { buf: new Float64Array(2 * n), head: n, size: n };
    for (let k = 0; k < n; k++) b.buf[k] = now - (n - 1 - k) * ms;
    return b;
  };
  return {
    times:     tBuf(size),
    coreTimes: tBuf(coreSize),
    gfx:      makeBuf(size),
    mem:      makeBuf(size),
    media:    makeBuf(size),
    vram:     makeBuf(size),
    vramOnly: makeBuf(size),
    gttOnly:  makeBuf(size),
    pwr:      makeBuf(size),
    fan:      makeBuf(size),
    ppt:      makeBuf(size),
    cpuPwr:   makeBuf(size),
    npuPwr:   makeBuf(size),
    tempE:    makeBuf(size),
    tempC:    makeBuf(size),
    tempS:    makeBuf(size),
    tempGfx:  makeBuf(size),
    tempHot:  makeBuf(size),
    tempMem:  makeBuf(size),
    sclk:     makeBuf(size),
    mclk:     makeBuf(size),
    fclk:     makeBuf(size),
    fclkAvg:  makeBuf(size),
    socClk:   makeBuf(size),
    vclk:     makeBuf(size),
    vddgfx:   makeBuf(size),
    vddnb:    makeBuf(size),
    dramReads:  makeBuf(size),
    dramWrites: makeBuf(size),
    npuBusy:   makeBufN(8,  size),
    npuClk:    makeBuf(size),
    npuMpClk:  makeBuf(size),
    npuReads:  makeBuf(size),
    npuWrites: makeBuf(size),
    grbm:          makeBufN(GRBM_KEYS.length,  size),
    grbm2:         makeBufN(GRBM2_KEYS.length, size),
    corePwr:       makeBufN(16, size),     // CPU core power — global chart
    coreClk:       makeBufN(16, coreSize), // CPU core SMU clocks — per-core charts
    cpuScalingClk: makeBufN(16, coreSize), // CPU core cpufreq scaling — per-core charts
    vramMax:       1,
    events:           [],         // [{timeMs, type:'start'|'stop', name, pid}]
    prevProcNames:    new Map(),  // pid → name, previous tick
    earlyStartedPids: new Set(),  // pids emitted via server proc_event; skip fdinfo re-emit
  };
}
