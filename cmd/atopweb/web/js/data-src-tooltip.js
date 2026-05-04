// ── [data-src] hover tooltips (process table cells) ──────────────────────────
function initDataSrcTooltip() {
  document.addEventListener('mouseover', e => {
    const target = e.target.closest('[data-src]');
    if (!target) return;
    const el = getTooltipEl();
    el.innerHTML = `<div style="color:#cdd9e5;font-size:13px">${target.dataset.src}</div>`;
    const tw = el.offsetWidth;
    const th = el.offsetHeight;
    let left = e.clientX + 12;
    let top  = e.clientY - Math.round(th / 2);
    if (left + tw > window.innerWidth  - 4) left = e.clientX - tw - 12;
    ({ left, top } = clampTooltipPosition(left, top, tw, th));
    el.style.left    = left + 'px';
    el.style.top     = top  + 'px';
    el.style.opacity = '1';
  });
  document.addEventListener('mouseout', e => {
    if (!e.target.closest('[data-src]')) return;
    if (e.relatedTarget?.closest('[data-src]')) return;
    getTooltipEl().style.opacity = '0';
  });
}
