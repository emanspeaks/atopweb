function buildProcessTable(i) {
  const procSec = el('div', 'proc-section');
  procSec.appendChild(el('div', 'section-title', 'GPU / NPU Processes'));
  const tbl = el('table', 'proc-table');
  tbl.innerHTML = `
    <thead>
      <tr>
        <th>PID</th>
        <th>Name</th>
        <th data-src="CPU utilization: % of one CPU core (sum of all threads; can exceed 100% on multi-threaded processes)">CPU%</th>
        <th data-src="GPU-private VRAM (KiB): drm-memory-vram minus amd-memory-visible-vram from /proc/pid/fdinfo — VRAM not mapped through the PCIe BAR aperture; exclusively GPU-accessible buffers">V-priv (KiB)</th>
        <th data-src="CPU-accessible VRAM (KiB): amd-memory-visible-vram from /proc/pid/fdinfo — VRAM mapped through the PCIe BAR aperture, shared between CPU and GPU; staging area on discrete GPUs, UMA on APUs">V-shm (KiB)</th>
        <th data-src="Graphics Translation Table memory (KiB): drm-memory-gtt from /proc/pid/fdinfo — system RAM pinned and mapped for GPU DMA access via the GTT pool">GTT (KiB)</th>
        <th data-src="DRM CPU-domain memory (KiB): drm-memory-cpu from /proc/pid/fdinfo — system RAM buffers in amdgpu's CPU memory pool (rarely populated)">DRM (KiB)</th>
        <th data-src="Regular-page application RSS (KiB): /proc/pid/smaps_rollup Pss_Anon minus AnonHugePages — anonymous RSS not backed by 2 MiB huge pages (heap, stack, small mmaps)">Apps-reg (KiB)</th>
        <th data-src="Anonymous transparent huge pages (KiB): /proc/pid/smaps_rollup AnonHugePages — anon RSS backed by 2 MiB THP; in ROCm/UMA workloads typically holds model weights">Apps-THP (KiB)</th>
        <th data-src="GFX engine utilization: % of GFX (3D/compute graphics) engine time consumed by this process">GFX%</th>
        <th data-src="Compute engine utilization: % of async-compute / HSA dispatch queue time consumed by this process">Compute%</th>
        <th data-src="SDMA engine utilization: % of system DMA engine time consumed by this process">DMA%</th>
        <th data-src="Media engine utilization: % of legacy UVD/VCE engine time consumed by this process">Media%</th>
        <th data-src="VCN (Video Core Next) utilization: % of unified H.264/HEVC/AV1 encode-decode engine time consumed by this process">VCN%</th>
        <th data-src="VPE (Video Processing Engine) utilization: % of color-conversion / scaling / deinterlace engine time consumed by this process">VPE%</th>
        <th data-src="NPU (XDNA) utilization: % of XDNA Neural Processing Unit engine time consumed by this process">NPU%</th>
        <th data-src="NPU memory allocated (KiB): XDNA driver-allocated buffers for this process's NPU workloads (MiB → KiB)">NPU Mem (KiB)</th>
      </tr>
    </thead>
    <tbody id="proc-body-${i}"></tbody>`;
  procSec.appendChild(tbl);
  return procSec;
}

function applyGttMarginVisibility() {
  const display = state.showGttMargin ? '' : 'none';
  document.querySelectorAll('.mem-gttmargin-group').forEach(el => {
    el.style.display = display;
  });
}

function switchTab(idx) {
  if (idx === state.cur) return;
  document.querySelectorAll('.tab-btn').forEach((btn, i) => btn.classList.toggle('active', i === idx));
  document.querySelectorAll('.gpu-panel').forEach((p,  i) => p.classList.toggle('active',  i === idx));
  state.cur = idx;
  // Render newly visible tab's charts immediately (they may have skipped updates while hidden).
  const now = Date.now();
  for (const [key, c] of Object.entries(state.charts)) {
    if (parseInt(key, 10) !== idx) continue;
    const isCoreFreq = key.includes('-cpu-core-');
    c.options.scales.x.min = now - (isCoreFreq ? state.coreTimeWidthMs : state.timeWidthMs);
    c.options.scales.x.max = now;
    c.update('none');
  }
}
