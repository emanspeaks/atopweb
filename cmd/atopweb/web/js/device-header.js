// ── Device info header ───────────────────────────────────────────────────────
function updateDeviceInfoHeader(dev) {
  const el = document.getElementById('device-info');
  if (!el) return;
  const info = dev.Info || {};
  const name = info.DeviceName || info['ASIC Name'] || '';
  const asic = info['ASIC Name'] || '';
  const rocm = info['ROCm Version'] || null;

  const nameParts = [];
  if (name) nameParts.push(`<span data-src="devices[0].Info.DeviceName">${name}</span>`);
  if (asic && asic !== name) nameParts.push(`<span data-src="devices[0].Info['ASIC Name']">${asic}</span>`);
  if (rocm) nameParts.push(`<span data-src="devices[0].Info['ROCm Version']">ROCm ${rocm}</span>`);
  const nameStr = nameParts.join('<span class="di-sep"> ◆ </span>');
  const metaHtml = '';

  const specsParts = [];
  const vramTotalMiB = (dev.VRAM ? (dev.VRAM['Total VRAM']?.value ?? dev.VRAM['Total VRAM'] ?? null) : null);
  if (vramTotalMiB != null) {
    const gib = vramTotalMiB / 1024;
    specsParts.push(`<span data-src="devices[0].VRAM['Total VRAM'].value (MiB → GiB)">${gib.toFixed(3)} GiB VRAM</span>`);
  }
  const vramType = info['VRAM Type'] ?? null;
  if (vramType) specsParts.push(`<span data-src="devices[0].Info['VRAM Type']">${vramType}</span>`);
  const bw = info['Memory Bandwidth'] ?? null;
  if (bw != null) specsParts.push(`<span data-src="devices[0].Info['Memory Bandwidth']">${typeof bw === 'number' ? bw.toFixed(3) : bw} GB/s BW</span>`);
  const cu = info['Compute Unit'] ?? info['Compute Units'] ?? null;
  if (cu != null) specsParts.push(`<span data-src="devices[0].Info['Compute Unit']">${cu} CUs</span>`);
  const fp32Raw = v(info, 'Peak FP32') ?? v(info, 'Peak GFLOPS') ?? null;
  const fp32Num = fp32Raw != null ? Number(fp32Raw) : null;
  if (fp32Num != null && !isNaN(fp32Num)) specsParts.push(`<span data-src="devices[0].Info['Peak FP32' || 'Peak GFLOPS'] / 1000">${(fp32Num / 1000).toFixed(3)} TFLOPS</span>`);
  const npuName = info['IPU'] ?? info['NPU'] ?? null;
  if (npuName) specsParts.push(`<span data-src="devices[0].Info['IPU' || 'NPU']">NPU: ${npuName}</span>`);
  const specsHtml = specsParts.length ? `<div class="di-specs">${specsParts.join('<span class="di-sep"> ◆ </span>')}</div>` : '';

  const pl = state.powerLimits;
  let limitsHtml = '';
  const limitParts = [];
  if (pl.stapm_w    != null) limitParts.push(`<span class="di-limit-stapm"  data-src="/api/limits → stapm_w (ryzenadj STAPM LIMIT)">STAPM ${pl.stapm_w.toFixed(3)}W</span>`);
  if (pl.fast_w     != null) limitParts.push(`<span class="di-limit-fast"   data-src="/api/limits → fast_w (ryzenadj FAST PPT LIMIT)">Fast ${pl.fast_w.toFixed(3)}W</span>`);
  if (pl.slow_w     != null) limitParts.push(`<span class="di-limit-slow"   data-src="/api/limits → slow_w (ryzenadj SLOW PPT LIMIT)">Slow ${pl.slow_w.toFixed(3)}W</span>`);
  if (pl.apu_slow_w != null) limitParts.push(`<span class="di-limit-apu-slow" data-src="/api/limits → apu_slow_w (ryzenadj APU SLOW LIMIT)">APU Slow ${pl.apu_slow_w.toFixed(3)}W</span>`);
  if (pl.thm_core_c != null) limitParts.push(`<span class="di-limit-thm-core" data-src="/api/limits → thm_core_c (ryzenadj THM CORE LIMIT)">THM Core ${pl.thm_core_c.toFixed(3)}°C</span>`);
  if (pl.thm_gfx_c  != null) limitParts.push(`<span class="di-limit-thm-gfx"  data-src="/api/limits → thm_gfx_c (ryzenadj THM GFX LIMIT)">THM GFX ${pl.thm_gfx_c.toFixed(3)}°C</span>`);
  if (pl.thm_soc_c  != null) limitParts.push(`<span class="di-limit-thm-soc"  data-src="/api/limits → thm_soc_c (ryzenadj THM SOC LIMIT)">THM SoC ${pl.thm_soc_c.toFixed(3)}°C</span>`);
  if (limitParts.length) {
    limitsHtml = `<div class="di-limits"><span class="di-limit-label">ryzenadj limits:</span> ${limitParts.join(' ◆ ')}</div>`;
  }

  el.innerHTML = (nameStr ? `<div class="di-name">${nameStr}</div>` : '') + metaHtml + specsHtml + limitsHtml;
}
