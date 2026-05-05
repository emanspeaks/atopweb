function buildMemoryBar(i) {
  const memSec = el('div', 'mem-section');
  memSec.innerHTML = `
    <div class="mem-bar-outer" data-dev="${i}">
      <div class="mem-bar-vram-part" id="mem-vram-part-${i}">
        <div class="mem-seg mem-seg-vram-free" id="mem-vram-free-${i}" data-src="${MEM_TIPS.vramFree}"></div>
        <div class="mem-seg mem-seg-vram-inv"  id="mem-vram-inv-${i}"  data-src="${MEM_TIPS.vramInv}"></div>
        <div class="mem-seg mem-seg-vram-vis"  id="mem-vram-vis-${i}"  data-src="${MEM_TIPS.vramVis}"></div>
      </div>
      <div class="mem-bar-sys-part">
        <div class="mem-seg mem-seg-gtt-used" id="mem-gtt-used-${i}" data-src="${MEM_TIPS.gtt}"></div>
        <div class="mem-seg mem-seg-drmcpu"   id="mem-drmcpu-${i}"   data-src="${MEM_TIPS.drmCpu}"></div>
        <div class="mem-seg mem-seg-anon-gpu"   id="mem-anon-gpu-${i}"   data-src="${MEM_TIPS.anonGpu}"></div>
        <div class="mem-seg mem-seg-anon-other" id="mem-anon-other-${i}" data-src="${MEM_TIPS.anonOther}"></div>
        <div class="mem-seg mem-seg-shmem"    id="mem-shmem-${i}"    data-src="${MEM_TIPS.shmem}"></div>
        <div class="mem-seg mem-seg-cached"   id="mem-cached-${i}"   data-src="${MEM_TIPS.cached}"></div>
        <div class="mem-seg mem-seg-buf"      id="mem-buf-${i}"      data-src="${MEM_TIPS.buf}"></div>
        <div class="mem-seg mem-seg-sreclm"   id="mem-sreclm-${i}"   data-src="${MEM_TIPS.sreclm}"></div>
        <div class="mem-seg mem-seg-sunrec"   id="mem-sunrec-${i}"   data-src="${MEM_TIPS.sunrec}"></div>
        <div class="mem-seg mem-seg-vmalloc"  id="mem-vmalloc-${i}"  data-src="${MEM_TIPS.vmalloc}"></div>
        <div class="mem-seg mem-seg-kstack"   id="mem-kstack-${i}"   data-src="${MEM_TIPS.kstack}"></div>
        <div class="mem-seg mem-seg-ptables"  id="mem-ptables-${i}"  data-src="${MEM_TIPS.ptables}"></div>
        <div class="mem-seg mem-seg-netbuf"   id="mem-netbuf-${i}"   data-src="${MEM_TIPS.netbuf}"></div>
        <div class="mem-seg mem-seg-drvpg"    id="mem-drvpg-${i}"    data-src="${MEM_TIPS.drvpg}"></div>
        <div class="mem-seg mem-seg-free"     id="mem-free-${i}"     data-src="${MEM_TIPS.free}"></div>
      </div>
      <div class="mem-seg mem-seg-fw"   id="mem-fw-${i}"   data-src="${MEM_TIPS.fw}"></div>
      <div class="mem-seg mem-seg-kres" id="mem-kres-${i}" data-src="${MEM_TIPS.kres}"></div>
    </div>
    <div class="mem-legend">
      <span class="mem-legend-item" data-src="${MEM_TIPS.vramFree}"><span class="mem-lswatch mem-lswatch-vram-free"></span>V-free: <span class="mem-legend-val" id="mem-lbl-vram-free-${i}">—</span></span>
      <span class="mem-legend-item" data-src="${MEM_TIPS.vramVis}"><span class="mem-lswatch mem-lswatch-vram-vis"></span>V-vis: <span class="mem-legend-val" id="mem-lbl-vram-vis-${i}">—</span></span>
      <span class="mem-legend-item" data-src="${MEM_TIPS.vramInv}"><span class="mem-lswatch mem-lswatch-vram-inv"></span>V-invis: <span class="mem-legend-val" id="mem-lbl-vram-inv-${i}">—</span></span>
      <span class="mem-legend-item" data-src="${MEM_TIPS.gtt}"><span class="mem-lswatch mem-lswatch-gtt"></span>GTT: <span class="mem-legend-val" id="mem-lbl-gtt-${i}">—</span></span>
      <span class="mem-legend-item" data-src="${MEM_TIPS.drmCpu}"><span class="mem-lswatch mem-lswatch-drmcpu"></span>DRM: <span class="mem-legend-val" id="mem-lbl-drmcpu-${i}">—</span></span>
      <span class="mem-legend-item" data-src="${MEM_TIPS.anonGpu}"><span class="mem-lswatch mem-lswatch-anon-gpu"></span>G-Apps: <span class="mem-legend-val" id="mem-lbl-anon-gpu-${i}">—</span></span>
      <span class="mem-legend-item" data-src="${MEM_TIPS.anonOther}"><span class="mem-lswatch mem-lswatch-anon-other"></span>Apps: <span class="mem-legend-val" id="mem-lbl-anon-other-${i}">—</span></span>
      <span class="mem-legend-item" data-src="${MEM_TIPS.shmem}"><span class="mem-lswatch mem-lswatch-shmem"></span>Shm: <span class="mem-legend-val" id="mem-lbl-shmem-${i}">—</span></span>
      <span class="mem-legend-item" data-src="${MEM_TIPS.cached}"><span class="mem-lswatch mem-lswatch-cached"></span>FCache: <span class="mem-legend-val" id="mem-lbl-cached-${i}">—</span></span>
      <span class="mem-legend-item" data-src="${MEM_TIPS.buf}"><span class="mem-lswatch mem-lswatch-buf"></span>Bufs: <span class="mem-legend-val" id="mem-lbl-buf-${i}">—</span></span>
      <span class="mem-legend-item" data-src="${MEM_TIPS.sreclm}"><span class="mem-lswatch mem-lswatch-sreclm"></span>SReclm: <span class="mem-legend-val" id="mem-lbl-sreclm-${i}">—</span></span>
      <span class="mem-legend-item" data-src="${MEM_TIPS.sunrec}"><span class="mem-lswatch mem-lswatch-sunrec"></span>SUnreclm: <span class="mem-legend-val" id="mem-lbl-sunrec-${i}">—</span></span>
      <span class="mem-legend-item" data-src="${MEM_TIPS.vmalloc}"><span class="mem-lswatch mem-lswatch-vmalloc"></span>Vmalloc: <span class="mem-legend-val" id="mem-lbl-vmalloc-${i}">—</span></span>
      <span class="mem-legend-item" data-src="${MEM_TIPS.kstack}"><span class="mem-lswatch mem-lswatch-kstack"></span>KStack: <span class="mem-legend-val" id="mem-lbl-kstack-${i}">—</span></span>
      <span class="mem-legend-item" data-src="${MEM_TIPS.ptables}"><span class="mem-lswatch mem-lswatch-ptables"></span>PgTbls: <span class="mem-legend-val" id="mem-lbl-ptables-${i}">—</span></span>
      <span class="mem-legend-item" data-src="${MEM_TIPS.netbuf}"><span class="mem-lswatch mem-lswatch-netbuf"></span>NetBufs: <span class="mem-legend-val" id="mem-lbl-netbuf-${i}">—</span></span>
      <span class="mem-legend-item" data-src="${MEM_TIPS.drvpg}"><span class="mem-lswatch mem-lswatch-drvpg"></span>DrvPgs: <span class="mem-legend-val" id="mem-lbl-drvpg-${i}">—</span></span>
      <span class="mem-legend-item" data-src="${MEM_TIPS.free}"><span class="mem-lswatch mem-lswatch-free"></span>Free: <span class="mem-legend-val" id="mem-lbl-free-${i}">—</span></span>
      <span class="mem-legend-item" data-src="${MEM_TIPS.fw}"><span class="mem-lswatch mem-lswatch-fw"></span>FW: <span class="mem-legend-val" id="mem-lbl-fw-${i}">—</span></span>
      <span class="mem-legend-item" data-src="${MEM_TIPS.kres}"><span class="mem-lswatch mem-lswatch-kres"></span>KRes: <span class="mem-legend-val" id="mem-lbl-kres-${i}">—</span></span>
      <span class="mem-legend-total">
        <span class="mem-legend-item" data-src="${MEM_TIPS.total}">Installed: <span class="mem-legend-val" id="mem-lbl-total-${i}">—</span> GiB</span>
        <span class="mem-gttmargin-group" id="mem-gttmargin-group-${i}">
          <span class="mem-legend-sep">◆</span>
          <span class="mem-legend-item" data-src="${MEM_TIPS.nongtt}">Non-GTT: <span class="mem-legend-val" id="mem-lbl-nongtt-${i}">—</span> GiB</span>
          <span class="mem-legend-sep">◆</span>
          <span class="mem-legend-item" data-src="${MEM_TIPS.gttmargin}">GTT Margin: <span class="mem-legend-val" id="mem-lbl-gttmargin-${i}">—</span> GiB</span>
        </span>
      </span>
    </div>
  `;
  return memSec;
}
