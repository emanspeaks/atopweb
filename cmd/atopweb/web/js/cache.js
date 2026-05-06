'use strict';
// ── History cache (localStorage) ─────────────────────────────────────────────
// Binary Float32 + base64 keeps each array ~640 chars (120 pts × 4 B × 4/3).
// Periodic saves avoid per-sample overhead; beforeunload catches tab closes.
const CACHE_KEY     = 'atopweb-hist-v1';
// Saving the cache base64-encodes ~84k Float32 values and writes them to
// localStorage synchronously.
// beforeunload still fires a final save when the tab is closed.
const CACHE_SAVE_MS = 5_000;

// Encode a circular buffer's linearized window as base64.  Float32 only — the
// time axis is reconstructed from `ts`+`ms` on decode and never serialized.
function _encBuf(b) {
  const view = b.buf.subarray(b.head - b.size, b.head);
  const u8   = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let s = '';
  for (let i = 0; i < u8.length; i += 8192)
    s += String.fromCharCode(...u8.subarray(i, Math.min(i + 8192, u8.length)));
  return btoa(s);
}

// Decode `b64` (Float32 base64) into the start of `b.buf`, then reset head so
// the linearized view = the decoded values.  NaN bits propagate through u8.
function _decBuf(b64, b) {
  const bin = atob(b64);
  const u8  = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const src = new Float32Array(u8.buffer);
  const len = Math.min(src.length, b.size);
  b.buf.set(len === src.length ? src : src.subarray(0, len), 0);
  if (len < b.size) b.buf.fill(NaN, len, b.size);
  b.head = b.size;
}

function encodeHist(h) {
  const e1 = b => _encBuf(b);
  const e2 = bs => bs.map(e1);
  return {
    gfx: e1(h.gfx), mem: e1(h.mem), media: e1(h.media),
    vram: e1(h.vram), vramOnly: e1(h.vramOnly), gttOnly: e1(h.gttOnly),
    pwr: e1(h.pwr), fan: e1(h.fan), ppt: e1(h.ppt),
    cpuPwr: e1(h.cpuPwr), npuPwr: e1(h.npuPwr),
    tempE: e1(h.tempE), tempC: e1(h.tempC), tempS: e1(h.tempS),
    tempGfx: e1(h.tempGfx), tempHot: e1(h.tempHot), tempMem: e1(h.tempMem),
    sclk: e1(h.sclk), mclk: e1(h.mclk), fclk: e1(h.fclk),
    fclkAvg: e1(h.fclkAvg), socClk: e1(h.socClk), vclk: e1(h.vclk),
    vddgfx: e1(h.vddgfx), vddnb: e1(h.vddnb),
    dramReads: e1(h.dramReads), dramWrites: e1(h.dramWrites),
    npuClk: e1(h.npuClk), npuMpClk: e1(h.npuMpClk),
    npuReads: e1(h.npuReads), npuWrites: e1(h.npuWrites),
    npuBusy: e2(h.npuBusy), corePwr: e2(h.corePwr),
    coreClk: e2(h.coreClk), cpuScalingClk: e2(h.cpuScalingClk),
    grbm: e2(h.grbm), grbm2: e2(h.grbm2),
  };
}

// Inject a break of `g` samples in every channel: advances each buffer's head
// past `g` NaN values so the Chart.js line breaks rather than connecting
// across the gap.  Used after long pauses (tab backgrounded, WS reconnect).
function shiftHistGap(h, g, ms) {
  if (g <= 0) return;
  const g1 = Math.min(g, h.times.size);
  const g2 = Math.min(g, h.coreTimes.size);
  // Advance the time axes with synthesized timestamps so the x-scale stays
  // monotonic across the gap.
  let lastT = bufLast(h.times);
  for (let k = 1; k <= g1; k++) pushHistory(h.times, lastT + k * ms);
  let lastCT = bufLast(h.coreTimes);
  for (let k = 1; k <= g2; k++) pushHistory(h.coreTimes, lastCT + k * ms);
  const naAll = (b) => { for (let k = 0; k < g1; k++) pushHistory(b, NaN); };
  const naCore = (b) => { for (let k = 0; k < g2; k++) pushHistory(b, NaN); };
  naAll(h.gfx);    naAll(h.mem);     naAll(h.media);
  naAll(h.vram);   naAll(h.vramOnly); naAll(h.gttOnly);
  naAll(h.pwr);    naAll(h.fan);     naAll(h.ppt);
  naAll(h.cpuPwr); naAll(h.npuPwr);
  naAll(h.tempE);  naAll(h.tempC);   naAll(h.tempS);
  naAll(h.tempGfx); naAll(h.tempHot); naAll(h.tempMem);
  naAll(h.sclk);   naAll(h.mclk);    naAll(h.fclk);
  naAll(h.fclkAvg); naAll(h.socClk); naAll(h.vclk);
  naAll(h.vddgfx); naAll(h.vddnb);
  naAll(h.dramReads); naAll(h.dramWrites);
  naAll(h.npuClk); naAll(h.npuMpClk); naAll(h.npuReads); naAll(h.npuWrites);
  h.npuBusy.forEach(naAll);
  h.corePwr.forEach(naAll);
  h.grbm.forEach(naAll);
  h.grbm2.forEach(naAll);
  h.coreClk.forEach(naCore);
  h.cpuScalingClk.forEach(naCore);
}

function decodeHist(c, h, ts, ms) {
  const d1 = (b64, b) => { if (b64 && b) _decBuf(b64, b); };
  const d2 = (bs, as) => { if (bs && as) bs.forEach((b, j) => d1(b, as[j])); };
  d1(c.gfx, h.gfx); d1(c.mem, h.mem); d1(c.media, h.media);
  d1(c.vram, h.vram); d1(c.vramOnly, h.vramOnly); d1(c.gttOnly, h.gttOnly);
  d1(c.pwr, h.pwr); d1(c.fan, h.fan); d1(c.ppt, h.ppt);
  d1(c.cpuPwr, h.cpuPwr); d1(c.npuPwr, h.npuPwr);
  d1(c.tempE, h.tempE); d1(c.tempC, h.tempC); d1(c.tempS, h.tempS);
  d1(c.tempGfx, h.tempGfx); d1(c.tempHot, h.tempHot); d1(c.tempMem, h.tempMem);
  d1(c.sclk, h.sclk); d1(c.mclk, h.mclk); d1(c.fclk, h.fclk);
  d1(c.fclkAvg, h.fclkAvg); d1(c.socClk, h.socClk); d1(c.vclk, h.vclk);
  d1(c.vddgfx, h.vddgfx); d1(c.vddnb, h.vddnb);
  d1(c.dramReads, h.dramReads); d1(c.dramWrites, h.dramWrites);
  d1(c.npuClk, h.npuClk); d1(c.npuMpClk, h.npuMpClk);
  d1(c.npuReads, h.npuReads); d1(c.npuWrites, h.npuWrites);
  d2(c.npuBusy, h.npuBusy); d2(c.corePwr, h.corePwr);
  d2(c.coreClk, h.coreClk); d2(c.cpuScalingClk, h.cpuScalingClk);
  d2(c.grbm, h.grbm); d2(c.grbm2, h.grbm2);

  // Reconstruct time axes from cached end-timestamp into the buffer's primary
  // window so the view is [oldest, ..., newest=ts].
  const n  = h.times.size;
  const cn = h.coreTimes.size;
  for (let k = 0; k < n;  k++) h.times.buf[k]     = ts - (n  - 1 - k) * ms;
  for (let k = 0; k < cn; k++) h.coreTimes.buf[k] = ts - (cn - 1 - k) * ms;
  h.times.head     = n;
  h.coreTimes.head = cn;

  // Shift by however many samples elapsed while the page was away so the tail
  // fills with NaN and Chart.js naturally breaks the line at the boundary.
  shiftHistGap(h, Math.round((Date.now() - ts) / ms), ms);
}

// ── Cache encode worker ──────────────────────────────────────────────────────
// Encoding ~84k Float32 values to base64 + JSON.stringify is the heaviest
// per-tick work in the page (~50–100 ms on the main thread at 5 s cadence).
// We move it off-thread to a Web Worker so the only main-thread cost per save
// is (a) collecting subarray views — cheap, no copy — and (b) the eventual
// localStorage.setItem of the worker's pre-built JSON string (a few ms for
// ~450 KB).  Worker is loaded via Blob URL so we don't need a separate route.
const _cacheWorkerSrc = `
  const _enc = (view) => {
    const u8 = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    let s = '';
    for (let i = 0; i < u8.length; i += 8192)
      s += String.fromCharCode(...u8.subarray(i, Math.min(i + 8192, u8.length)));
    return btoa(s);
  };
  const encDev = (d) => {
    const out = {};
    for (const k in d) {
      const v = d[k];
      if (ArrayBuffer.isView(v)) out[k] = _enc(v);
      else if (Array.isArray(v) && v.length && ArrayBuffer.isView(v[0])) out[k] = v.map(_enc);
    }
    return out;
  };
  self.onmessage = (e) => {
    const { header, devices } = e.data;
    self.postMessage(JSON.stringify({ ...header, devices: devices.map(encDev) }));
  };
`;

let _cacheWorker = null;
function _ensureCacheWorker() {
  if (_cacheWorker) return _cacheWorker;
  try {
    const blob = new Blob([_cacheWorkerSrc], { type: 'application/javascript' });
    _cacheWorker = new Worker(URL.createObjectURL(blob));
    _cacheWorker.onmessage = (e) => {
      // localStorage.setItem is synchronous and can block the main thread for
      // 50–100 ms on large payloads.  Defer to an idle period so chart updates
      // and WebSocket message processing are not interrupted.  The timeout
      // ensures the write completes well before the next 5-second save cycle.
      const json = e.data;
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(() => {
          try { localStorage.setItem(CACHE_KEY, json); }
          catch { /* quota exceeded or storage unavailable */ }
        }, { timeout: 4500 });
      } else {
        try { localStorage.setItem(CACHE_KEY, json); }
        catch { /* quota exceeded or storage unavailable */ }
      }
    };
    _cacheWorker.onerror = () => { _cacheWorker = null; }; // fall back to inline encode
  } catch { _cacheWorker = null; }
  return _cacheWorker;
}

// Build a worker-safe snapshot of the history: subarray views over the
// circular buffers' current windows.  Structured-cloning these views copies
// only the bytes covered (~336 KB total, ~1 ms) — much cheaper than the
// previous synchronous encode.
function _snapshotHist(h) {
  const v = b => bufView(b);
  return {
    gfx: v(h.gfx), mem: v(h.mem), media: v(h.media),
    vram: v(h.vram), vramOnly: v(h.vramOnly), gttOnly: v(h.gttOnly),
    pwr: v(h.pwr), fan: v(h.fan), ppt: v(h.ppt),
    cpuPwr: v(h.cpuPwr), npuPwr: v(h.npuPwr),
    tempE: v(h.tempE), tempC: v(h.tempC), tempS: v(h.tempS),
    tempGfx: v(h.tempGfx), tempHot: v(h.tempHot), tempMem: v(h.tempMem),
    sclk: v(h.sclk), mclk: v(h.mclk), fclk: v(h.fclk),
    fclkAvg: v(h.fclkAvg), socClk: v(h.socClk), vclk: v(h.vclk),
    vddgfx: v(h.vddgfx), vddnb: v(h.vddnb),
    dramReads: v(h.dramReads), dramWrites: v(h.dramWrites),
    npuClk: v(h.npuClk), npuMpClk: v(h.npuMpClk),
    npuReads: v(h.npuReads), npuWrites: v(h.npuWrites),
    npuBusy: h.npuBusy.map(v),
    corePwr: h.corePwr.map(v),
    coreClk: h.coreClk.map(v),
    cpuScalingClk: h.cpuScalingClk.map(v),
    grbm: h.grbm.map(v),
    grbm2: h.grbm2.map(v),
  };
}

function saveCache() {
  if (!state.hist.length) return;
  const header = {
    v: 1, ts: Date.now(),
    intervalMs:   state.intervalMs,
    histSize:     getHistorySize(),
    coreHistSize: getCoreHistorySize(),
  };
  const devices = state.hist.map(_snapshotHist);
  const w = _ensureCacheWorker();
  if (w) {
    w.postMessage({ header, devices });
    return;
  }
  // Fallback: encode + write inline if Worker isn't available.
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      ...header,
      devices: state.hist.map(encodeHist),
    }));
  } catch { /* quota exceeded or storage unavailable */ }
}

function restoreCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (p.v !== 1) return;
    if (Date.now() - p.ts > state.timeWidthMs) return;        // cache older than plot window
    if (p.intervalMs   !== state.intervalMs)   return;        // sample rate changed
    if (p.histSize     !== getHistorySize())    return;        // window size changed
    if (p.coreHistSize !== getCoreHistorySize()) return;
    if (p.devices.length !== state.hist.length) return;       // device count changed
    p.devices.forEach((c, i) => decodeHist(c, state.hist[i], p.ts, p.intervalMs));
    for (const chart of Object.values(state.charts)) chart.update('none');
  } catch { /* corrupt or incompatible cache — ignore */ }
}
