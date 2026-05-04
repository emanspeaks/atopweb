// ── Interval control ─────────────────────────────────────────────────────────
function initIntervalCtrl() {
  fetchConfig();

  const apply = () => {
    const ms = parseInt(document.getElementById('interval-input').value, 10);
    if (isNaN(ms) || ms < 50 || ms > 60000) return;
    state.intervalMs = ms;
    localStorage.setItem('atopweb.intervalMs', ms);
    if (state.lastDevices) buildDom(state.lastDevices);
    fetch(`/api/interval?ms=${ms}`, { method: 'POST' });
    appendLog(`Interval set to ${ms}ms`);
  };

  document.getElementById('interval-btn').addEventListener('click', apply);
  document.getElementById('interval-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') apply();
  });
}

// ── Plot / core width controls ────────────────────────────────────────────────
function initPlotWidthCtrl() {
  const applyWidth = (stateKey, inputId) => {
    const s = parseInt(document.getElementById(inputId).value, 10);
    if (isNaN(s) || s < 5 || s > 3600) return;
    state[stateKey] = s * 1000;
    localStorage.setItem(`atopweb.${stateKey}`, state[stateKey]);
    if (state.lastDevices) buildDom(state.lastDevices);
    const label = stateKey === 'coreTimeWidthMs' ? 'Core clock width' : 'Plot width';
    appendLog(`${label} set to ${s}s`);
  };
  const bind = (stateKey, inputId, btnId) => {
    document.getElementById(btnId).addEventListener('click', () => applyWidth(stateKey, inputId));
    document.getElementById(inputId).addEventListener('keydown', e => { if (e.key === 'Enter') applyWidth(stateKey, inputId); });
  };
  bind('timeWidthMs',     'plotwidth-input', 'plotwidth-btn');
  bind('coreTimeWidthMs', 'corewidth-input', 'corewidth-btn');
}

function initPauseBtn() {
  const btn = document.getElementById('pause-btn');
  btn.addEventListener('click', () => {
    state.paused = !state.paused;
    btn.textContent = state.paused ? '▶' : '⏸';
    btn.classList.toggle('paused', state.paused);
    appendLog(state.paused ? 'Paused' : 'Resumed');
    if (!state.paused) scheduleRender();
  });
}

// Build a tab-delimited snapshot of every value rendered in the memory bar (for
// device index `i`) plus the summary totals (Installed/Non-GTT/GTT Margin).  All
// values are raw bytes — no units, no scaling — so they can be summed in Excel
// to verify the accounting.
function buildMemorySnapshotTSV(i = 0) {
  const sysInfo = state.systemInfo;
  if (!sysInfo) return null;
  const dev = state.lastDevices?.[i];
  if (!dev) return null;

  const mk     = sysInfo.meminfo_kb      ?? {};
  const memRes = sysInfo.mem_reservation ?? {};
  const drmMem = sysInfo.drm_mem         ?? {};

  const kib = 1024;
  const fromKB = k => (mk[k] ?? 0) * kib;

  // VRAM / GTT in KiB (byte-exact from /sys/class/drm/card*/device/mem_info_*
  // via Go server, not the MiB-quantized amdgpu_top JSON).
  const vramTotalKiB   = drmMem.vram_total_kib    ?? 0;
  const vramUsedKiB    = drmMem.vram_used_kib     ?? 0;
  const gttTotalKiB    = drmMem.gtt_total_kib     ?? 0;
  const gttUsedKiB     = drmMem.gtt_used_kib      ?? 0;
  const visVramUsedKiB = drmMem.vis_vram_used_kib ?? vramUsedKiB;
  const vramInvUsedKiB = Math.max(0, vramUsedKiB - visVramUsedKiB);

  const totalKB    = mk.MemTotal ?? (sysInfo.total_ram_mib * 1024);
  const freeKB     = mk.MemFree ?? 0;
  const cachedKB   = Math.max(0, (mk.Cached ?? 0) - (mk.Shmem ?? 0));
  const ptablesKB  = (mk.PageTables ?? 0) + (mk.SecPageTables ?? 0);
  const drmCpuKB   = drmMem.total_cpu_kib ?? 0;
  const netbufKB   = sysInfo.sock_mem_kb ?? 0;

  const namedKB = gttUsedKiB + drmCpuKB + (mk.AnonPages ?? 0)
                + (mk.Shmem ?? 0) + cachedKB + (mk.Buffers ?? 0)
                + (mk.SReclaimable ?? 0) + (mk.SUnreclaim ?? 0)
                + (mk.VmallocUsed ?? 0) + (mk.KernelStack ?? 0)
                + ptablesKB + netbufKB;
  const drvpgKB = Math.max(0, totalKB - freeKB - namedKB);

  const sysRamKiB    = memRes.system_ram_kib ?? 0;
  const kernelResKiB = Math.max(0, sysRamKiB - totalKB);
  const fwTotalKiB   = sysInfo.firmware_reserved_kib ?? 0;
  const fwNonVramKiB = Math.max(0, fwTotalKiB - vramTotalKiB);
  const installedKiB = memRes.installed_kib
                    ?? (vramTotalKiB + fwTotalKiB + kernelResKiB + totalKB);

  // Summary totals shown in the legend right-side group.
  const usedKB        = totalKB - freeKB;
  const nonGttTotalKB = totalKB - gttTotalKiB;
  const gttMarginKB   = nonGttTotalKB - (usedKB - gttUsedKiB);

  // Sections correspond to the physical zones of the bar.  Each section's
  // leading rows are the exact byte values used to size the segments in that
  // zone; the final freeform section carries supporting/context values that
  // don't themselves drive a segment width.
  const tsvQ = s => /[	"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  const sections = [
    // ── VRAM zone (left) ──
    [
      ['vram_free',           (vramTotalKiB - vramUsedKiB) * kib, MEM_TIPS.vramFree],
      ['vram_invisible_used', vramInvUsedKiB * kib,               MEM_TIPS.vramInv],
      ['vram_visible_used',   visVramUsedKiB * kib,               MEM_TIPS.vramVis],
    ],
    // ── System RAM zone (middle sys-part, left-to-right) ──
    [
      ['gtt_used',         gttUsedKiB * kib,      MEM_TIPS.gtt],
      ['drm_cpu',          drmCpuKB * kib,        MEM_TIPS.drmCpu],
      ['apps_anon_gpu',    (sysInfo.gpu_anon_pss_kb ?? 0) * kib,                                       MEM_TIPS.anonGpu],
      ['apps_anon_other',  Math.max(0, (mk.AnonPages ?? 0) - (sysInfo.gpu_anon_pss_kb ?? 0)) * kib,    MEM_TIPS.anonOther],
      ['shared_shmem',     fromKB('Shmem'),        MEM_TIPS.shmem],
      ['file_cache',       cachedKB * kib,         MEM_TIPS.cached],
      ['buffers',          fromKB('Buffers'),      MEM_TIPS.buf],
      ['slab_reclaimable', fromKB('SReclaimable'), MEM_TIPS.sreclm],
      ['slab_unreclaim',   fromKB('SUnreclaim'),   MEM_TIPS.sunrec],
      ['vmalloc_used',     fromKB('VmallocUsed'),  MEM_TIPS.vmalloc],
      ['kernel_stack',     fromKB('KernelStack'),  MEM_TIPS.kstack],
      ['page_tables',      ptablesKB * kib,        MEM_TIPS.ptables],
      ['net_buffers',      netbufKB * kib,         MEM_TIPS.netbuf],
      ['driver_pages',     drvpgKB * kib,          MEM_TIPS.drvpg],
      ['mem_free',         freeKB * kib,           MEM_TIPS.free],
    ],
    // ── Reserved zone (right, unavailable at runtime) ──
    [
      ['kernel_reserved',   kernelResKiB * kib,     MEM_TIPS.kres],
      ['firmware_non_vram', fwNonVramKiB * kib,     MEM_TIPS.fw],
    ],
    // ── Legend totals / margin readouts ──
    [
      ['installed',     installedKiB * kib,      'Total installed memory: VRAM + system RAM + firmware reserved + kernel-reserved'],
      ['non_gtt_total', nonGttTotalKB * kib,     'System RAM not mapped as GTT: MemTotal − gtt_total'],
      ['gtt_margin', gttMarginKB * kib,          'Unallocated Non-GTT system RAM: non_gtt_total − used_non_gtt'],
    ],
    // ── Supporting detail (not rendered as bar segments) ──
    [
      ['mem_total',       totalKB * kib,             '/proc/meminfo MemTotal (system RAM addressable by OS)'],
      ['system_ram_e820', sysRamKiB * kib,           'Total system RAM from e820 map (includes kernel-reserved region)'],
      ['vram_total',      vramTotalKiB * kib,        'mem_info_vram_total (full video memory capacity, byte-exact via sysfs)'],
      ['vram_used',       vramUsedKiB * kib,         'mem_info_vram_used (allocated regardless of BAR visibility)'],
      ['gtt_total',       gttTotalKiB * kib,         'mem_info_gtt_total (maximum system RAM pinnable as GPU-addressable)'],
      ['firmware_total',  fwTotalKiB * kib,          'mem_reservation.firmware_reserved_kib (total firmware footprint including BIOS VRAM carveout)'],
      ['dma_buf_total',   sysInfo.dma_buf_bytes ?? 0, 'Total bytes in active DMA-BUF objects from debugfs (cross-process shared GPU/CPU buffers)'],
      ['top_mem_msr',     memRes.top_mem_bytes   ?? 0, 'MSR TOP_MEM: AMD DRAM top-of-memory boundary (upper limit of low DRAM visible to CPU)'],
      ['top_mem2_msr',    memRes.top_mem2_bytes  ?? 0, 'MSR TOP_MEM2: AMD extended DRAM boundary above 4 GiB (upper limit of high DRAM)'],
      ['tseg_base_msr',   memRes.tseg_base_bytes ?? 0, 'MSR SMM_ADDR: TSEG base address (System Management Mode memory base)'],
      ['tseg_size_msr',   memRes.tseg_size_bytes ?? 0, 'MSR SMM_MASK: TSEG size (System Management Mode memory region size)'],
    ],
  ];
  const lines = ['bucket\tbytes\tdescription'];
  sections.forEach((rows, idx) => {
    if (idx > 0) lines.push('');
    for (const r of rows) lines.push(r[0] + '\t' + r[1] + '\t' + tsvQ(r[2]));
  });
  return lines.join('\n');
}

function initMemSnapBtn() {
  const btn = document.getElementById('memsnap-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const tsv = buildMemorySnapshotTSV(0);
    if (!tsv) {
      appendLog('Memory snapshot: no data yet', 'warn');
      return;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(tsv);
      } else {
        // Fallback for HTTP on non-localhost (no secure context).
        const ta = document.createElement('textarea');
        ta.value = tsv;
        ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      appendLog('Memory snapshot copied to clipboard');
    } catch (err) {
      appendLog('Memory snapshot: clipboard write failed — ' + (err?.message || err), 'warn');
    }
  });
}
