// ── Initialization (runs on page load) ───────────────────────────────────────
loadSavedSettings();
initDataSrcTooltip();
initIntervalCtrl();
initPlotWidthCtrl();
initPauseBtn();
initMemSnapBtn();
initStatusBar();
initOverlay();
initMemTreemap();
updateStickyOffset();
fetchPowerLimits();
setInterval(fetchPowerLimits, 300_000);
fetchCoreRanks();
setInterval(fetchCoreRanks, 300_000);
setInterval(fetchConfig, 60_000);
fetchSystem(); // immediate data on load; server pushes updates via WebSocket thereafter
setInterval(saveCache, CACHE_SAVE_MS);
window.addEventListener('beforeunload', saveCache);
connect();
