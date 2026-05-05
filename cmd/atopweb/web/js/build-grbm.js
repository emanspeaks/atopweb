function buildGRBMSection(i, h) {
  const grbmSec = el('div', 'grbm-section');
  if (localStorage.getItem('atopweb.grbmCollapsed') !== 'false') grbmSec.classList.add('collapsed');
  const grbmTitle = el('div', 'section-title grbm-section-title', 'GPU Performance Counters');
  grbmTitle.addEventListener('click', () => {
    grbmSec.classList.toggle('collapsed');
    localStorage.setItem('atopweb.grbmCollapsed', grbmSec.classList.contains('collapsed'));
  });
  grbmSec.appendChild(grbmTitle);
  const grbmGrid = el('div', 'grbm-grid');

  const buildPCCol = (colTitle, keys, prefix, histArr, color, barCls, srcObj) => {
    const col = el('div', 'grbm-col');
    col.appendChild(el('div', 'grbm-col-title', colTitle));
    keys.forEach((key, ki) => {
      const label = key;
      const item = el('div', 'grbm-item');
      item.innerHTML = `
        <div class="grbm-item-header">
          <span class="grbm-item-label" data-src="devices[${i}].${srcObj}['${key}']">${label}</span>
          <span class="grbm-item-val" id="${prefix}-val-${i}-${ki}">—</span>
        </div>
        <div class="grbm-bar-wrap">
          <div class="grbm-bar ${barCls}" id="${prefix}-bar-${i}-${ki}"></div>
        </div>`;

      const chartWrap = el('div', 'grbm-chart-wrap');
      item.appendChild(chartWrap);

      const chartKey = `${i}-${prefix}-${ki}`;
      item.addEventListener('click', () => {
        if (grbmSec.classList.contains('collapsed')) return;
        item.classList.toggle('expanded');
        if (item.classList.contains('expanded')) {
          // Lazy-create the chart on first expand.
          if (!state.charts[chartKey]) {
            const canvas = el('canvas');
            chartWrap.appendChild(canvas);
            const pcCfg = cloneDefaults();
            pcCfg.scales.x.ticks.stepSize = xStepSize(state.timeWidthMs);
            pcCfg.scales.y.min = 0;
            pcCfg.scales.y.max = 100;
            pcCfg.plugins.legend.display = false;
            pcCfg.plugins.tooltip.callbacks = makeChartCallbacks(h);
            pcCfg.scales.y.ticks.callback = fmtTick;
            pcCfg.scales.y.ticks.font = { size: 9 };
            pcCfg.scales.y.ticks.maxTicksLimit = 3;
            state.charts[chartKey] = new Chart(canvas, {
              type: 'line',
              data: {
                labels: h.times,
                datasets: [{
                  label: key,
                  data: histArr[ki],
                  sourcePath: `devices[${i}].${srcObj}['${key}']`,
                  borderColor: color,
                  backgroundColor: color + '1a',
                  fill: true,
                  tension: 0.25,
                  pointRadius: 0,
                  borderWidth: 1.5,
                }],
              },
              options: pcCfg,
            });
          }
          state.charts[chartKey].resize();
          state.charts[chartKey].update('none');
        }
      });

      col.appendChild(item);
    });
    return col;
  };

  grbmGrid.appendChild(buildPCCol('GRBM',  GRBM_KEYS,  'grbm',  h.grbm,  '#e85d04', 'grbm-orange', 'GRBM'));
  grbmGrid.appendChild(buildPCCol('GRBM2', GRBM2_KEYS, 'grbm2', h.grbm2, '#388bfd', 'grbm-blue',   'GRBM2'));
  grbmSec.appendChild(grbmGrid);
  return grbmSec;
}
