// ── Power limits ─────────────────────────────────────────────────────────────
function fetchPowerLimits() {
  fetch('/api/limits')
    .then(r => r.json())
    .then(d => {
      const pl  = state.powerLimits;
      const nxt = {
        stapm_w:    d.stapm_w    ?? null,
        fast_w:     d.fast_w     ?? null,
        slow_w:     d.slow_w     ?? null,
        apu_slow_w: d.apu_slow_w ?? null,
        thm_core_c: d.thm_core_c ?? null,
        thm_gfx_c:  d.thm_gfx_c  ?? null,
        thm_soc_c:  d.thm_soc_c  ?? null,
      };
      const wasUninitialized = Object.keys(nxt).every(k => pl[k] === null);
      const changed = Object.keys(nxt).some(k => nxt[k] !== pl[k]);
      Object.assign(pl, nxt);
      // Refresh header once limits are loaded (device may already be shown).
      if (state.hist.length > 0 && state.lastDev0) updateDeviceInfoHeader(state.lastDev0);
      if (!changed || wasUninitialized) return;
      const parts = [];
      if (pl.stapm_w    != null) parts.push(`STAPM ${pl.stapm_w.toFixed(3)}W`);
      if (pl.fast_w     != null) parts.push(`Fast ${pl.fast_w.toFixed(3)}W`);
      if (pl.slow_w     != null) parts.push(`Slow ${pl.slow_w.toFixed(3)}W`);
      if (pl.apu_slow_w != null) parts.push(`APU Slow ${pl.apu_slow_w.toFixed(3)}W`);
      if (pl.thm_core_c != null) parts.push(`THM Core ${pl.thm_core_c.toFixed(3)}°C`);
      if (pl.thm_gfx_c  != null) parts.push(`THM GFX ${pl.thm_gfx_c.toFixed(3)}°C`);
      if (pl.thm_soc_c  != null) parts.push(`THM SoC ${pl.thm_soc_c.toFixed(3)}°C`);
      if (parts.length) appendLog(`Power limits: ${parts.join('  ')}`, 'warn');
    })
    .catch(() => {});
}
