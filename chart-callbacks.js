// ── Chart tooltip / tick helpers ─────────────────────────────────────────────
function makeChartCallbacks(h) {
  return {
    title(items) {
      const idx = items[0]?.dataIndex;
      if (idx == null) return '';
      const ts = h.times[idx];
      if (ts == null) return '';
      const t   = new Date(ts);
      const abs = t.toLocaleTimeString([], { hour12: false }) + '.' +
                  String(t.getMilliseconds()).padStart(3, '0');
      const ago = ((Date.now() - ts) / 1000).toFixed(3) + 's ago';
      return [abs, ago];
    },
    label(item) {
      if (item.raw == null) return null;
      const raw = Number(item.raw);
      if (isNaN(raw)) return ` ${item.dataset.label}: ${String(item.raw)}`;
      if (item.dataset.commas) return ` ${item.dataset.label}: ${Math.round(raw).toLocaleString()}`;
      const dec = item.dataset.decimals ?? 3;
      return ` ${item.dataset.label}: ${Number.isInteger(raw) ? String(raw) : raw.toFixed(dec)}`;
    },
    afterLabel(item) {
      const sp = item.dataset.sourcePath;
      return sp ? `  ${sp}` : null;
    },
  };
}

function fmtTick(v) {
  if (typeof v !== 'number') return String(v);
  return Number.isInteger(v) ? String(v) : v.toFixed(3);
}

// Draws a vertical cursor line on hover for charts where per-series tooltips
// are too noisy (e.g. 16-line core charts).
const verticalLinePlugin = {
  id: 'verticalLine',
  afterDraw(chart) {
    const active = chart.tooltip._active;
    if (!active || !active.length) return;
    const ctx = chart.ctx;
    const x = active[0].element.x;
    const { top, bottom } = chart.scales.y;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(139,148,158,0.4)';
    ctx.stroke();
    ctx.restore();
  }
};

// Tooltip for 16-line core charts: timestamp + instantaneous min/max only,
// no per-series breakdown.  getArrays is a function returning the 2-D data
// array so the closure stays fresh after history shifts.
function makeCoreChartCallbacks(h, getArrays, unit) {
  return {
    title(items) {
      const idx = items[0]?.dataIndex;
      if (idx == null) return [];
      const lines = [];
      const ts = h.times[idx];
      if (ts != null) {
        const t = new Date(ts);
        lines.push(
          t.toLocaleTimeString([], { hour12: false }) + '.' + String(t.getMilliseconds()).padStart(3, '0'),
          ((Date.now() - ts) / 1000).toFixed(3) + 's ago',
        );
      }
      const vals = getArrays().map(arr => arr[idx]).filter(Number.isFinite);
      if (vals.length) {
        lines.push(`Min: ${Math.min(...vals).toFixed(3)} ${unit}`);
        lines.push(`Max: ${Math.max(...vals).toFixed(3)} ${unit}`);
      }
      return lines;
    },
    label: () => null,
  };
}
