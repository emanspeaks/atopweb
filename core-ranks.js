// ── CPU core performance ranks ────────────────────────────────────────────────

// 16-color categorical palette hand-picked for a dark background. Arranged so
// that consecutive indices land in different hue families (e.g. red→blue→
// yellow→purple) and neighboring cores never share a look-alike tone.
const CORE_COLORS = [
  '#ff6b6b', // red
  '#4dc9f6', // sky blue
  '#ffd93d', // yellow
  '#a78bfa', // violet
  '#3fb950', // green
  '#ff4d94', // pink
  '#40e0d0', // turquoise
  '#ffa500', // orange
  '#388bfd', // blue
  '#a0e85f', // lime
  '#e879f9', // magenta
  '#1dd1a1', // teal
  '#c08968', // tan
  '#5d6dff', // indigo
  '#a0522d', // sienna brown
  '#fb7185', // rose
];
function coreColor(j) { return CORE_COLORS[j % CORE_COLORS.length]; }

function coreLabel(j) {
  const rank = state.coreRanks[j];
  return rank != null ? `C${j} (R#${rank})` : `C${j}`;
}

function fetchCoreRanks() {
  fetch('/api/cpu-ranks')
    .then(r => r.ok ? r.json() : null)
    .then(d => {
      if (d?.ranks?.length) {
        const changed = d.ranks.length !== state.coreRanks.length ||
          d.ranks.some((r, j) => r !== state.coreRanks[j]);
        state.coreRanks = d.ranks;
        if (changed && state.lastDevices) buildDom(state.lastDevices);
      }
    })
    .catch(() => {});
}
