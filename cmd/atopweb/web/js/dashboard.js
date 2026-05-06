'use strict';
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
setInterval(saveCache, CACHE_SAVE_MS);
window.addEventListener('beforeunload', saveCache);
connectSSE();
