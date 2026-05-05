function buildStatCards(i) {
  const cards = el('div', 'cards');
  const cardDefs = [
    // Permanent system cards (fed by /api/system, never idle-hidden).
    { id: `c-cpu-${i}`,    cls: 'c-cpu',    label: 'CPU Usage',          unit: '%',   bar: true,  permanent: true, src: `/api/system → cpu_usage_pct (/proc/stat delta)` },
    // GPU cards
    { id: `c-gfx-${i}`,    cls: 'c-gfx',    label: 'GFX',                unit: '%',   bar: true,  src: `devices[${i}].gpu_activity.GFX.value` },
    { id: `c-media-${i}`,  cls: 'c-media',  label: 'Media',              unit: '%',   bar: true,  src: `devices[${i}].gpu_activity.MediaEngine.value` },
    { id: `c-vmem-${i}`,   cls: 'c-vmem',   label: 'GPU Mem Capacity',   unit: '%',   bar: true,  src: `(devices[${i}].VRAM['Total VRAM Usage'] + devices[${i}].VRAM['Total GTT Usage']) / (devices[${i}].VRAM['Total VRAM'] + devices[${i}].VRAM['Total GTT']) × 100` },
    { id: `c-vram-${i}`,   cls: 'c-vram',   label: 'BIOS Reserved VRAM', unit: 'GiB', bar: true,  split: true, srcU: `devices[${i}].VRAM['Total VRAM Usage'].value (MiB → GiB)`, srcT: `devices[${i}].VRAM['Total VRAM'].value (MiB → GiB)` },
    { id: `c-gtt-${i}`,    cls: 'c-gtt',    label: 'GTT',                unit: 'GiB', bar: true,  split: true, srcU: `devices[${i}].VRAM['Total GTT Usage'].value (MiB → GiB)`,  srcT: `devices[${i}].VRAM['Total GTT'].value (MiB → GiB)` },
    { id: `c-sclk-${i}`,   cls: 'c-sclk',   label: 'GFX Clock',          unit: 'MHz', bar: false, src: `devices[${i}].Sensors.GFX_SCLK.value` },
    { id: `c-fclk-${i}`,   cls: 'c-fclk',   label: 'Avg FCLK (Fabric Clock)', unit: 'MHz', bar: false, src: `devices[${i}].gpu_metrics.average_fclk_frequency` },
    { id: `c-mclk-${i}`,   cls: 'c-mclk',   label: 'Mem Clock',          unit: 'MHz', bar: false, src: `devices[${i}].Sensors.GFX_MCLK.value` },
    { id: `c-vddgfx-${i}`, cls: 'c-vddgfx', label: 'VDDGFX',             unit: 'mV',  bar: false, src: `devices[${i}].Sensors.VDDGFX.value` },
    { id: `c-vddnb-${i}`,  cls: 'c-vddnb',  label: 'VDDNB',              unit: 'mV',  bar: false, src: `devices[${i}].Sensors.VDDNB.value` },
    { id: `c-etmp-${i}`,   cls: 'c-etmp',   label: 'Edge Temp',          unit: '°C',  bar: false, src: `devices[${i}].Sensors['Edge Temperature'].value` },
    { id: `c-cputmp-${i}`, cls: 'c-cputmp', label: 'CPU Tctl',           unit: '°C',  bar: false, src: `devices[${i}].Sensors['CPU Tctl'].value` },
    { id: `c-pwr-${i}`,    cls: 'c-pwr',    label: 'GPU Power',          unit: 'W',   bar: false, src: `devices[${i}].Sensors['Average Power' || 'Socket Power' || 'Input Power'].value` },
    // Permanent system cards (fed by /api/system, never idle-hidden).
    // { id: `c-ppt-${i}`,    cls: 'c-ppt',    label: 'Package Power Tracking', unit: 'W',   bar: false, permanent: true },
    { id: `c-fan-${i}`,    cls: 'c-fan',    label: 'Fan Speed',          unit: 'RPM', bar: false, permanent: true, src: `/api/system → fans[0].value` },
    { id: `c-uptime-${i}`, cls: 'c-uptime', label: 'Uptime',             unit: '',    bar: false, permanent: true, src: `/api/system → uptime_sec` },
  ];

  cardDefs.forEach(def => {
    const card = el('div', `card ${def.cls}`);
    // Permanent cards are always visible; others hide until data arrives.
    card.style.display = def.permanent ? '' : 'none';
    // Split cards: id lives on the card div (no single span owns def.id).
    // scheduleRender finds the card via getElementById(def.id).closest('.card'),
    // which works because the card div itself has the class and the id.
    if (def.split) card.id = def.id;
    const valHtml = def.split
      ? `<span class="card-value" id="${def.id}-u" data-src="${def.srcU}">—</span><span class="card-value-sep"> / </span><span class="card-value" id="${def.id}-t" data-src="${def.srcT}">—</span>`
      : `<span class="card-value" id="${def.id}"${def.src ? ` data-src="${def.src}"` : ''}>—</span>`;
    card.innerHTML = `
      <div class="card-label">${def.label}</div>
      <div>${valHtml}<span class="card-unit">${def.unit}</span></div>
      ${def.bar ? `<div class="card-bar-wrap"><div class="card-bar" id="${def.id}-bar"></div></div>` : ''}
    `;
    cards.appendChild(card);
    state.cardLastData[def.id] = def.permanent ? Date.now() : 0;
  });
  return cards;
}
