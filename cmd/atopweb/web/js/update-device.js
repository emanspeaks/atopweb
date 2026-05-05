function updateDevice(i, dev) {
  if (i === 0) { state.lastDev0 = dev; updateDeviceInfoHeader(dev); }
  const h     = state.hist[i];
  const act   = dev.gpu_activity || {};
  const vram  = dev.VRAM         || {};
  const sens  = dev.Sensors      || {};
  const gm = dev.gpu_metrics || {};

  // ── Read values ──
  const gfx    = v(act,  'GFX');
  const mem    = v(act,  'Memory');
  const media  = v(act,  'MediaEngine');
  const vramU  = v(vram, 'Total VRAM Usage');
  const vramT  = v(vram, 'Total VRAM');
  const gttU   = v(vram, 'Total GTT Usage');
  const gttT   = v(vram, 'Total GTT');
  const sclk   = v(sens, 'GFX_SCLK');
  const mclk   = v(sens, 'GFX_MCLK');
  const fclk   = typeof gm.average_fclk_frequency === 'number' ? gm.average_fclk_frequency : null;
  const gfxPwr = v(sens, 'GFX Power');
  const pwr    = v(sens, 'Average Power') ?? v(sens, 'Socket Power') ?? v(sens, 'Input Power') ?? gfxPwr;
  const tempE  = v(sens, 'Edge Temperature');
  const cputmp = v(sens, 'CPU Tctl');
  const vddgfx = v(sens, 'VDDGFX') || null;
  const vddnb  = v(sens, 'VDDNB')  || null;
  const tempSRaw   = gm.temperature_soc     ?? null;
  const tempS      = tempSRaw   != null ? tempSRaw   / 100 : null;
  const tempGfxRaw = gm.temperature_gfx     ?? null;
  const tempGfx    = tempGfxRaw != null ? tempGfxRaw / 100 : null;
  const tempHotRaw = gm.temperature_hotspot ?? null;
  const tempHot    = tempHotRaw != null ? tempHotRaw / 100 : null;
  const tempMemRaw = gm.temperature_mem     ?? null;
  const tempMem    = tempMemRaw != null ? tempMemRaw / 100 : null;

  const combinedU = (vramU != null && gttU != null) ? vramU + gttU
                  : (vramU ?? gttU);
  const combinedT = (vramT != null && gttT != null) ? vramT + gttT
                  : (vramT ?? gttT);

  // ── Stat cards ──
  setCard(`c-gfx-${i}`,    gfx);
  setCard(`c-media-${i}`,  media);
  setCard(`c-sclk-${i}`,   sclk);
  setCard(`c-mclk-${i}`,   mclk);
  setCard(`c-fclk-${i}`,   fclk);
  setCard(`c-pwr-${i}`,    pwr,    1);
  setCard(`c-etmp-${i}`,   tempE,  1);
  setCard(`c-cputmp-${i}`, cputmp, 1);
  setCard(`c-vddgfx-${i}`, vddgfx);
  setCard(`c-vddnb-${i}`,  vddnb);

  // Total GPU memory card
  const vmemEl = document.getElementById(`c-vmem-${i}`);
  if (vmemEl) {
    const vmemPct = combinedT > 0 ? combinedU / combinedT * 100 : null;
    vmemEl.textContent = vmemPct != null ? vmemPct.toFixed(3) : '—';
    if (combinedU != null || combinedT != null) state.cardLastData[`c-vmem-${i}`] = Date.now();
  }

  // VRAM card
  const vramUEl = document.getElementById(`c-vram-${i}-u`);
  const vramTEl = document.getElementById(`c-vram-${i}-t`);
  if (vramUEl) vramUEl.textContent = vramU != null ? (vramU/1024).toFixed(3) : '—';
  if (vramTEl) vramTEl.textContent = vramT != null ? (vramT/1024).toFixed(3) : '—';
  if (vramU != null || vramT != null) state.cardLastData[`c-vram-${i}`] = Date.now();

  // GTT card
  const gttUEl = document.getElementById(`c-gtt-${i}-u`);
  const gttTEl = document.getElementById(`c-gtt-${i}-t`);
  if (gttUEl) gttUEl.textContent = gttU != null ? (gttU/1024).toFixed(3) : '—';
  if (gttTEl) gttTEl.textContent = gttT != null ? (gttT/1024).toFixed(3) : '—';
  if (gttU != null || gttT != null) state.cardLastData[`c-gtt-${i}`] = Date.now();

  // CPU usage card
  const cpuNow = Date.now();
  const cpuFresh = state.lastCPU.value != null && (cpuNow - state.lastCPU.receivedAt) < 3000;
  setCard(`c-cpu-${i}`, cpuFresh ? state.lastCPU.value : null, 1);

  // ── Memory overview bar ──
  const sysInfo = state.systemInfo;
  if (sysInfo && vramT > 0) {
    const mk       = sysInfo.meminfo_kb    ?? {};
    const memRes   = sysInfo.mem_reservation ?? {};
    const drmMem   = sysInfo.drm_mem        ?? {};
    const totalKB  = mk.MemTotal ?? (sysInfo.total_ram_mib * 1024);

    const vramTotalKiB   = drmMem.vram_total_kib    ?? 0;
    const vramUsedKiB    = drmMem.vram_used_kib     ?? 0;
    const visVramUsedKiB = drmMem.vis_vram_used_kib ?? vramUsedKiB;
    const vramInvUsedKiB = Math.max(0, vramUsedKiB - visVramUsedKiB);
    const gttTotalKiB    = drmMem.gtt_total_kib     ?? 0;
    const gttUsedKiB     = drmMem.gtt_used_kib      ?? 0;

    const gttKB      = gttUsedKiB;
    const drmCpuKB   = drmMem.total_cpu_kib ?? 0;
    const anonKB     = mk.AnonPages    ?? 0;
    const gpuAnonKB  = sysInfo.gpu_anon_pss_kb ?? 0;
    const anonOtherKB = Math.max(0, anonKB - gpuAnonKB);
    const shmemKB    = mk.Shmem        ?? 0;
    const bufKB      = mk.Buffers      ?? 0;
    const cachedAllKB = mk.Cached      ?? 0;
    const cachedKB   = Math.max(0, cachedAllKB - shmemKB);
    const sreclmKB   = mk.SReclaimable ?? 0;
    const sunrecKB   = mk.SUnreclaim   ?? 0;
    const vmallocKB  = mk.VmallocUsed  ?? 0;
    const kstackKB   = mk.KernelStack  ?? 0;
    const ptablesKB  = (mk.PageTables  ?? 0) + (mk.SecPageTables ?? 0);
    const netbufKB   = sysInfo.sock_mem_kb ?? 0;
    const freeKB     = mk.MemFree      ?? 0;

    const namedKB  = gttKB + drmCpuKB + anonKB + shmemKB + cachedKB + bufKB
                   + sreclmKB + sunrecKB + vmallocKB + kstackKB + ptablesKB
                   + netbufKB;
    const drvpgKB  = Math.max(0, totalKB - freeKB - namedKB);

    const sysRamKiB    = memRes.system_ram_kib ?? 0;
    const kernelResKiB = Math.max(0, sysRamKiB - totalKB);

    const fwReservedKiB = Math.max(0, (sysInfo.firmware_reserved_kib ?? 0) - vramTotalKiB);

    const installedKiB = memRes.installed_kib
                      ?? (vramTotalKiB + fwReservedKiB + kernelResKiB + totalKB);

    const byId = id => document.getElementById(id);

    const pctInst = kib => `${kib / installedKiB * 100}%`;
    const vramPartEl = byId(`mem-vram-part-${i}`);
    if (vramPartEl) vramPartEl.style.width = pctInst(vramTotalKiB);
    const setSegKiB = (el, kib) => { if (!el) return; el.style.width = pctInst(kib); el.style.minWidth = kib > 0 ? '1px' : ''; };
    const vramVisEl = byId(`mem-vram-vis-${i}`);
    if (vramVisEl) { vramVisEl.style.width = vramTotalKiB > 0 ? `${visVramUsedKiB / vramTotalKiB * 100}%` : '0%'; vramVisEl.style.minWidth = visVramUsedKiB > 0 ? '1px' : ''; }
    const vramInvEl = byId(`mem-vram-inv-${i}`);
    if (vramInvEl) { vramInvEl.style.width = vramTotalKiB > 0 ? `${vramInvUsedKiB / vramTotalKiB * 100}%` : '0%'; vramInvEl.style.minWidth = vramInvUsedKiB > 0 ? '1px' : ''; }
    setSegKiB(byId(`mem-kres-${i}`), kernelResKiB);
    setSegKiB(byId(`mem-fw-${i}`),   fwReservedKiB);

    const pctSys = kb => `${kb / totalKB * 100}%`;
    const setSeg = (id, kb) => { const e = byId(id); if (e) { e.style.width = pctSys(kb); e.style.minWidth = kb > 0 ? "1px" : ""; } };
    setSeg(`mem-gtt-used-${i}`, gttKB);
    setSeg(`mem-drmcpu-${i}`,   drmCpuKB);

    const gpuAppsEl = byId(`mem-anon-gpu-${i}`);
    if (gpuAppsEl) {
      gpuAppsEl.style.width    = pctSys(gpuAnonKB);
      gpuAppsEl.style.minWidth = gpuAnonKB > 0 ? '1px' : '';
      const gpuProcs = (drmMem.processes ?? [])
        .filter(p => (p.pss_anon_kib ?? 0) > 0)
        .sort((a, b) => (b.pss_anon_kib ?? 0) - (a.pss_anon_kib ?? 0));
      const escAttr = s => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      let html = '';
      for (const p of gpuProcs) {
        const kib    = p.pss_anon_kib ?? 0;
        const thpKib = p.anon_huge_pages_kib ?? 0;
        const pct    = gpuAnonKB > 0 ? (kib / gpuAnonKB * 100) : 0;
        const gib    = (kib / 1024 / 1024).toFixed(3);
        const thpGib = (thpKib / 1024 / 1024).toFixed(3);
        const thpPct = kib > 0 ? Math.round(thpKib / kib * 100) : 0;
        const note = thpPct >= 80 ? ' — likely UMA model'
                   : thpPct <  20 ? ' — heap/stack dominant'
                   : '';
        const tip = `${p.comm || '?'} (PID ${p.pid}): ${gib} GiB Pss_Anon (${thpGib} GiB THP, ${thpPct}%${note})`
                  + (p.cmdline ? `<br>\`${escHtml(p.cmdline)}\`` : '');
        html += `<div class="mem-anon-gpu-pid" style="width:${pct}%" data-src="${escAttr(tip)}" data-dev="${i}">${p.pid}</div>`;
      }
      gpuAppsEl.innerHTML = html;
    }
    setSeg(`mem-anon-other-${i}`, anonOtherKB);
    setSeg(`mem-shmem-${i}`,    shmemKB);
    setSeg(`mem-cached-${i}`,   cachedKB);
    setSeg(`mem-buf-${i}`,      bufKB);
    setSeg(`mem-sreclm-${i}`,   sreclmKB);
    setSeg(`mem-sunrec-${i}`,   sunrecKB);
    setSeg(`mem-vmalloc-${i}`,  vmallocKB);
    setSeg(`mem-kstack-${i}`,   kstackKB);
    setSeg(`mem-ptables-${i}`,  ptablesKB);
    setSeg(`mem-netbuf-${i}`,   netbufKB);
    setSeg(`mem-drvpg-${i}`,    drvpgKB);

    const fmtGiB = kb => {
      const g = kb / 1024 / 1024;
      return `${g === 0 ? '0' : g.toFixed(3)} GiB`;
    };
    const fmtNum = g => g === 0 ? '0' : g.toFixed(3);
    const set = (id, v) => { const e = byId(id); if (e) e.textContent = v; };
    set(`mem-lbl-vram-free-${i}`, fmtGiB(vramTotalKiB - vramUsedKiB));
    set(`mem-lbl-vram-vis-${i}`,  fmtGiB(visVramUsedKiB));
    set(`mem-lbl-vram-inv-${i}`,  fmtGiB(vramInvUsedKiB));
    set(`mem-lbl-gtt-${i}`,       fmtGiB(gttKB));
    set(`mem-lbl-drmcpu-${i}`,    fmtGiB(drmCpuKB));
    set(`mem-lbl-anon-gpu-${i}`,   fmtGiB(gpuAnonKB));
    set(`mem-lbl-anon-other-${i}`, fmtGiB(anonOtherKB));
    set(`mem-lbl-shmem-${i}`,     fmtGiB(shmemKB));
    set(`mem-lbl-cached-${i}`,    fmtGiB(cachedKB));
    set(`mem-lbl-buf-${i}`,       fmtGiB(bufKB));
    set(`mem-lbl-sreclm-${i}`,    fmtGiB(sreclmKB));
    set(`mem-lbl-sunrec-${i}`,    fmtGiB(sunrecKB));
    set(`mem-lbl-vmalloc-${i}`,   fmtGiB(vmallocKB));
    set(`mem-lbl-kstack-${i}`,    fmtGiB(kstackKB));
    set(`mem-lbl-ptables-${i}`,   fmtGiB(ptablesKB));
    set(`mem-lbl-netbuf-${i}`,    fmtGiB(netbufKB));
    set(`mem-lbl-drvpg-${i}`,     fmtGiB(drvpgKB));
    set(`mem-lbl-free-${i}`,      fmtGiB(freeKB));
    set(`mem-lbl-kres-${i}`,      fmtGiB(kernelResKiB));
    set(`mem-lbl-fw-${i}`,        fmtGiB(fwReservedKiB));
    set(`mem-lbl-dmabuf-${i}`,    fmtGiB((sysInfo.dma_buf_bytes ?? 0) / 1024));
    set(`mem-lbl-total-${i}`,     fmtNum(installedKiB / 1024 / 1024));

    const usedKB = totalKB - freeKB;
    const nonGttTotalKB = totalKB - gttTotalKiB;
    const gttMarginKB   = nonGttTotalKB - (usedKB - gttKB);
    set(`mem-lbl-nongtt-${i}`,  fmtNum(nonGttTotalKB / 1024 / 1024));
    set(`mem-lbl-gttmargin-${i}`,  fmtNum(gttMarginKB / 1024 / 1024));
    const gttMarginEl = byId(`mem-lbl-gttmargin-${i}`);
    if (gttMarginEl) gttMarginEl.style.color = gttMarginKB < 0 ? 'var(--red)' : '';
  }

  // Progress bars
  setBar(`c-gfx-${i}`,   gfx);
  setBar(`c-media-${i}`, media);
  setBar(`c-vmem-${i}`,  combinedT > 0 ? combinedU / combinedT * 100 : null);
  setBar(`c-vram-${i}`,  vramT  > 0 ? vramU  / vramT  * 100 : null);
  setBar(`c-gtt-${i}`,   gttT   > 0 ? gttU   / gttT   * 100 : null);
  setBar(`c-cpu-${i}`,   cpuFresh ? state.lastCPU.value : null);

  // ── History, chart annotations, GRBM, process table ──
  pushChartHistory(i, dev);
  updateChartAnnotations(i);
  updateGRBM(i, dev);
  updateProcessTable(i, dev);
}
