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

// ── Annotation helpers ───────────────────────────────────────────────────────

// Builds one vertical-line annotation for a process start/stop event.
// isCoreChart: label hidden by default, revealed on hover to save space.
function makeEventAnnotation(ev, isCoreChart) {
  const isStart    = ev.type === 'start';
  const lineColor  = isStart ? 'rgba(63,185,80,0.55)' : 'rgba(248,81,73,0.55)';
  const labelColor = isStart ? '#3fb950' : '#f85149';
  const ann = {
    type: 'line',
    xMin: ev.timeMs, xMax: ev.timeMs,
    drawTime: 'afterDraw',
    borderColor: lineColor, borderWidth: 1, borderDash: [3, 2],
    label: {
      display: !isCoreChart,
      content:  ev.pid != null ? [ev.name, `PID ${ev.pid}`] : [ev.name],
      rotation: -90,
      position: 'start',
      yAdjust:  0,
      color:    labelColor,
      font:     { size: 10 },
      backgroundColor: 'rgba(22,27,34,0.85)',
      padding:  { x: 3, y: 2 },
      xAdjust:  -16,
    },
  };
  if (isCoreChart) {
    ann.enter = function(ctx) {
      ctx.chart.options.plugins.annotation.annotations[ctx.id].label.display = true;
      ctx.chart.draw();
    };
    ann.leave = function(ctx) {
      ctx.chart.options.plugins.annotation.annotations[ctx.id].label.display = false;
      ctx.chart.draw();
    };
  }
  return ann;
}

// Keeps stable annotation objects for process events so hover state (label.display)
// survives across ticks.  New events get fresh objects; existing keys are reused.
// Also mutates chart.options.plugins.annotation.annotations in-place so event
// lines are visible without a full setAnnotations call (needed for core charts).
function syncEventAnnotations(chart, events, isCoreChart) {
  const prev = chart._eventAnnotations || {};
  const next = {};
  for (const ev of events) {
    const key = `ev_${ev.timeMs}_${ev.type}`;
    next[key] = prev[key] || makeEventAnnotation(ev, isCoreChart);
  }
  chart._eventAnnotations = next;
  const ann = chart.options.plugins.annotation.annotations;
  for (const k of Object.keys(ann)) if (k.startsWith('ev_')) delete ann[k];
  Object.assign(ann, next);
}

// Returns a min/max annotation object (does not modify the chart).
// Only considers values within the visible time window (times[k] >= windowStart).
// Labels are positioned below min and above max.
// Iterates directly to avoid intermediate array allocations on every tick.
function minMaxAnnotations(times, windowStart, fmt, ...arrays) {
  let minVal = Infinity, maxVal = -Infinity, count = 0;
  for (const arr of arrays) {
    for (let k = 0; k < arr.length; k++) {
      const v = arr[k];
      if (!Number.isFinite(v)) continue;
      if (windowStart != null && (times[k] == null || times[k] < windowStart)) continue;
      if (v < minVal) minVal = v;
      if (v > maxVal) maxVal = v;
      count++;
    }
  }
  if (count < 2) return {};
  const color    = 'rgba(139,148,158,0.6)';
  const fmtA     = fmt ?? (x => x.toFixed(3));
  const labelBase = { color, font: { size: 9 }, backgroundColor: 'rgba(22,27,34,0.92)', borderColor: 'transparent', borderWidth: 0, padding: { x: 3, y: 1 } };
  const out = {};
  out.minLine = {
    type: 'line', yMin: minVal, yMax: minVal, drawTime: 'afterDraw',
    borderColor: color, borderWidth: 1, borderDash: [3, 3],
    label: { ...labelBase, display: true, content: fmtA(minVal), position: 'start', yAdjust: 9 },
  };
  if (maxVal !== minVal) {
    out.maxLine = {
      type: 'line', yMin: maxVal, yMax: maxVal, drawTime: 'afterDraw',
      borderColor: color, borderWidth: 1, borderDash: [3, 3],
      label: { ...labelBase, display: true, content: fmtA(maxVal), position: 'end', yAdjust: -9 },
    };
  }
  return out;
}

function makeLimitLine(val, label, color, unit, position) {
  return {
    type: 'line', yMin: val, yMax: val, drawTime: 'afterDraw',
    borderColor: color, borderWidth: 1, borderDash: [6, 4],
    label: {
      display: true,
      content: `${label} ${val.toFixed(3)}${unit}`,
      position: position ?? 'center',
      color,
      font: { size: 9 },
      backgroundColor: 'rgba(22,27,34,0.85)',
      borderColor: 'transparent',
      borderWidth: 0,
      padding: { x: 4, y: 2 },
    },
  };
}

// Assigns evenly-spaced label positions ("20%", "40%", …) across present
// limit lines so their label backgrounds don't stack when values are close.
function staggerLimitPositions(specs) {
  const present = specs.filter(s => s.val != null);
  const n = present.length;
  if (n === 0) return [];
  const step = 100 / (n + 1);
  return present.map((s, i) => ({ ...s, position: `${Math.round(step * (i + 1))}%` }));
}

function dramBWLimitAnnotation(chart) {
  const max = state.dramMaxBWKiBs;
  if (!max || chart?._showDramMax === false) return {};
  return {
    dramMaxLine: {
      type: 'line', yMin: max, yMax: max, drawTime: 'afterDraw',
      borderColor: '#e3b341', borderWidth: 1, borderDash: [6, 4],
      label: {
        display: true,
        content: `Max Possible ${Math.round(max).toLocaleString()} KiB/s`,
        position: 'end',
        color: '#e3b341',
        font: { size: 9 },
        backgroundColor: 'rgba(22,27,34,0.85)',
        borderColor: 'transparent',
        borderWidth: 0,
        padding: { x: 4, y: 2 },
      },
    },
  };
}

function powerLimitAnnotations() {
  const pl = state.powerLimits;
  const out = {};
  const specs = staggerLimitPositions([
    { key: 'stapLine',    val: pl.stapm_w,    label: 'STAPM',    color: '#e3b341', unit: 'W' },
    { key: 'fastLine',    val: pl.fast_w,     label: 'Fast',     color: '#f85149', unit: 'W' },
    { key: 'slowLine',    val: pl.slow_w,     label: 'Slow',     color: '#3fb950', unit: 'W' },
    { key: 'apuSlowLine', val: pl.apu_slow_w, label: 'APU Slow', color: '#bc8cff', unit: 'W' },
  ]);
  for (const s of specs) out[s.key] = makeLimitLine(s.val, s.label, s.color, s.unit, s.position);
  return out;
}

function temperatureLimitAnnotations() {
  const pl = state.powerLimits;
  const out = {};
  const specs = staggerLimitPositions([
    { key: 'thmCoreLine', val: pl.thm_core_c, label: 'THM Core', color: '#e3b341', unit: '°C' },
    { key: 'thmGfxLine',  val: pl.thm_gfx_c,  label: 'THM GFX',  color: '#f85149', unit: '°C' },
    { key: 'thmSocLine',  val: pl.thm_soc_c,  label: 'THM SoC',  color: '#388bfd', unit: '°C' },
  ]);
  for (const s of specs) out[s.key] = makeLimitLine(s.val, s.label, s.color, s.unit, s.position);
  return out;
}

// VRAM chart gets two ceiling lines: total GPU-addressable memory (VRAM+GTT)
// and total system physical memory. On unified-memory APUs the system RAM
// total already includes the VRAM carve-out, so we use it directly rather
// than summing with VRAM+GTT. Plotted in GiB to match the chart's y-axis.
function memoryLimitAnnotations(h) {
  const out = {};
  const combinedGiB = h.vramMax; // already GiB
  const ramGiB      = state.totalRAMMiB != null ? state.totalRAMMiB / 1024 : null;
  const specs = staggerLimitPositions([
    { key: 'vramGttLine', val: combinedGiB > 0 ? combinedGiB : null,
      label: 'VRAM+GTT', color: '#e3b341', unit: ' GiB' },
    { key: 'physLine',    val: ramGiB,
      label: 'Total Usable Mem', color: '#f85149', unit: ' GiB' },
  ]);
  for (const s of specs) out[s.key] = makeLimitLine(s.val, s.label, s.color, s.unit, s.position);
  return out;
}

function setAnnotations(chart, times, extra, ...arrays) {
  const mm = minMaxAnnotations(times, chart.options.scales.x.min, chart._minMaxFmt ?? null, ...arrays);
  chart.options.plugins.annotation.annotations = { ...mm, ...extra };

  // Always re-apply %-of-range grace. Range covers data min/max AND any
  // line-type annotation values (limit lines) so that explicitly-set limits
  // are never pushed off-screen by a narrow data range.
  const opts = chart.options.scales.y;
  let lo = Infinity, hi = -Infinity;
  if (mm.minLine) { lo = Math.min(lo, mm.minLine.yMin); hi = Math.max(hi, mm.minLine.yMin); }
  if (mm.maxLine) { lo = Math.min(lo, mm.maxLine.yMax); hi = Math.max(hi, mm.maxLine.yMax); }
  for (const ann of Object.values(extra || {})) {
    if (ann?.type === 'line' && Number.isFinite(ann.yMin)) {
      lo = Math.min(lo, ann.yMin);
      hi = Math.max(hi, ann.yMin);
    }
  }
  if (Number.isFinite(lo) && Number.isFinite(hi)) {
    const range = (hi - lo) || Math.max(Math.abs(hi), 1);
    const pad   = range * 0.18;
    const floor = chart._yFloorHint;
    const ceil  = chart._yCeilingHint;
    opts.suggestedMin = floor != null ? Math.min(lo - pad, floor) : lo - pad;
    opts.suggestedMax = ceil  != null ? Math.max(hi + pad, ceil)  : hi + pad;
  }
}
