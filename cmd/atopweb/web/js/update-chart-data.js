// ── History + Chart rendering (called from updateDevice) ─────────────────────

function pushChartHistory(i, dev) {
  const h = state.hist[i];
  const act = dev.gpu_activity || {};
  const sens = dev.Sensors || {};
  const gm = dev.gpu_metrics || {};
  const nm = dev.npu_metrics || {};
  const nowMs = Date.now();

  // If the gap since the last sample exceeds 3 sample intervals, inject NaN so
  // Chart.js breaks the line instead of connecting across the discontinuity.
  // This catches WebSocket reconnects after reboots/pauses without a page reload.
  const idleMs = 5 * state.intervalMs;
  if (nowMs - h.times[h.times.length - 1] > idleMs)
    shiftHistGap(h, Math.round((nowMs - h.times[h.times.length - 1]) / state.intervalMs), state.intervalMs);

  pushHistory(h.times,     nowMs);
  pushHistory(h.coreTimes, nowMs);
  pushHistory(h.gfx,   v(act, 'GFX'));
  pushHistory(h.mem,   v(act, 'Memory'));
  pushHistory(h.media, v(act, 'MediaEngine'));

  const vramU = v(dev.VRAM, 'Total VRAM Usage');
  const gttU = v(dev.VRAM, 'Total GTT Usage');
  const vramT = v(dev.VRAM, 'Total VRAM');
  const gttT = v(dev.VRAM, 'Total GTT');
  const combinedU = (vramU != null && gttU != null) ? vramU + gttU : (vramU ?? gttU);
  pushHistory(h.vram,    combinedU != null ? combinedU / 1024 : null);
  pushHistory(h.vramOnly, vramU   != null ? vramU    / 1024 : null);
  pushHistory(h.gttOnly,  gttU    != null ? gttU     / 1024 : null);

  const pwr = v(sens, 'Average Power') ?? v(sens, 'Socket Power') ?? v(sens, 'Input Power') ?? v(sens, 'GFX Power');
  pushHistory(h.pwr,    pwr);
  const pptFresh = state.lastPPT.value != null && (nowMs - state.lastPPT.receivedAt) < 3000;
  pushHistory(h.ppt,    pptFresh ? state.lastPPT.value : null);
  const fanFresh = state.lastFan.value != null && (nowMs - state.lastFan.receivedAt) < 3000;
  pushHistory(h.fan,    fanFresh ? state.lastFan.value : null);

  const cpuPwrAllMW = typeof gm.average_all_core_power === 'number' ? gm.average_all_core_power : null;
  const npuPwrMW    = typeof gm.average_ipu_power     === 'number' ? gm.average_ipu_power     : null;
  pushHistory(h.cpuPwr, cpuPwrAllMW != null ? cpuPwrAllMW / 1000 : null);
  pushHistory(h.npuPwr, npuPwrMW    != null ? npuPwrMW    / 1000 : null);

  pushHistory(h.tempE,  v(sens, 'Edge Temperature'));
  pushHistory(h.tempC,  v(sens, 'CPU Tctl'));
  pushHistory(h.tempS,  (gm.temperature_soc ?? null) != null ? gm.temperature_soc / 100 : null);
  pushHistory(h.tempGfx, (gm.temperature_gfx ?? null) != null ? gm.temperature_gfx / 100 : null);
  pushHistory(h.tempHot, (gm.temperature_hotspot ?? null) != null ? gm.temperature_hotspot / 100 : null);
  pushHistory(h.tempMem, (gm.temperature_mem ?? null) != null ? gm.temperature_mem / 100 : null);
  pushHistory(h.sclk,   v(sens, 'GFX_SCLK'));
  pushHistory(h.mclk,   v(sens, 'GFX_MCLK'));
  pushHistory(h.fclk,   v(sens, 'FCLK'));
  pushHistory(h.fclkAvg, typeof gm.average_fclk_frequency  === 'number' ? gm.average_fclk_frequency  : null);
  pushHistory(h.socClk,  typeof gm.average_socclk_frequency === 'number' ? gm.average_socclk_frequency : null);
  pushHistory(h.vclk,    typeof gm.average_vclk_frequency  === 'number' ? gm.average_vclk_frequency  : null);
  pushHistory(h.vddgfx,  v(sens, 'VDDGFX') || null);
  pushHistory(h.vddnb,   v(sens, 'VDDNB')  || null);

  const dramReadBps  = state.systemInfo?.dram_read_bps;
  const dramWriteBps = state.systemInfo?.dram_write_bps;
  pushHistory(h.dramReads,  typeof dramReadBps  === 'number' ? dramReadBps  / 1024 : null);
  pushHistory(h.dramWrites, typeof dramWriteBps === 'number' ? dramWriteBps / 1024 : null);

  const npuBusyArr = Array.isArray(nm.npu_busy) ? nm.npu_busy : [];
  for (let j = 0; j < 8; j++) {
    const bv = npuBusyArr[j];
    pushHistory(h.npuBusy[j], (bv != null && bv < 65535) ? bv : null);
  }
  pushHistory(h.npuClk,   typeof nm.npuclk_freq   === 'number' ? nm.npuclk_freq   : null);
  pushHistory(h.npuMpClk, typeof nm.mpnpuclk_freq === 'number' ? nm.mpnpuclk_freq : null);
  pushHistory(h.npuReads,  typeof nm.npu_reads  === 'number' ? nm.npu_reads  : null);
  pushHistory(h.npuWrites, typeof nm.npu_writes === 'number' ? nm.npu_writes : null);

  const sensFreqs  = Array.isArray(sens['CPU Core freq']) ? sens['CPU Core freq'] : [];
  const avgCorePwr = Array.isArray(gm.average_core_power) ? gm.average_core_power : [];
  const curCoreClk = Array.isArray(gm.current_coreclk)   ? gm.current_coreclk   : [];
  for (let j = 0; j < 16; j++) {
    const pwrMW      = (avgCorePwr[j] != null && avgCorePwr[j] < 65535) ? avgCorePwr[j] : null;
    const clkMHz     = (curCoreClk[j] != null && curCoreClk[j] < 65535) ? curCoreClk[j] : null;
    const scalingMHz = sensFreqs[j]?.cur_freq ?? null;
    pushHistory(h.corePwr[j],       pwrMW != null ? pwrMW / 1000 : null);
    pushHistory(h.coreClk[j],       clkMHz);
    pushHistory(h.cpuScalingClk[j], scalingMHz);
  }

  const combinedT = (vramT != null && gttT != null) ? vramT + gttT : (vramT ?? gttT);
  if (combinedT != null && combinedT > 0) h.vramMax = combinedT / 1024;
}

function updateChartAnnotations(i) {
  const h = state.hist[i];
  const cAct     = state.charts[`${i}-activity`];
  const cVram    = state.charts[`${i}-vram`];
  const cPwr     = state.charts[`${i}-power`];
  const cFan     = state.charts[`${i}-fan`];
  const cTemp    = state.charts[`${i}-temp`];
  const cGfxClk  = state.charts[`${i}-gfx-clk`];
  const cCorePwr = state.charts[`${i}-core-pwr`];
  const cVoltage = state.charts[`${i}-voltage`];
  const cDramBw  = state.charts[`${i}-dram-bw`];
  const cNpuAct  = state.charts[`${i}-npu-act`];
  const cNpuClk  = state.charts[`${i}-npu-clk`];
  const cNpuBw   = state.charts[`${i}-npu-bw`];

  if (cVram) cVram._yCeilingHint = h.vramMax;

  if (cAct)     setAnnotations(cAct,    h.times, {},                          h.gfx, h.mem, h.media);
  if (cVram)    setAnnotations(cVram,   h.times, memoryLimitAnnotations(h),   h.vram, h.vramOnly, h.gttOnly);
  if (cPwr)     setAnnotations(cPwr,    h.times, powerLimitAnnotations(),     h.pwr, h.ppt, h.cpuPwr, h.npuPwr);
  if (cFan)     setAnnotations(cFan,    h.times, {},                          h.fan);
  if (cTemp)    setAnnotations(cTemp,   h.times, temperatureLimitAnnotations(), h.tempE, h.tempC, h.tempS, h.tempGfx, h.tempHot, h.tempMem);
  if (cGfxClk)  setAnnotations(cGfxClk, h.times, {},                         h.sclk, h.mclk, h.fclk, h.fclkAvg, h.socClk, h.vclk);
  if (cVoltage) setAnnotations(cVoltage, h.times, {},                         h.vddgfx, h.vddnb);
  if (cCorePwr) setAnnotations(cCorePwr, h.times, {},                         ...h.corePwr);
  if (cDramBw)  setAnnotations(cDramBw,  h.times, dramBWLimitAnnotation(cDramBw), h.dramReads, h.dramWrites);
  if (cNpuAct)  setAnnotations(cNpuAct,  h.times, {},                         ...h.npuBusy);
  if (cNpuClk)  setAnnotations(cNpuClk,  h.times, {},                         h.npuClk, h.npuMpClk);
  if (cNpuBw)   setAnnotations(cNpuBw,   h.times, {},                         h.npuReads, h.npuWrites);

  if (state.overlayChart && state.overlayChartKey) {
    const oc  = state.overlayChartKey;
    const ovl = state.overlayChart;
    if      (oc === `${i}-activity`) setAnnotations(ovl, h.times, {},                             h.gfx, h.mem, h.media);
    else if (oc === `${i}-vram`)   { ovl._yCeilingHint = h.vramMax;
                                     setAnnotations(ovl, h.times, memoryLimitAnnotations(h),      h.vram, h.vramOnly, h.gttOnly); }
    else if (oc === `${i}-power`)    setAnnotations(ovl, h.times, powerLimitAnnotations(),        h.pwr, h.ppt, h.cpuPwr, h.npuPwr);
    else if (oc === `${i}-fan`)      setAnnotations(ovl, h.times, {},                             h.fan);
    else if (oc === `${i}-temp`)     setAnnotations(ovl, h.times, temperatureLimitAnnotations(),  h.tempE, h.tempC, h.tempS, h.tempGfx, h.tempHot, h.tempMem);
    else if (oc === `${i}-gfx-clk`) setAnnotations(ovl, h.times, {},                             h.sclk, h.mclk, h.fclk, h.fclkAvg, h.socClk, h.vclk);
    else if (oc === `${i}-voltage`) setAnnotations(ovl, h.times, {},                             h.vddgfx, h.vddnb);
    else if (oc === `${i}-core-pwr`) setAnnotations(ovl, h.times, {},                            ...h.corePwr);
    else if (oc === `${i}-dram-bw`)  setAnnotations(ovl, h.times, dramBWLimitAnnotation(ovl),    h.dramReads, h.dramWrites);
    else if (oc === `${i}-npu-act`)  setAnnotations(ovl, h.times, {},                            ...h.npuBusy);
    else if (oc === `${i}-npu-clk`)  setAnnotations(ovl, h.times, {},                            h.npuClk, h.npuMpClk);
    else if (oc === `${i}-npu-bw`)   setAnnotations(ovl, h.times, {},                            h.npuReads, h.npuWrites);
  }

  // Mark which charts received finite data this tick
  const devPrefix = `${i}-`;
  const nowMs = Date.now();
  for (const [key, chart] of Object.entries(state.charts)) {
    if (!key.startsWith(devPrefix)) continue;
    const hasData = chart.config.data.datasets.some(
      ds => ds.data?.length && Number.isFinite(ds.data[ds.data.length - 1])
    );
    if (hasData) state.chartLastData[key] = nowMs;
  }

  scheduleRender();
}
