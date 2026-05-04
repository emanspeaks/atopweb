// ── DOM helpers ──────────────────────────────────────────────────────────────
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls)  e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Escape string for safe insertion into innerHTML (& < > → entities).
const escHtml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

function pushHistory(arr, val) {
  arr.copyWithin(0, 1);
  arr[arr.length - 1] = (val == null || !Number.isFinite(val)) ? NaN : val;
}
