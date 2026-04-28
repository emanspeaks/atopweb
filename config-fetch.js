// ── Config fetch (version check + subtitle refresh) ───────────────────────────
function fetchConfig() {
  fetch('/api/config')
    .then(r => r.json())
    .then(cfg => {
      if (!localStorage.getItem('atopweb.intervalMs')) {
        state.intervalMs = cfg.interval_ms;
        document.getElementById('interval-input').value = cfg.interval_ms;
      }
      state.showGttMargin = !!cfg.show_gtt_margin;
      applyGttMarginVisibility();
      const newVer = cfg.atopweb_version || '';
      const subSpans = [];
      if (cfg.amdgpu_top_version) subSpans.push(`<span data-src="/api/config → amdgpu_top_version">${cfg.amdgpu_top_version}</span>`);
      if (cfg.kernel_version)     subSpans.push(`<span data-src="/api/config → kernel_version (/proc/sys/kernel/osrelease)">Linux v${cfg.kernel_version}</span>`);
      if (cfg.nixos_version)      subSpans.push(`<span data-src="/api/config → nixos_version (/etc/os-release VERSION_ID)">NixOS v${cfg.nixos_version}</span>`);
      if (cfg.nixos_generation)   subSpans.push(`<span data-src="/api/config → nixos_generation (/nix/var/nix/profiles/system symlink)">Nix Profile Gen ${cfg.nixos_generation}</span>`);
      if (cfg.cpu_gov)            subSpans.push(`<span data-src="/api/config → cpu_gov (/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor)">CPU Gov: ${cfg.cpu_gov}</span>`);
      const subtitleEl = document.getElementById('page-subtitle');
      subtitleEl.innerHTML = subSpans.join('<span class="subtitle-sep"> ◆ </span>');
      if (cfg.total_ram_mib)    state.totalRAMMiB   = cfg.total_ram_mib;
      if (cfg.dram_max_bw_kibs) state.dramMaxBWKiBs = cfg.dram_max_bw_kibs;
      if (state.serverVersion === null && newVer) {
        state.serverVersion = newVer;                   // record version this page was loaded with
        document.getElementById('page-title').textContent = `atopweb v${newVer}`;
      } else if (state.serverVersion && newVer && newVer !== state.serverVersion) {
        showVersionBanner(state.serverVersion, newVer); // server updated while page is open
      }

      const snap = {
        kernel_version:     cfg.kernel_version     || null,
        nixos_version:      cfg.nixos_version      || null,
        nixos_generation:   cfg.nixos_generation   ?? null,
        cpu_gov:            cfg.cpu_gov            || null,
        amdgpu_top_version: cfg.amdgpu_top_version || null,
        show_gtt_margin:    !!cfg.show_gtt_margin,
      };
      const lc = state.lastConfig;
      if (lc === null) {
        // First load — log a one-time snapshot of all present values.
        const parts = [];
        if (snap.amdgpu_top_version) parts.push(snap.amdgpu_top_version);
        if (snap.kernel_version)     parts.push(`Linux v${snap.kernel_version}`);
        if (snap.nixos_version)      parts.push(`NixOS v${snap.nixos_version}`);
        if (snap.nixos_generation != null) parts.push(`Nix Gen ${snap.nixos_generation}`);
        if (snap.cpu_gov)            parts.push(`CPU Gov: ${snap.cpu_gov}`);
        if (parts.length) appendLog(`System: ${parts.join('  ')}`);
      } else {
        const chk = (label, prev, next) => {
          if (next !== prev) appendLog(`${label} changed: ${prev ?? '—'} → ${next ?? '—'}`, 'warn');
        };
        chk('Linux kernel',    lc.kernel_version,     snap.kernel_version);
        chk('NixOS',           lc.nixos_version,      snap.nixos_version);
        chk('Nix generation',  lc.nixos_generation,   snap.nixos_generation);
        chk('CPU governor',    lc.cpu_gov,             snap.cpu_gov);
        chk('amdgpu_top',      lc.amdgpu_top_version, snap.amdgpu_top_version);
        chk('Show GTT margin', lc.show_gtt_margin,    snap.show_gtt_margin);
      }
      state.lastConfig = snap;
    })
    .catch(() => {});
}

function showVersionBanner(loadedVer, serverVer) {
  const banner = document.getElementById('version-banner');
  const msg    = document.getElementById('version-banner-msg');
  if (!banner || !msg) return;
  msg.textContent =
    `atopweb updated on server: v${loadedVer} → v${serverVer}. Refresh the page to run the new version.`;
  banner.hidden = false;
  appendLog(`atopweb server updated: v${loadedVer} → v${serverVer} — refresh to update`, 'warn');
}
