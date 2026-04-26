// ── Persist user settings across reloads (localStorage) ──────────────────────
function loadSavedSettings() {
  const iv  = parseInt(localStorage.getItem('atopweb.intervalMs'),      10);
  const pw  = parseInt(localStorage.getItem('atopweb.timeWidthMs'),      10);
  const cpw = parseInt(localStorage.getItem('atopweb.coreTimeWidthMs'), 10);
  if (!isNaN(iv)  && iv  >= 50 && iv  <= 60000) {
    state.intervalMs = iv;
    document.getElementById('interval-input').value  = iv;
    fetch(`/api/interval?ms=${iv}`, { method: 'POST' }).catch(() => {});
  }
  if (!isNaN(pw)  && pw  >= 5000 && pw  <= 3600000) {
    state.timeWidthMs = pw;
    document.getElementById('plotwidth-input').value = pw / 1000;
  }
  if (!isNaN(cpw) && cpw >= 5000 && cpw <= 3600000) {
    state.coreTimeWidthMs = cpw;
    document.getElementById('corewidth-input').value = cpw / 1000;
  }
}
