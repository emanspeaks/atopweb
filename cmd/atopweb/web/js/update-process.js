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
    }
  }
  for (const [pid, name] of h.prevProcNames) {
    if (!currentProcNames.has(pid)) {
      h.events.push({ timeMs: nowMs, type: 'stop', name, pid: Number(pid) });
      h.earlyStartedPids.delete(pid);
      appendLog(`Process stop: ${name} (PID ${pid})`, 'warn');
    }
  }
  h.prevProcNames = currentProcNames;
  const oldest = nowMs - Math.max(state.timeWidthMs, state.coreTimeWidthMs);
  while (h.events.length && h.events[0].timeMs < oldest) h.events.shift();
  for (const [key, chart] of Object.entries(state.charts)) {
    if (key.startsWith(`${i}-`))
      syncEventAnnotations(chart, h.events, key.includes('-cpu-core-'));
  }

  if (pids.length === 0) {
    tbody.innerHTML = `<tr><td colspan="17" class="proc-empty" style="padding:12px 16px">No GPU / NPU processes</td></tr>`;
    return;
  }

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

  tbody.innerHTML = pids.map(pid => {
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
                           : `GTT (Graphics Translation Table) used: devices[${i}].fdinfo[${pid}].usage.GTT (MiB \u2192 KiB, amdgpu_top fallback)`;
    return `<tr>
      <td class="proc-pid" data-src="${escCmd}">${pid}</td>
      <td class="proc-name" data-src="${escCmd}">${name}</td>
      <td data-src="CPU usage: devices[${i}].fdinfo[${pid}].usage.CPU (% of one core)">${fmt(cpu, 0)}</td>
      <td data-src="GPU-private VRAM: drm_mem.processes[pid=${pid}].vram_kib − vis_vram_kib — VRAM not mapped through the PCIe BAR; GPU-exclusive buffers (drm-memory-vram minus amd-memory-visible-vram from /proc/${pid}/fdinfo)">${fmtKib(invVramKiB)}</td>
      <td data-src="CPU-accessible VRAM: drm_mem.processes[pid=${pid}].vis_vram_kib — VRAM mapped through the PCIe BAR aperture, shared between CPU and GPU (amd-memory-visible-vram from /proc/${pid}/fdinfo)">${fmtKib(visVramKiB)}</td>
      <td data-src="${memSrcGtt}">${fmtKib(gttKiB)}</td>
      <td data-src="DRM CPU-domain buffers: drm_mem.processes[pid=${pid}].cpu_kib (KiB-exact via /proc/${pid}/fdinfo drm-memory-cpu — system RAM staged through amdgpu's CPU pool, rarely populated)">${fmtKib(drmCpuKiB)}</td>
      <td data-src="Regular-page application memory (Apps-reg): /proc/${pid}/smaps_rollup Pss_Anon − AnonHugePages (anonymous RSS NOT backed by 2 MiB transparent huge pages — process heap, stack, and small mmap regions; in a ROCm UMA workload this is the non-model overhead while Apps-THP holds the model weights)">${fmtKib(appsRegKiB)}</td>
      <td data-src="Anonymous transparent huge pages (AnonHugePages): /proc/${pid}/smaps_rollup AnonHugePages (anon RSS backed by 2 MiB THP)">${fmtKib(thpKiB)}</td>
      <td data-src="GFX engine usage: devices[${i}].fdinfo[${pid}].usage.GFX (% of GFX engine time consumed by this process)">${fmt(gfx, 0)}</td>
      <td data-src="Compute engine usage: devices[${i}].fdinfo[${pid}].usage.Compute (% of compute queue time consumed by this process — async compute and HSA dispatch)">${fmt(compute, 0)}</td>
      <td data-src="DMA (SDMA) engine usage: devices[${i}].fdinfo[${pid}].usage.DMA (% of system DMA engine time consumed by this process)">${fmt(dma, 0)}</td>
      <td data-src="Media engine usage: devices[${i}].fdinfo[${pid}].usage.Media (% of media engine time consumed by this process — legacy UVD/VCE)">${fmt(media, 0)}</td>
      <td data-src="VCN (Video Core Next) engine usage: devices[${i}].fdinfo[${pid}].usage.VCN_Unified (% of unified video codec engine time — H.264/HEVC/AV1 encode and decode)">${fmt(vcn, 0)}</td>
      <td data-src="VPE (Video Processing Engine) usage: devices[${i}].fdinfo[${pid}].usage.VPE (% of video post-processing engine time — color conversion, scaling, deinterlace)">${fmt(vpe, 0)}</td>
      <td data-src="NPU (Neural Processing Unit / XDNA) usage: devices[${i}].xdna_fdinfo[${pid}].usage.NPU (% of XDNA accelerator time consumed by this process)">${fmt(npu, 0)}</td>
      <td data-src="NPU memory allocated: devices[${i}].xdna_fdinfo[${pid}].usage['NPU Mem'] (MiB \u2192 KiB; XDNA driver-allocated buffers for NPU workloads)">${fmtKib(npuMem != null ? npuMem * 1024 : null)}</td>
    </tr>`;
  }).join('');
}
