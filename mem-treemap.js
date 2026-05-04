// ── Memory treemap overlay ────────────────────────────────────────────────────
const MEM_COLORS = {
  vramFree:   'rgba(76,175,80,0.08)',
  vramVis:    '#2e7d32',
  vramInv:    '#aed581',
  gtt:        '#80cbc4',
  drmCpu:     '#00695c',
  anonGpu:    '#43a047',
  anonOther:  '#ff7043',
  shmem:      '#1e88e5',
  cached:     '#ff9800',
  buf:        '#00bcd4',
  sreclm:     '#fdd835',
  sunrec:     '#5c6bc0',
  vmalloc:    '#ffa726',
  kstack:     '#7b1fa2',
  ptables:    '#8bc34a',
  netbuf:     '#e91e63',
  drvpg:      '#4caf50',
  free:       'rgba(255,255,255,0.06)',
  kres:       '#37474f',
  fw:         '#616161',
};

let _tmKeyMap  = new Map(); // key → primary SVG rect element for hover cross-link
let _tmHovered = false;    // true while mouse is over the overlay — suppresses full redraws

function buildMemSegs(devIdx) {
  const sysInfo = state.systemInfo;
  if (!sysInfo) return [];

  const mk     = sysInfo.meminfo_kb     ?? {};
  const memRes = sysInfo.mem_reservation ?? {};
  const drmMem = sysInfo.drm_mem         ?? {};
  const totalKB = (mk.MemTotal ?? ((sysInfo.total_ram_mib ?? 0) * 1024)) || 1;

  const vramTotalKiB   = drmMem.vram_total_kib    ?? 0;
  const vramUsedKiB    = drmMem.vram_used_kib     ?? 0;
  const visVramUsedKiB = drmMem.vis_vram_used_kib ?? vramUsedKiB;
  const vramInvUsedKiB = Math.max(0, vramUsedKiB - visVramUsedKiB);
  const vramFreeKiB    = Math.max(0, vramTotalKiB - vramUsedKiB);
  const gttKB          = drmMem.gtt_used_kib      ?? 0;
  const drmCpuKB       = drmMem.total_cpu_kib     ?? 0;
  const anonKB         = mk.AnonPages    ?? 0;
  const gpuAnonKB      = sysInfo.gpu_anon_pss_kb  ?? 0;
  const anonOtherKB    = Math.max(0, anonKB - gpuAnonKB);
  const shmemKB        = mk.Shmem        ?? 0;
  const bufKB          = mk.Buffers      ?? 0;
  const cachedKB       = Math.max(0, (mk.Cached ?? 0) - shmemKB);
  const sreclmKB       = mk.SReclaimable ?? 0;
  const sunrecKB       = mk.SUnreclaim   ?? 0;
  const vmallocKB      = mk.VmallocUsed  ?? 0;
  const kstackKB       = mk.KernelStack  ?? 0;
  const ptablesKB      = (mk.PageTables ?? 0) + (mk.SecPageTables ?? 0);
  const netbufKB       = sysInfo.sock_mem_kb ?? 0;
  const freeKB         = mk.MemFree      ?? 0;
  const namedKB        = gttKB + drmCpuKB + anonKB + shmemKB + cachedKB + bufKB
                       + sreclmKB + sunrecKB + vmallocKB + kstackKB + ptablesKB + netbufKB;
  const drvpgKB        = Math.max(0, totalKB - freeKB - namedKB);
  const kernelResKiB   = Math.max(0, (memRes.system_ram_kib ?? 0) - totalKB);
  const fwReservedKiB  = Math.max(0, (sysInfo.firmware_reserved_kib ?? 0) - vramTotalKiB);

  const segs = [];
  const add = (key, label, kib, color, desc) => {
    segs.push({ key, label, kib, color, desc });
  };

  // GPU process anon — grouped as a folder so all PID blocks stay contiguous.
  const gpuProcs = (drmMem.processes ?? [])
    .filter(p => (p.pss_anon_kib ?? 0) > 0)
    .sort((a, b) => (b.pss_anon_kib ?? 0) - (a.pss_anon_kib ?? 0));
  if (gpuProcs.length > 0) {
    const children = gpuProcs.map(p => {
      const kib    = p.pss_anon_kib ?? 0;
      const thpKib = p.anon_huge_pages_kib ?? 0;
      const thpPct = kib > 0 ? Math.round(thpKib / kib * 100) : 0;
      const note   = thpPct >= 80 ? ' — likely UMA model' : thpPct < 20 ? ' — heap/stack dominant' : '';
      return { key: `pid-${p.pid}`, label: `${p.comm || '?'} (${p.pid})`, kib,
               color: MEM_COLORS.anonGpu, cmdline: p.cmdline || '',
               desc: `${p.comm || '?'} (PID ${p.pid}): ${(kib/1048576).toFixed(3)} GiB Pss_Anon `
                   + `(${(thpKib/1048576).toFixed(3)} GiB THP, ${thpPct}%${note})` };
    });
    const totalGpuKib = children.reduce((s, c) => s + c.kib, 0);
    if (totalGpuKib > 0)
      segs.push({ key: 'anonGpu', label: 'G-Apps', kib: totalGpuKib,
                  color: MEM_COLORS.anonGpu, desc: MEM_TIPS.anonGpu, children });
  }

  add('vramFree',  'VRAM Free',    vramFreeKiB,    MEM_COLORS.vramFree,  MEM_TIPS.vramFree);
  add('vramVis',   'VRAM Vis',     visVramUsedKiB, MEM_COLORS.vramVis,   MEM_TIPS.vramVis);
  add('vramInv',   'VRAM Inv',     vramInvUsedKiB, MEM_COLORS.vramInv,   MEM_TIPS.vramInv);
  add('gtt',       'GTT Used',     gttKB,          MEM_COLORS.gtt,       MEM_TIPS.gtt);
  add('drmCpu',    'DRM CPU',      drmCpuKB,       MEM_COLORS.drmCpu,    MEM_TIPS.drmCpu);
  add('anonOther', 'Apps',         anonOtherKB,    MEM_COLORS.anonOther, MEM_TIPS.anonOther);
  add('shmem',     'Shared Mem',   shmemKB,        MEM_COLORS.shmem,     MEM_TIPS.shmem);
  add('cached',    'File Cache',   cachedKB,       MEM_COLORS.cached,    MEM_TIPS.cached);
  add('buf',       'Buffers',      bufKB,          MEM_COLORS.buf,       MEM_TIPS.buf);
  add('sreclm',    'Slab-Rec',     sreclmKB,       MEM_COLORS.sreclm,    MEM_TIPS.sreclm);
  add('sunrec',    'Slab-Unrec',   sunrecKB,       MEM_COLORS.sunrec,    MEM_TIPS.sunrec);
  add('vmalloc',   'Vmalloc',      vmallocKB,      MEM_COLORS.vmalloc,   MEM_TIPS.vmalloc);
  add('kstack',    'K-Stack',      kstackKB,       MEM_COLORS.kstack,    MEM_TIPS.kstack);
  add('ptables',   'Page Tables',  ptablesKB,      MEM_COLORS.ptables,   MEM_TIPS.ptables);
  add('netbuf',    'Net Buffers',  netbufKB,       MEM_COLORS.netbuf,    MEM_TIPS.netbuf);
  add('drvpg',     'Driver Pages', drvpgKB,        MEM_COLORS.drvpg,     MEM_TIPS.drvpg);
  add('free',      'Free',         freeKB,         MEM_COLORS.free,      MEM_TIPS.free);
  add('kres',      'K-Reserved',   kernelResKiB,   MEM_COLORS.kres,      MEM_TIPS.kres);
  add('fw',        'Firmware',     fwReservedKiB,  MEM_COLORS.fw,        MEM_TIPS.fw);

  return segs.sort((a, b) => b.kib - a.kib);
}

function _tmWorstAR(items, s) {
  const ra = items.reduce((sum, it) => sum + it.area, 0);
  if (ra === 0 || s === 0) return Infinity;
  const t = ra / s;
  let worst = 0;
  for (const it of items) {
    const e  = it.area / ra * s;
    const ar = e > t ? e / t : t / e;
    if (ar > worst) worst = ar;
  }
  return worst;
}

// Squarified treemap (Bruls et al. 2000). Each strip runs along the short side
// of the remaining rectangle; items in a strip share the perpendicular dimension
// and vary along the short side, keeping aspect ratios close to 1.
function squarifyLayout(items, x, y, w, h) {
  if (!items.length || w < 0.5 || h < 0.5) return [];
  const total = items.reduce((s, it) => s + it.kib, 0);
  if (total === 0) return [];

  const normed  = items.map(it => ({ ...it, area: it.kib / total * w * h }));
  const results = [];
  let rem = normed.slice();
  let rx = x, ry = y, rw = w, rh = h;

  while (rem.length > 0 && rw >= 0.5 && rh >= 0.5) {
    const isWide = rw >= rh;
    const s = isWide ? rh : rw;

    let row = [rem[0]];
    for (let i = 1; i < rem.length; i++) {
      const cand = [...row, rem[i]];
      if (_tmWorstAR(cand, s) <= _tmWorstAR(row, s)) row = cand;
      else break;
    }

    const ra        = row.reduce((sum, it) => sum + it.area, 0);
    const thickness = ra / s;
    let cur = 0;
    for (const it of row) {
      const extent = it.area / ra * s;
      if (isWide) results.push({ item: it, x: rx,       y: ry + cur, w: thickness, h: extent });
      else        results.push({ item: it, x: rx + cur, y: ry,       w: extent,    h: thickness });
      cur += extent;
    }

    if (isWide) { rx += thickness; rw -= thickness; }
    else        { ry += thickness; rh -= thickness; }
    rem = rem.slice(row.length);
  }

  return results;
}

function _tmAddLeaf(svg, ns, item, x, y, w, h, GAP) {
  const g = document.createElementNS(ns, 'g');
  g.dataset.key = item.key;
  if (item.desc) g.dataset.src = item.cmdline
    ? `${item.desc}<br>\`${escHtml(item.cmdline)}\``
    : item.desc;

  const isPid       = item.key.startsWith('pid-');
  const strokeIdle  = isPid ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0)';
  const strokeHover = 'rgba(255,255,255,0.9)';

  const rect = document.createElementNS(ns, 'rect');
  rect.setAttribute('x',            x + GAP);
  rect.setAttribute('y',            y + GAP);
  rect.setAttribute('width',        Math.max(0, w - GAP * 2));
  rect.setAttribute('height',       Math.max(0, h - GAP * 2));
  rect.setAttribute('fill',         item.color);
  rect.setAttribute('stroke',       strokeIdle);
  rect.setAttribute('stroke-width', '1.5');
  if (isPid) rect.setAttribute('stroke-dasharray', '3 2');
  g.appendChild(rect);

  if (w > 38 && h > 14) {
    const maxChars = Math.floor(w / 7);
    const label    = item.label.length > maxChars ? item.label.slice(0, maxChars - 1) + '…' : item.label;
    const fontSize = Math.min(13, Math.max(9, Math.min(w * 0.18, h * 0.35)));
    const text = document.createElementNS(ns, 'text');
    text.setAttribute('x',                  x + w / 2);
    text.setAttribute('y',                  y + h / 2);
    text.setAttribute('text-anchor',        'middle');
    text.setAttribute('dominant-baseline',  'middle');
    text.setAttribute('fill',               '#e6edf3');
    text.setAttribute('font-size',          fontSize);
    text.setAttribute('font-family',        'system-ui, sans-serif');
    text.setAttribute('pointer-events',     'none');
    text.textContent = label;
    g.appendChild(text);
  }

  g.addEventListener('mouseenter', () => rect.setAttribute('stroke', strokeHover));
  g.addEventListener('mouseleave', () => rect.setAttribute('stroke', strokeIdle));
  svg.appendChild(g);
  _tmKeyMap.set(item.key, rect);
}

function renderMemTreemap(devIdx) {
  const mapEl   = document.getElementById('mem-tm-map');
  const tbodyEl = document.getElementById('mem-tm-tbody');
  if (!mapEl || !tbodyEl) return;

  const W = mapEl.offsetWidth;
  const H = mapEl.offsetHeight;
  if (W < 4 || H < 4) return;

  _tmKeyMap.clear();
  const segs = buildMemSegs(devIdx);

  // Treemap uses only items with area; legend uses all (including zeros).
  const tmSegs = segs.map(s => {
    if (!s.children) return s.kib > 0 ? s : null;
    const kids = s.children.filter(c => c.kib > 0);
    return kids.length > 0 ? { ...s, children: kids } : null;
  }).filter(Boolean);

  const rects = squarifyLayout(tmSegs, 0, 0, W, H);

  const ns  = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width',  W);
  svg.setAttribute('height', H);

  const GAP = 1;

  for (const { item, x, y, w, h } of rects) {
    if (item.children && item.children.length > 0) {
      // Group: background rect for hover, children fill the full inner area.
      const bg = document.createElementNS(ns, 'rect');
      bg.setAttribute('x',            x + GAP);
      bg.setAttribute('y',            y + GAP);
      bg.setAttribute('width',        Math.max(0, w - GAP * 2));
      bg.setAttribute('height',       Math.max(0, h - GAP * 2));
      bg.setAttribute('fill',         item.color);
      bg.setAttribute('stroke',       'rgba(255,255,255,0)');
      bg.setAttribute('stroke-width', '2');
      svg.appendChild(bg);
      _tmKeyMap.set(item.key, bg);

      bg.addEventListener('mouseenter', () => bg.setAttribute('stroke', 'rgba(255,255,255,0.7)'));
      bg.addEventListener('mouseleave', () => bg.setAttribute('stroke', 'rgba(255,255,255,0)'));

      const innerX = x + GAP, innerY = y + GAP;
      const innerW = w - GAP * 2, innerH = h - GAP * 2;
      if (innerW > 1 && innerH > 1) {
        const childRects = squarifyLayout(item.children, innerX, innerY, innerW, innerH);
        for (const cr of childRects)
          _tmAddLeaf(svg, ns, cr.item, cr.x, cr.y, cr.w, cr.h, GAP);
      }
    } else {
      _tmAddLeaf(svg, ns, item, x, y, w, h, GAP);
    }
  }

  mapEl.innerHTML = '';
  mapEl.appendChild(svg);

  let html = '';
  for (const seg of segs) {
    if (seg.children && seg.children.length > 0) {
      html += `<tr class="mem-tm-group-hdr" data-key="${seg.key}">
        <td><span class="mem-tm-swatch" style="background:${seg.color}"></span></td>
        <td>${seg.label}</td>
        <td class="mem-tm-kib">${seg.kib.toLocaleString()}</td>
        <td class="mem-tm-desc">${seg.desc}</td>
      </tr>`;
      for (const child of seg.children) {
        const cmdlineHtml = child.cmdline
          ? `<span class="mem-tm-cmdline">\`${escHtml(child.cmdline)}\`</span>`
          : '';
        html += `<tr class="mem-tm-child-hdr" data-key="${child.key}">
          <td><span class="mem-tm-swatch mem-tm-indent" style="background:${child.color}"></span></td>
          <td class="mem-tm-indent">◆ ${child.label}${cmdlineHtml}</td>
          <td class="mem-tm-kib">${child.kib.toLocaleString()}</td>
          <td class="mem-tm-desc">${child.desc}</td>
        </tr>`;
      }
    } else {
      html += `<tr data-key="${seg.key}">
        <td><span class="mem-tm-swatch" style="background:${seg.color}"></span></td>
        <td>${seg.label}</td>
        <td class="mem-tm-kib">${seg.kib.toLocaleString()}</td>
        <td class="mem-tm-desc">${seg.desc}</td>
      </tr>`;
    }
  }
  tbodyEl.innerHTML = html;

  tbodyEl.querySelectorAll('tr[data-key]').forEach(tr => {
    const key  = tr.dataset.key;
    tr.addEventListener('mouseenter', () => {
      const el = _tmKeyMap.get(key);
      if (el) el.setAttribute('stroke', 'rgba(255,255,255,0.7)');
    });
    tr.addEventListener('mouseleave', () => {
      const el = _tmKeyMap.get(key);
      if (el) el.setAttribute('stroke', 'rgba(255,255,255,0)');
    });
  });
}

// Update only the KiB value cells without rebuilding the SVG or re-sorting.
// Called each tick when paused so digitals stay live.
function updateMemTreemapValues(devIdx) {
  const tbodyEl = document.getElementById('mem-tm-tbody');
  if (!tbodyEl) return;
  const segs = buildMemSegs(devIdx);
  const kibMap = new Map();
  for (const seg of segs) {
    kibMap.set(seg.key, seg.kib);
    if (seg.children) for (const c of seg.children) kibMap.set(c.key, c.kib);
  }
  tbodyEl.querySelectorAll('tr[data-key]').forEach(tr => {
    const kib = kibMap.get(tr.dataset.key);
    if (kib != null) {
      const cell = tr.querySelector('.mem-tm-kib');
      if (cell) cell.textContent = kib.toLocaleString();
    }
  });
}

function updateMemTreemapPosition() {
  const overlay = document.getElementById('mem-treemap-overlay');
  if (!overlay || overlay.hidden) return;
  const anchorEl = document.querySelector('.gpu-panel.active .cards')
                ?? document.querySelector('header');
  const topPx    = anchorEl ? anchorEl.getBoundingClientRect().bottom : 0;
  const statusH  = document.getElementById('status-bar')?.offsetHeight || 0;
  overlay.style.top    = Math.round(topPx) + 'px';
  overlay.style.bottom = statusH + 'px';
}

function openMemTreemap(devIdx) {
  const overlay = document.getElementById('mem-treemap-overlay');
  overlay.hidden = false;
  document.getElementById('mem-tm-title').textContent =
    state.n > 1 ? `Memory Map — GPU ${devIdx}` : 'Memory Map';
  state.memTreemapDev = devIdx;
  updateMemTreemapPosition();
  requestAnimationFrame(() => renderMemTreemap(devIdx));
}

function closeMemTreemap() {
  document.getElementById('mem-treemap-overlay').hidden = true;
  state.memTreemapDev = null;
  _tmHovered = false;
}

function initMemTreemap() {
  document.getElementById('mem-tm-close').addEventListener('click', closeMemTreemap);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.getElementById('mem-treemap-overlay').hidden)
      closeMemTreemap();
  });
  const overlay = document.getElementById('mem-treemap-overlay');
  overlay.addEventListener('mouseenter', () => { _tmHovered = true; });
  overlay.addEventListener('mouseleave', () => {
    _tmHovered = false;
    // Do one full redraw now that hover has ended so layout catches up.
    if (state.memTreemapDev != null && !state.paused)
      renderMemTreemap(state.memTreemapDev);
  });

  new ResizeObserver(() => {
    if (state.memTreemapDev != null) {
      updateMemTreemapPosition();
      renderMemTreemap(state.memTreemapDev);
    }
  }).observe(document.getElementById('mem-tm-map'));
  window.addEventListener('scroll', updateMemTreemapPosition, { passive: true });
  window.addEventListener('resize', updateMemTreemapPosition);
}
