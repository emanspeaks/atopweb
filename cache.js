// ── History cache (localStorage) ─────────────────────────────────────────────
// Binary Float32 + base64 keeps each array ~640 chars (120 pts × 4 B × 4/3).
// Periodic saves avoid per-sample overhead; beforeunload catches tab closes.
const CACHE_KEY     = 'atopweb-hist-v1';
const CACHE_SAVE_MS = 5_000;

function _encF32(arr) {
  const f32 = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) f32[i] = arr[i];
  const u8 = new Uint8Array(f32.buffer);
  let s = '';
  for (let i = 0; i < u8.length; i += 8192)
    s += String.fromCharCode(...u8.subarray(i, Math.min(i + 8192, u8.length)));
  return btoa(s);
}

function _decF32(b64, target) {
  const bin = atob(b64);
  const u8  = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const src = new Float32Array(u8.buffer);
  const len = Math.min(src.length, target.length);
  for (let i = 0; i < len; i++) target[i] = src[i]; // NaN propagates correctly
}

function encodeHist(h) {
  const e1 = a => _encF32(a);
  const e2 = as => as.map(e1);
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

// Shift every data array in h left by `g` samples and fill the vacated tail
// with NaN, then advance the time axes by the same amount.  This injects a
// break that Chart.js (spanGaps:false by default) will render as a gap rather
// than a false connecting line.
function shiftHistGap(h, g, ms) {
  const n  = h.times.length;
  const cn = h.coreTimes.length;
  const g1 = Math.min(Math.max(0, g), n);
  const g2 = Math.min(g1, cn);
  if (g1 === 0) return;
  const sft = (a, gap) => { a.copyWithin(0, gap); a.fill(NaN, a.length - gap); };
  sft(h.gfx, g1); sft(h.mem, g1); sft(h.media, g1);
  sft(h.vram, g1); sft(h.vramOnly, g1); sft(h.gttOnly, g1);
  sft(h.pwr, g1); sft(h.fan, g1); sft(h.ppt, g1);
  sft(h.cpuPwr, g1); sft(h.npuPwr, g1);
  sft(h.tempE, g1); sft(h.tempC, g1); sft(h.tempS, g1);
  sft(h.tempGfx, g1); sft(h.tempHot, g1); sft(h.tempMem, g1);
  sft(h.sclk, g1); sft(h.mclk, g1); sft(h.fclk, g1);
  sft(h.fclkAvg, g1); sft(h.socClk, g1); sft(h.vclk, g1);
  sft(h.vddgfx, g1); sft(h.vddnb, g1);
  sft(h.dramReads, g1); sft(h.dramWrites, g1);
  sft(h.npuClk, g1); sft(h.npuMpClk, g1);
  sft(h.npuReads, g1); sft(h.npuWrites, g1);
  h.npuBusy.forEach(a => sft(a, g1));
  h.corePwr.forEach(a => sft(a, g1));
  h.grbm.forEach(a => sft(a, g1));
  h.grbm2.forEach(a => sft(a, g1));
  h.coreClk.forEach(a => sft(a, g2));
  h.cpuScalingClk.forEach(a => sft(a, g2));
  for (let k = 0; k < n;  k++) h.times[k]    += g1 * ms;
  for (let k = 0; k < cn; k++) h.coreTimes[k] += g2 * ms;
}

function decodeHist(c, h, ts, ms) {
  const d1 = (b, a) => { if (b && a) _decF32(b, a); };
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

  // Reconstruct time axes from cached end-timestamp.
  const n  = h.times.length;
  const cn = h.coreTimes.length;
  for (let k = 0; k < n;  k++) h.times[k]    = ts - (n  - 1 - k) * ms;
  for (let k = 0; k < cn; k++) h.coreTimes[k] = ts - (cn - 1 - k) * ms;

  // Shift by however many samples elapsed while the page was away so the tail
  // fills with NaN and Chart.js naturally breaks the line at the boundary.
  shiftHistGap(h, Math.round((Date.now() - ts) / ms), ms);
}

function saveCache() {
  if (!state.hist.length) return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      v: 1, ts: Date.now(),
      intervalMs:   state.intervalMs,
      histSize:     getHistorySize(),
      coreHistSize: getCoreHistorySize(),
      devices:      state.hist.map(encodeHist),
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
