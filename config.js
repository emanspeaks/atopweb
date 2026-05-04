// ── Constants ────────────────────────────────────────────────────────────────

const GRBM_KEYS = [
  'Graphics Pipe',
  'Texture Pipe',
  'Shader Export',
  'Shader Processor Interpolator',
  'Primitive Assembly',
  'Depth Block',
  'Color Block',
  'Geometry Engine',
];

const GRBM2_KEYS = [
  'RunList Controller',
  'Texture Cache per Pipe',
  'Unified Translation Cache Level-2',
  'Efficiency Arbiter',
  'Render Backend Memory Interface',
  'SDMA',
  'Command Processor -  Fetcher',
  'Command Processor -  Compute',
  'Command Processor - Graphics',
];

const MEM_TIPS = {
  vramFree:  "VRAM free: mem_info_vram_total − mem_info_vram_used (unallocated video RAM; includes firmware carveout region)",
  vramVis:   "CPU-visible VRAM used: mem_info_vis_vram_used (allocated VRAM reachable by CPU via PCIe BAR mapping)",
  vramInv:   "CPU-invisible VRAM used: mem_info_vram_used − mem_info_vis_vram_used (allocated VRAM not reachable via PCIe BAR — GPU-private only)",
  gtt:       "GTT (Graphics Translation Table) used: amdgpu 'Total GTT Usage' (system RAM pinned into the GPU's address space via IOMMU page tables)",
  drmCpu:    "DRM CPU buffers: Σ drm-memory-cpu across /proc/*/fdinfo (GPU buffers resident in CPU-accessible system RAM)",
  anonGpu:   "GPU process memory: Σ /proc/PID/smaps_rollup Pss_Anon for PIDs in DRM fdinfo (proportional anon RSS attributable to GPU processes; includes ROCm UMA/HSA host allocations and LLM model weights mapped into GPU process address space)",
  anonOther: "Non-GPU app memory: /proc/meminfo AnonPages − GPU process Pss_Anon (anonymous pages from non-GPU processes: heap, stack, private mmap)",
  shmem:     "Shared memory: /proc/meminfo Shmem (tmpfs files, SysV shared memory, and POSIX shared memory segments)",
  cached:    "File cache: /proc/meminfo Cached − Shmem (reclaimable page cache for file-backed data; freed under memory pressure)",
  buf:       "Block buffers: /proc/meminfo Buffers (reclaimable kernel buffer cache for block device metadata)",
  sreclm:    "Reclaimable slab: /proc/meminfo SReclaimable (dentry and inode caches; freed under memory pressure)",
  sunrec:    "Unreclaimable slab: /proc/meminfo SUnreclaim (kernel object caches that cannot be reclaimed under pressure)",
  vmalloc:   "Vmalloc: /proc/meminfo VmallocUsed (kernel virtual memory area allocations including per-CPU data)",
  kstack:    "Kernel stacks: /proc/meminfo KernelStack (per-thread kernel-mode stacks)",
  ptables:   "Page tables: /proc/meminfo PageTables + SecPageTables (memory used to map process virtual address spaces)",
  netbuf:    "Network buffers: /proc/net/sockstat mem × page_size (kernel memory reserved for socket send/receive buffers)",
  drvpg:     "Driver pages: total used − Σ all named segments (kernel direct alloc_pages() for DMA-coherent buffers, driver scratch, and HugeTLB pool)",
  free:      "Free memory: /proc/meminfo MemFree (unallocated system RAM)",
  fw:        "Firmware reserved: mem_reservation.firmware_reserved_kib − BIOS VRAM carveout (PSP, SMU, ACPI tables, TSEG, and hidden firmware gaps)",
  kres:      "Kernel reserved: e820 system RAM − /proc/meminfo MemTotal (memory reserved for kernel image, initrd, crashkernel dump region)",
  total:     "Installed system RAM: mem_reservation.installed_kib (physical DRAM as reported by SMBIOS / firmware, before any kernel or firmware reservations)",
  nongtt:    "Non-GTT total: installed RAM − GTT total (system memory not reserved for GPU IOMMU mappings; the upper bound on memory available to CPU-side workloads)",
  gttmargin: "Headroom before non-GTT pressure: Non-GTT − (used − GTT). Goes negative when CPU-side usage starts eating into memory the GPU has reserved for GTT.",
  dmabuf:    "dma-buf shared: Σ size of /proc/*/fdinfo dma-buf entries (buffers shared between GPU and other subsystems via the dma-buf framework; counted in both GPU and CPU totals)"
};

// ── External DOM tooltip (can overflow chart canvas boundaries) ──────────────
let _tooltipEl = null;

function clampTooltipPosition(left, top, width, height, margin = 4) {
  const maxLeft = Math.max(margin, window.innerWidth - width - margin);
  const maxTop  = Math.max(margin, window.innerHeight - height - margin);
  return {
    left: Math.min(Math.max(left, margin), maxLeft),
    top:  Math.min(Math.max(top, margin), maxTop),
  };
}

function getTooltipEl() {
  if (!_tooltipEl) {
    _tooltipEl = document.createElement('div');
    Object.assign(_tooltipEl.style, {
      position:      'fixed',
      pointerEvents: 'none',
      zIndex:        '9999',
      background:    '#1c2128',
      border:        '1px solid #30363d',
      borderRadius:  '4px',
      padding:       '6px 8px',
      fontSize:      '11px',
      color:         '#8b949e',
      maxWidth:      '33vw',
      whiteSpace:    'normal',
      overflowWrap:  'anywhere',
      wordBreak:     'break-word',
      textAlign:     'left',
      opacity:       '0',
      transition:    'opacity 0.08s',
    });
    document.body.appendChild(_tooltipEl);
  }
  return _tooltipEl;
}

function externalTooltip({ chart, tooltip }) {
  const el = getTooltipEl();
  if (!tooltip.opacity) { el.style.opacity = '0'; return; }

  const titles    = tooltip.title || [];
  const bodyItems = tooltip.body  || [];

  let html = '';
  if (titles.length) {
    html += '<div style="color:#e6edf3;line-height:1.6">' +
      titles.map(t => `<div>${t}</div>`).join('') + '</div>';
  }
  if (bodyItems.length) {
    if (titles.length) html += '<div style="margin-top:3px;border-top:1px solid #30363d;padding-top:3px">';
    bodyItems.forEach((b, i) => {
      const color = tooltip.labelColors?.[i]?.borderColor ?? '#8b949e';
      b.lines.filter(Boolean).forEach(line => {
        html += `<div><span style="display:inline-block;width:8px;height:8px;background:${color};` +
          `border-radius:1px;margin-right:4px;vertical-align:middle"></span>${line.trim()}</div>`;
      });
      b.after.filter(Boolean).forEach(line => {
        html += `<div style="color:#6e7681;font-size:9px;margin-left:12px">${line.trim()}</div>`;
      });
    });
    if (titles.length) html += '</div>';
  }
  el.innerHTML = html;

  const rect = chart.canvas.getBoundingClientRect();
  const tw   = el.offsetWidth;
  const th   = el.offsetHeight;
  const cx   = rect.left + tooltip.caretX;
  const cy   = rect.top  + tooltip.caretY;

  let left = cx + 12;
  let top  = cy - Math.round(th / 2);
  if (left + tw > window.innerWidth  - 4) left = cx - tw - 12;
  ({ left, top } = clampTooltipPosition(left, top, tw, th));

  el.style.left    = left + 'px';
  el.style.top     = top  + 'px';
  el.style.opacity = '1';
}

const CHART_DEFAULTS = {
  animation: false,
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: {
      labels: { color: '#8b949e', boxWidth: 8, padding: 5, font: { size: 10 } }
    },
    tooltip: { enabled: false },
    annotation: { drawTime: 'afterDraw', annotations: {} }
  },
  layout: { padding: { top: 4, right: 4, bottom: 4, left: 4 } },
  scales: {
    x: {
      type:   'linear',
      ticks:  { display: false },
      grid:   { color: '#21262d' },
      border: { color: '#30363d' }
    },
    y: {
      ticks: { color: '#8b949e', font: { size: 11 } },
      grid:  { color: '#21262d' },
      border: { color: '#30363d' }
    }
  }
};

function cloneDefaults() {
  const cfg = JSON.parse(JSON.stringify(CHART_DEFAULTS));
  cfg.plugins.tooltip.external  = externalTooltip;
  cfg.plugins.tooltip.itemSort  = tooltipItemSort;
  cfg.plugins.legend.labels.filter = (item, data) =>
    data.datasets[item.datasetIndex]?.data?.some(v => Number.isFinite(v));
  return cfg;
}

function tooltipItemSort(a, b) {
  const av = Number.isFinite(a.raw) ? a.raw : -Infinity;
  const bv = Number.isFinite(b.raw) ? b.raw : -Infinity;
  return bv - av;
}

function makeDataset(label, color, data, sourcePath, decimals) {
  return {
    label,
    data,
    sourcePath: sourcePath || null,
    decimals:   decimals  ?? 3,
    borderColor: color,
    backgroundColor: color + '1a',
    fill: true,
    tension: 0.25,
    pointRadius: 0,
    borderWidth: 1.5,
  };
}
