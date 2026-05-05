// ── Process table update ─────────────────────────────────────────────────────

function updateProcessTable(i, dev) {
  const h = state.hist[i];
  const tbody = document.getElementById(`proc-body-${i}`);
  if (!tbody) return;

  const getUsage = (p) => p?.usage?.usage || p?.usage || p;

  const fdinfo     = dev.fdinfo      || {};
  const xdnaFdinfo = dev.xdna_fdinfo || {};
  const drmProcs   = state.systemInfo?.drm_mem?.processes ?? [];
  const procMap    = {};
  for (const [pid, proc] of Object.entries(fdinfo))     procMap[pid] = { gpuProc: proc, npuProc: null, drm: null };
  for (const [pid, proc] of Object.entries(xdnaFdinfo)) {
    if (procMap[pid]) procMap[pid].npuProc = proc;
    else              procMap[pid] = { gpuProc: null, npuProc: proc, drm: null };
  }
  for (const dp of drmProcs) {
    const pid = String(dp.pid);
    if (procMap[pid]) procMap[pid].drm = dp;
    else              procMap[pid] = { gpuProc: null, npuProc: null, drm: dp };
  }

  const pids = Object.keys(procMap);

  // ── Process start/stop event detection ──
  const nowMs = Date.now();
  const currentProcNames = new Map();
  for (const pid of pids) {
    const e    = procMap[pid];
    const proc = e.gpuProc || e.npuProc;
    currentProcNames.set(pid, proc?.name || e.drm?.comm || `PID ${pid}`);
  }
  for (const [pid] of currentProcNames) {
    if (!h.prevProcNames.has(pid) && !h.earlyStartedPids.has(pid)) {
      const name = currentProcNames.get(pid);
      h.events.push({ timeMs: nowMs, type: 'start', name, pid: Number(pid) });
      appendLog(`Process start: ${name} (PID ${pid})`, 'ok');
      h.eventsDirty = true;
    }
  }
  for (const [pid, name] of h.prevProcNames) {
    if (!currentProcNames.has(pid)) {
      h.events.push({ timeMs: nowMs, type: 'stop', name, pid: Number(pid) });
      h.earlyStartedPids.delete(pid);
      appendLog(`Process stop: ${name} (PID ${pid})`, 'warn');
      h.eventsDirty = true;
    }
  }
  h.prevProcNames = currentProcNames;
  const oldest = nowMs - Math.max(state.timeWidthMs, state.coreTimeWidthMs);
  while (h.events.length && h.events[0].timeMs < oldest) {
    h.events.shift();
    h.eventsDirty = true;
  }
  // Most ticks no events change; skip the per-chart annotation rebuild then.
  // h.eventsDirty is also set by ws.js when proc_event frames push events.
  if (h.eventsDirty) {
    for (const [key, chart] of Object.entries(state.charts)) {
      if (key.startsWith(`${i}-`))
        syncEventAnnotations(chart, h.events, key.includes('-cpu-core-'));
    }
    h.eventsDirty = false;
  }

  if (pids.length === 0) {
    if (h.procRows && h.procRows.size) {
      for (const row of h.procRows.values()) row.tr.remove();
      h.procRows.clear();
    }
    if (!tbody.firstElementChild?.classList.contains('proc-empty-row')) {
      tbody.innerHTML = `<tr class="proc-empty-row"><td colspan="17" class="proc-empty" style="padding:12px 16px">No GPU / NPU processes</td></tr>`;
    }
    return;
  }
  // First populated render after an empty render: clear the empty placeholder.
  if (tbody.firstElementChild?.classList.contains('proc-empty-row')) tbody.innerHTML = '';
  if (!h.procRows) h.procRows = new Map();

  const memSize = (e) => {
    if (e.drm) return (e.drm.vram_kib ?? 0) + (e.drm.gtt_kib ?? 0) + (e.drm.cpu_kib ?? 0) + (e.drm.pss_anon_kib ?? 0);
    if (e.gpuProc) {
      const u = getUsage(e.gpuProc);
      return ((v(u, 'VRAM') ?? v(u, 'vram_usage') ?? v(u, 'vram') ?? 0) +
              (v(u, 'GTT')  ?? v(u, 'gtt_usage')  ?? v(u, 'gtt')  ?? 0)) * 1024;
    }
    return 0;
  };
  pids.sort((a, b) => memSize(procMap[b]) - memSize(procMap[a]));

  // Static `data-src` tooltip strings depend only on pid + device index, both
  // stable for a row's lifetime, so we attach them once at row creation and
  // only update textContent each tick.  Saves re-parsing ~12 KB of innerHTML
  // every 100 ms.
  const buildRow = (pid) => {
    const tr = document.createElement('tr');
    tr.dataset.pid = pid;
    const cells = new Array(17);
    const addCell = (idx, cls, src) => {
      const td = document.createElement('td');
      if (cls) td.className = cls;
      if (src) td.setAttribute('data-src', src);
      tr.appendChild(td);
      cells[idx] = td;
    };
    addCell(0,  'proc-pid',  null);
    addCell(1,  'proc-name', null);
    addCell(2,  null, `CPU usage: devices[${i}].fdinfo[${pid}].usage.CPU (% of one core)`);
    addCell(3,  null, `GPU-private VRAM: drm_mem.processes[pid=${pid}].vram_kib − vis_vram_kib — VRAM not mapped through the PCIe BAR; GPU-exclusive buffers (drm-memory-vram minus amd-memory-visible-vram from /proc/${pid}/fdinfo)`);
    addCell(4,  null, `CPU-accessible VRAM: drm_mem.processes[pid=${pid}].vis_vram_kib — VRAM mapped through the PCIe BAR aperture, shared between CPU and GPU (amd-memory-visible-vram from /proc/${pid}/fdinfo)`);
    addCell(5,  null, null); // GTT — data-src updated per render (drm vs fdinfo source)
    addCell(6,  null, `DRM CPU-domain buffers: drm_mem.processes[pid=${pid}].cpu_kib (KiB-exact via /proc/${pid}/fdinfo drm-memory-cpu — system RAM staged through amdgpu's CPU pool, rarely populated)`);
    addCell(7,  null, `Regular-page application memory (Apps-reg): /proc/${pid}/smaps_rollup Pss_Anon − AnonHugePages (anonymous RSS NOT backed by 2 MiB transparent huge pages — process heap, stack, and small mmap regions; in a ROCm UMA workload this is the non-model overhead while Apps-THP holds the model weights)`);
    addCell(8,  null, `Anonymous transparent huge pages (AnonHugePages): /proc/${pid}/smaps_rollup AnonHugePages (anon RSS backed by 2 MiB THP)`);
    addCell(9,  null, `GFX engine usage: devices[${i}].fdinfo[${pid}].usage.GFX (% of GFX engine time consumed by this process)`);
    addCell(10, null, `Compute engine usage: devices[${i}].fdinfo[${pid}].usage.Compute (% of compute queue time consumed by this process — async compute and HSA dispatch)`);
    addCell(11, null, `DMA (SDMA) engine usage: devices[${i}].fdinfo[${pid}].usage.DMA (% of system DMA engine time consumed by this process)`);
    addCell(12, null, `Media engine usage: devices[${i}].fdinfo[${pid}].usage.Media (% of media engine time consumed by this process — legacy UVD/VCE)`);
    addCell(13, null, `VCN (Video Core Next) engine usage: devices[${i}].fdinfo[${pid}].usage.VCN_Unified (% of unified video codec engine time — H.264/HEVC/AV1 encode and decode)`);
    addCell(14, null, `VPE (Video Processing Engine) usage: devices[${i}].fdinfo[${pid}].usage.VPE (% of video post-processing engine time — color conversion, scaling, deinterlace)`);
    addCell(15, null, `NPU (Neural Processing Unit / XDNA) usage: devices[${i}].xdna_fdinfo[${pid}].usage.NPU (% of XDNA accelerator time consumed by this process)`);
    addCell(16, null, `NPU memory allocated: devices[${i}].xdna_fdinfo[${pid}].usage['NPU Mem'] (MiB → KiB; XDNA driver-allocated buffers for NPU workloads)`);
    return { tr, cells };
  };

  const live = new Set();
  for (let r = 0; r < pids.length; r++) {
    const pid = pids[r];
    const { gpuProc, npuProc, drm } = procMap[pid];
    const proc    = gpuProc || npuProc;
    const u       = gpuProc ? getUsage(gpuProc) : null;
    const nu      = npuProc ? getUsage(npuProc) : null;
    const name    = proc?.name || drm?.comm || '?';
    const cmdline = drm?.cmdline || proc?.name || name;
    const escCmd  = ('`' + escHtml(cmdline) + '`').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const cpu     = u ? (v(u, 'CPU') ?? v(u, 'cpu_usage') ?? v(u, 'cpu')) : null;
    const gfx     = u ? v(u, 'GFX')         : null;
    const compute = u ? v(u, 'Compute')     : null;
    const dma     = u ? v(u, 'DMA')         : null;
    const media   = u ? v(u, 'Media')       : null;
    const vcn     = u ? (v(u, 'VCN_Unified') ?? v(u, 'VCN_JPEG') ?? v(u, 'Decode')) : null;
    const vpe     = u ? v(u, 'VPE')         : null;
    const npu     = nu ? v(nu, 'NPU')       : null;
    const npuMem  = nu ? (v(nu, 'NPU Mem') ?? v(nu, 'npu_mem') ?? v(nu, 'npu_memory')) : null;
    const visVramKiB = drm ? (drm.vis_vram_kib ?? 0) : null;
    const invVramKiB = drm ? Math.max(0, (drm.vram_kib ?? 0) - (drm.vis_vram_kib ?? 0)) : null;
    const gttKiB     = drm ? drm.gtt_kib     : (u ? ((v(u, 'GTT')  ?? v(u, 'gtt_usage')  ?? v(u, 'gtt')  ?? 0) * 1024) : null);
    const drmCpuKiB  = drm ? (drm.cpu_kib ?? 0)      : null;
    const thpKiB     = drm ? (drm.anon_huge_pages_kib ?? 0) : null;
    const appsRegKiB = drm ? Math.max(0, (drm.pss_anon_kib ?? 0) - (drm.anon_huge_pages_kib ?? 0)) : null;
    const memSrcGtt  = drm ? `GTT (Graphics Translation Table) used: drm_mem.processes[pid=${pid}].gtt_kib (KiB-exact via /proc/${pid}/fdinfo drm-memory-gtt)`
                           : `GTT (Graphics Translation Table) used: devices[${i}].fdinfo[${pid}].usage.GTT (MiB → KiB, amdgpu_top fallback)`;

    let row = h.procRows.get(pid);
    if (!row) { row = buildRow(pid); h.procRows.set(pid, row); }
    live.add(pid);
    const c = row.cells;
    if (c[0].textContent !== pid)        c[0].textContent = pid;
    if (c[0].getAttribute('data-src') !== escCmd) c[0].setAttribute('data-src', escCmd);
    if (c[1].textContent !== name)       c[1].textContent = name;
    if (c[1].getAttribute('data-src') !== escCmd) c[1].setAttribute('data-src', escCmd);
    c[2].textContent  = fmt(cpu, 0);
    c[3].textContent  = fmtKib(invVramKiB);
    c[4].textContent  = fmtKib(visVramKiB);
    if (c[5].getAttribute('data-src') !== memSrcGtt) c[5].setAttribute('data-src', memSrcGtt);
    c[5].textContent  = fmtKib(gttKiB);
    c[6].textContent  = fmtKib(drmCpuKiB);
    c[7].textContent  = fmtKib(appsRegKiB);
    c[8].textContent  = fmtKib(thpKiB);
    c[9].textContent  = fmt(gfx, 0);
    c[10].textContent = fmt(compute, 0);
    c[11].textContent = fmt(dma, 0);
    c[12].textContent = fmt(media, 0);
    c[13].textContent = fmt(vcn, 0);
    c[14].textContent = fmt(vpe, 0);
    c[15].textContent = fmt(npu, 0);
    c[16].textContent = fmtKib(npuMem != null ? npuMem * 1024 : null);

    // Move row into the correct position; appendChild on an existing node
    // moves the same DOM node — cells are kept, no re-parenting.
    if (tbody.children[r] !== row.tr) tbody.appendChild(row.tr);
  }
  // Drop rows whose pid disappeared this tick.
  for (const [pid, row] of h.procRows) {
    if (!live.has(pid)) { row.tr.remove(); h.procRows.delete(pid); }
  }
}
