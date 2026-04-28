function buildCoreFreqGrid(i, h) {
  const coreFreqGrid = el('div', 'charts-cores');
  for (let j = 0; j < 16; j++) {
    const box      = el('div', 'chart-box');
    const titleDiv = el('div', 'chart-title');
    const titleText = el('span', 'chart-title-text', `${coreLabel(j)} Clocks (MHz)`);
    titleText.addEventListener('click', () => openOverlay(`${i}-cpu-core-${j}`, `${coreLabel(j)} Clocks (MHz)`));
    titleDiv.appendChild(titleText);
    const wrap   = el('div');
    wrap.style.height = '156px';
    const canvas = el('canvas');
    wrap.appendChild(canvas);
    box.appendChild(titleDiv);
    box.appendChild(wrap);
    coreFreqGrid.appendChild(box);

    const coreCfg = cloneDefaults();
    coreCfg.scales.x.ticks.stepSize = xStepSize(state.coreTimeWidthMs);
    coreCfg.scales.y.min = 0;
    coreCfg.scales.y.max = 6000;
    coreCfg.scales.x.grid = { color: '#21262d' };
    coreCfg.scales.y.grid = { display: true, color: 'rgba(48,54,61,0.8)' };
    coreCfg.plugins.legend.display  = true;
    coreCfg.plugins.legend.position = 'top';
    coreCfg.plugins.legend.align    = 'end';
    coreCfg.plugins.legend.labels   = {
      color: '#8b949e', font: { size: 9 },
      boxWidth: 14, boxHeight: 2, padding: 3,
      generateLabels: (chart) => chart.data.datasets.map((ds, k) => ({
        text:          ds._shortLabel || ds.label,
        fillStyle:     ds.borderColor,
        strokeStyle:   ds.borderColor,
        fontColor:     '#8b949e',
        lineWidth:     ds.borderWidth || 1.5,
        lineDash:      ds.borderDash  || [],
        hidden:        !chart.isDatasetVisible(k),
        datasetIndex:  k,
      })),
    };
    coreCfg.plugins.tooltip.callbacks = makeChartCallbacks({ times: h.coreTimes });
    coreCfg.scales.y.ticks.callback = fmtTick;
    coreCfg.scales.y.ticks.font = { size: 9 };
    coreCfg.scales.y.ticks.maxTicksLimit = 7;
    coreCfg.scales.y.ticks.stepSize = 1000;

    state.charts[`${i}-cpu-core-${j}`] = new Chart(canvas, {
      type: 'line',
      data: {
        labels: h.coreTimes,
        datasets: [
          {
            label: 'Scaling',
            data: h.cpuScalingClk[j],
            sourcePath: `devices[${i}].Sensors['CPU Core freq'][${j}].cur_freq`,
            borderColor: coreColor(j),
            backgroundColor: 'transparent',
            fill: false,
            tension: 0.25,
            pointRadius: 0,
            borderWidth: 1.5,
          },
          {
            label: 'System Mgmt Unit',
            _shortLabel: 'SMU',
            data: h.coreClk[j],
            sourcePath: `devices[${i}].gpu_metrics.current_coreclk[${j}]`,
            borderColor: '#ffffff',
            backgroundColor: 'transparent',
            fill: false,
            tension: 0.25,
            pointRadius: 0,
            borderWidth: 1.5,
            borderDash: [3, 3],
          },
        ],
      },
      options: coreCfg,
    });
  }
  return coreFreqGrid;
}
