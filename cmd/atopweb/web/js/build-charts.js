function buildCharts(i, h) {
  const chartGrid = el('div', 'charts');

  const chartDefs = [
    {
      key: 'temp', title: 'Temperature (°C)', height: 150, yMax: null,
      noYMin: true,
      datasets: () => [
        makeDataset('Edge',     '#40e0d0', h.tempE,   `devices[${i}].Sensors['Edge Temperature']`),
        makeDataset('CPU Tctl', '#fb7185', h.tempC,   `devices[${i}].Sensors['CPU Tctl']`),
        makeDataset('SoC',      '#bc8cff', h.tempS,   `devices[${i}].gpu_metrics.temperature_soc / 100`),
        makeDataset('GFX',      '#388bfd', h.tempGfx, `devices[${i}].gpu_metrics.temperature_gfx / 100`),
        makeDataset('Hotspot',  '#e879f9', h.tempHot, `devices[${i}].gpu_metrics.temperature_hotspot / 100`),
        makeDataset('Mem',      '#ffffff', h.tempMem, `devices[${i}].gpu_metrics.temperature_mem / 100`),
      ]
    },
    {
      key: 'gfx-clk', title: 'Clocks (MHz)', height: 150, yMax: null,
      datasets: () => [
        makeDataset('SCLK',     '#e88504', h.sclk,    `devices[${i}].Sensors['GFX_SCLK']`),
        makeDataset('MCLK',     '#388bfd', h.mclk,    `devices[${i}].Sensors['GFX_MCLK']`),
        makeDataset('FCLK',     '#e7241a', h.fclk,    `devices[${i}].Sensors['FCLK']`),
        makeDataset('FCLK avg', '#00b4d8', h.fclkAvg, `devices[${i}].gpu_metrics.average_fclk_frequency`),
        makeDataset('SoC Clk',  '#e3cb41', h.socClk,  `devices[${i}].gpu_metrics.average_socclk_frequency`),
        makeDataset('VCN Clk',  '#3fb950', h.vclk,    `devices[${i}].gpu_metrics.average_vclk_frequency`),
      ]
    },
    {
      key: 'fan', title: 'Fan Speed (RPM)', height: 150, yMax: null,
      noYMin: true,
      datasets: () => [
        makeDataset('Fan',            '#ffffff', h.fan,    `/api/system hwmon (first active fan)`),
      ]
    },
    {
      key: 'core-pwr', title: 'CPU Core Power (W)', height: 150, yMax: null,
      coreData: () => h.corePwr, coreUnit: 'W',
      datasets: () => Array.from({length: 16}, (_, j) => ({
        label: `CPU ${coreLabel(j)}`,
        data: h.corePwr[j],
        sourcePath: `devices[${i}].gpu_metrics.average_core_power[${j}] / 1000`,
        borderColor: coreColor(j),
        backgroundColor: 'transparent',
        fill: false,
        tension: 0.25,
        pointRadius: 0,
        borderWidth: 1,
      }))
    },
    {
      key: 'power', title: 'Package Power (W)', height: 150, yMax: null,
      datasets: () => [
        makeDataset('GPU', '#40e0d0', h.pwr,    `devices[${i}].Sensors['Average Power']`),
        makeDataset('CPU Cores Total',     '#388bfd', h.cpuPwr, `devices[${i}].gpu_metrics.average_all_core_power / 1000`),
        makeDataset('NPU',           '#bc8cff', h.npuPwr, `devices[${i}].gpu_metrics.average_ipu_power / 1000`),
      ]
    },
    {
      key: 'dram-bw', title: 'DRAM Bandwidth (KiB/s)', height: 150, yMax: null,
      tickFmt: v => typeof v !== 'number' ? String(v) : Math.round(v).toLocaleString(),
      minMaxFmt: v => Math.round(v).toLocaleString(),
      datasets: () => [
        Object.assign(makeDataset('Reads',  '#3fb950', h.dramReads,  `mem_snapshot.dram_read_bps ÷ 1024 (KiB/s, from amd_df Σ local_or_remote_socket_read_data_beats_dram_* × 32 / elapsed)`, 0), {commas: true}),
        Object.assign(makeDataset('Writes', '#f85149', h.dramWrites, `mem_snapshot.dram_write_bps ÷ 1024 (KiB/s, from amd_df Σ local_or_remote_socket_write_data_beats_dram_* × 32 / elapsed)`, 0), {commas: true}),
      ]
    },
    {
      key: 'activity', title: 'GPU Activity (%)', height: 150, yMax: 100,
      datasets: () => [
        makeDataset('GFX',    '#e85d04', h.gfx,   `devices[${i}].gpu_activity['GFX']`),
        makeDataset('Memory', '#388bfd', h.mem,   `devices[${i}].gpu_activity['Memory']`),
        makeDataset('Media',  '#bc8cff', h.media, `devices[${i}].gpu_activity['MediaEngine']`),
      ]
    },
    {
      key: 'vram', title: 'VRAM + GTT Usage (GiB)', height: 150, yMax: null,
      tickFmt: v => (typeof v === 'number' ? v.toFixed(3) : String(v)),
      datasets: () => [
        makeDataset('Total', '#3fb950', h.vram,    `devices[${i}].VRAM: Total VRAM Usage + Total GTT Usage`, 3),
        makeDataset('VRAM',  '#388bfd', h.vramOnly, `devices[${i}].VRAM['Total VRAM Usage']`,               3),
        makeDataset('GTT',   '#bc8cff', h.gttOnly,  `devices[${i}].VRAM['Total GTT Usage']`,                3),
      ]
    },
    {
      key: 'npu-act', title: 'NPU Tile Activity (%)', height: 150, yMax: 100,
      coreData: () => h.npuBusy, coreUnit: '%',
      datasets: () => Array.from({length: 8}, (_, j) => ({
        label: `NPU Tile ${j}`,
        data: h.npuBusy[j],
        sourcePath: `devices[${i}].npu_metrics.npu_busy[${j}]`,
        borderColor: coreColor(j),
        backgroundColor: 'transparent',
        fill: false,
        tension: 0.25,
        pointRadius: 0,
        borderWidth: 1,
      }))
    },
    {
      key: 'npu-clk', title: 'NPU Clocks (MHz)', height: 150, yMax: null,
      datasets: () => [
        makeDataset('NPU Clk',    '#bc8cff', h.npuClk,   `devices[${i}].npu_metrics.npuclk_freq`),
        makeDataset('MP-NPU Clk', '#8b949e', h.npuMpClk, `devices[${i}].npu_metrics.mpnpuclk_freq`),
      ]
    },
    {
      key: 'npu-bw', title: 'NPU Bandwidth (MB/s)', height: 150, yMax: null,
      datasets: () => [
        makeDataset('Reads',  '#3fb950', h.npuReads,  `devices[${i}].npu_metrics.npu_reads`),
        makeDataset('Writes', '#f85149', h.npuWrites, `devices[${i}].npu_metrics.npu_writes`),
      ]
    },
    {
      key: 'voltage', title: 'Voltage (mV)', height: 150, yMax: null,
      datasets: () => [
        makeDataset('VDDGFX', '#e3b341', h.vddgfx, `devices[${i}].Sensors['VDDGFX']`),
        makeDataset('VDDNB',  '#8b949e', h.vddnb,  `devices[${i}].Sensors['VDDNB']`),
      ]
    },
  ];

  chartDefs.forEach(def => {
    const chartKey = `${i}-${def.key}`;
    const box    = el('div', 'chart-box' + (def.wide ? ' chart-wide' : ''));
    box.id = `chart-box-${chartKey}`;
    box.style.display = 'none'; // revealed once data arrives
    const titleDiv  = el('div', 'chart-title');
    const titleText = el('span', 'chart-title-text', def.title);
    titleText.addEventListener('click', () => openOverlay(chartKey, def.title));
    titleDiv.appendChild(titleText);
    if (def.key === 'dram-bw') {
      const ctrl = el('label', 'chart-title-ctrl');
      const chk  = document.createElement('input');
      chk.type    = 'checkbox';
      chk.checked = true;
      chk.addEventListener('change', () => {
        const c = state.charts[chartKey];
        if (c) c._showDramMax = chk.checked;
        if (state.overlayChartKey === chartKey && state.overlayChart)
          state.overlayChart._showDramMax = chk.checked;
      });
      ctrl.appendChild(chk);
      ctrl.appendChild(document.createTextNode(' Max limit'));
      titleDiv.appendChild(ctrl);
    }
    const wrap   = el('div');
    wrap.style.height = (def.height || 160) + 'px';
    const canvas = el('canvas');
    wrap.appendChild(canvas);
    box.appendChild(titleDiv);
    box.appendChild(wrap);
    chartGrid.appendChild(box);

    const cfg = cloneDefaults();
    cfg.scales.x.ticks.stepSize = xStepSize(state.timeWidthMs);
    if (!def.noYMin) cfg.scales.y.suggestedMin = 0;
    if (def.yMax != null) cfg.scales.y.suggestedMax = def.yMax;
    if (def.hideLegend) cfg.plugins.legend.display = false;
    cfg.plugins.tooltip.callbacks = def.coreData
      ? makeCoreChartCallbacks(h, def.coreData, def.coreUnit)
      : makeChartCallbacks(h);
    cfg.scales.y.ticks.callback = def.tickFmt ?? fmtTick;

    const chart = new Chart(canvas, {
      type: 'line',
      data: { labels: h.times, datasets: def.datasets() },
      options: cfg,
      plugins: def.coreData ? [verticalLinePlugin] : [],
    });
    chart._yFloorHint   = def.noYMin ? null : 0;
    chart._yCeilingHint = def.yMax ?? null;
    chart._minMaxFmt    = def.minMaxFmt ?? null;
    if (def.key === 'dram-bw') chart._showDramMax = true;
    state.charts[chartKey] = chart;
  });

  return chartGrid;
}
