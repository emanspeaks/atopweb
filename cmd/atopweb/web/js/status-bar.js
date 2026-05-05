// ── Status bar ────────────────────────────────────────────────────────────────
let barRestoreTimer = null;

function appendLog(msg, cls) {
  const log = document.getElementById('status-log');
  if (!log) return;
  const atBottom = log.scrollHeight - log.scrollTop <= log.clientHeight + 4;
  const now = new Date();
  const ts  = now.toLocaleTimeString([], { hour12: false }) + '.' +
              String(now.getMilliseconds()).padStart(3, '0');
  const span = document.createElement('span');
  span.className = 'log-line' + (cls ? ' ' + cls : '');
  span.textContent = `[${ts}]  ${msg}`;
  log.appendChild(span);
  if (atBottom) log.scrollTop = log.scrollHeight;
  const textEl = document.getElementById('status-bar-text');
  if (textEl) {
    textEl.textContent = msg;
    textEl.className = (cls === 'ok' || cls === 'warn' || cls === 'err') ? 'text-' + cls : '';
  }
  const bar = document.getElementById('status-bar');
  if (bar) {
    if (barRestoreTimer) { clearTimeout(barRestoreTimer); barRestoreTimer = null; }
    bar.classList.remove('sev-ok', 'sev-warn', 'sev-err');
    if (cls === 'ok' || cls === 'warn' || cls === 'err') {
      bar.classList.add('sev-' + cls);
      barRestoreTimer = setTimeout(() => {
        bar.classList.remove('sev-ok', 'sev-warn', 'sev-err');
        barRestoreTimer = null;
      }, 5000);
    }
  }
}

function initStatusBar() {
  document.getElementById('status-bar-main').addEventListener('click', () => {
    const bar = document.getElementById('status-bar');
    bar.classList.toggle('expanded');
    if (bar.classList.contains('expanded'))
      document.getElementById('status-log').scrollTop =
        document.getElementById('status-log').scrollHeight;
  });

  const handle = document.getElementById('status-resize-handle');
  let startY = 0, startH = 180;
  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    startY = e.clientY;
    startH = parseInt(getComputedStyle(document.documentElement)
      .getPropertyValue('--log-height'), 10) || 180;
    handle.classList.add('dragging');
    const onMove = ev => {
      const h = Math.max(60, Math.min(500, startH + (startY - ev.clientY)));
      document.documentElement.style.setProperty('--log-height', h + 'px');
    };
    const onUp = () => {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  const bar = document.getElementById('status-bar');
  new ResizeObserver(() => {
    document.body.style.paddingBottom = bar.offsetHeight + 'px';
    updateOverlayPosition();
  }).observe(bar);
}

// ── Sticky card offset ────────────────────────────────────────────────────────
function updateStickyOffset() {
  const groupH = document.querySelector('.sticky-top-group')?.offsetHeight || 0;
  const tabsH  = document.getElementById('tabs')?.offsetHeight  || 0;
  document.documentElement.style.setProperty('--sticky-top', (groupH + tabsH) + 'px');
}
