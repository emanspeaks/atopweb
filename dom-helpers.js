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
