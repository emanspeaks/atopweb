'use strict';
// ── DOM helpers ──────────────────────────────────────────────────────────────
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls)  e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Escape string for safe insertion into innerHTML (& < > → entities).
const escHtml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Escape string for safe use as an HTML attribute value.
const escAttr = s => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');

// Keyed DOM update for PID overlay bars inside the memory bar segments.
// Updates width and tooltip in-place rather than replacing innerHTML each tick,
// so the target element survives from mousedown to mouseup and click fires reliably.
//   container  — the parent flex element (e.g. vramVisEl, gpuAppsEl)
//   procs      — array of process objects, already sorted descending by usage
//   totalKiB   — denominator for width percentages
//   cls        — full CSS class string for each child div
//   kibFn      — (p) => kib value for this segment
//   tipFn      — (p, kib) => HTML string for data-src tooltip
function syncPidOverlay(container, procs, totalKiB, cls, kibFn, tipFn) {
  const existing = new Map();
  for (const child of container.children) {
    if (child.dataset.pid != null) existing.set(child.dataset.pid, child);
  }
  const live = new Set();
  procs.forEach((p, idx) => {
    const pidStr = String(p.pid);
    live.add(pidStr);
    const kib = kibFn(p);
    const pct = totalKiB > 0 ? kib / totalKiB * 100 : 0;
    let div = existing.get(pidStr);
    if (!div) {
      div = document.createElement('div');
      div.className = cls;
      div.dataset.pid = pidStr;
      div.textContent = p.pid;
    }
    div.style.width = pct + '%';
    div.setAttribute('data-src', escAttr(tipFn(p, kib)));
    const ref = container.children[idx];
    if (ref !== div) container.insertBefore(div, ref ?? null);
  });
  for (const [pid, div] of existing) {
    if (!live.has(pid)) div.remove();
  }
}

function setConnStatus(status, label) {
  document.getElementById('conn-dot').className = 'conn-dot ' + status;
  document.getElementById('conn-label').textContent = label;
  document.body.classList.toggle('data-stale', status !== 'connected');
}

function setShutdownBadge(msg) {
  const badge = document.getElementById('shutdown-badge');
  if (!badge) return;
  if (msg) {
    badge.textContent = '⚠ ' + msg;
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

// ── Update helpers ───────────────────────────────────────────────────────────
function v(obj, key) {
  if (!obj || obj[key] == null) return null;
  const entry = obj[key];
  if (typeof entry === 'object' && 'value' in entry) return entry.value;
  if (typeof entry === 'number') return entry;
  return null;
}

function fmt(val, decimals) {
  if (val == null) return '—';
  return decimals != null ? val.toFixed(decimals) : String(Math.round(val));
}

function fmtKib(val) {
  if (val == null) return '—';
  return Math.round(val).toLocaleString();
}

function setCard(id, value, decimals) {
  const e = document.getElementById(id);
  if (!e) return;
  e.textContent = fmt(value, decimals);
  if (value != null && Number.isFinite(value)) state.cardLastData[id] = Date.now();
}

function setBar(id, pct) {
  const bar = document.getElementById(id + '-bar');
  if (bar) bar.style.width = (pct == null ? 0 : Math.min(100, Math.max(0, pct))) + '%';
}

// Append a value to a circular history buffer (see state.js makeBuf).
// Most pushes are O(1).  Once per `size` pushes we slide the last `size`
// values back to position 0 with a single copyWithin (one O(size) op
// instead of O(size) per push).
function pushHistory(b, val) {
  b.buf[b.head++] = (val == null || !Number.isFinite(val)) ? NaN : val;
  if (b.head >= b.buf.length) {
    b.buf.copyWithin(0, b.size, b.buf.length);
    b.head = b.size;
  }
}

// View the latest `size` values as a contiguous typed-array slice.  Cheap —
// no copy.  The reference becomes stale after the next pushHistory; callers
// that hand the view to long-lived consumers (Chart.js datasets) must refresh
// before each render.
function bufView(b) { return b.buf.subarray(b.head - b.size, b.head); }
function bufLast(b) { return b.buf[b.head - 1]; }
