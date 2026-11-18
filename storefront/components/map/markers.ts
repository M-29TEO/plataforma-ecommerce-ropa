/** Marcadores HTML (sin imágenes externas). */

export function pinElement(color = '#b4532a', label?: string): HTMLDivElement {
  const el = document.createElement('div');
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<svg width="34" height="44" viewBox="0 0 34 44"><path d="M17 43s15-14.6 15-26A15 15 0 1 0 2 17c0 11.4 15 26 15 26z" fill="${color}" stroke="#fff" stroke-width="2"/><circle cx="17" cy="17" r="6" fill="#fff"/></svg>`;
  if (label) el.title = label;
  return el;
}

export function storeElement(): HTMLDivElement {
  const el = document.createElement('div');
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = 'width:28px;height:28px;border-radius:8px;background:#1f1b16;color:#fbf8f4;display:flex;align-items:center;justify-content:center;font-size:15px;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.3)';
  el.textContent = '🏬';
  return el;
}

/** Motorizado: círculo con flecha que gira con el rumbo (heading). */
export function riderElement(): { el: HTMLDivElement; setHeading(deg: number | null): void } {
  const el = document.createElement('div');
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = 'width:44px;height:44px;position:relative';
  el.innerHTML = `
    <span style="position:absolute;inset:0;border-radius:50%;background:rgba(180,83,42,.25);animation:rider-pulse 2s ease-out infinite"></span>
    <span style="position:absolute;inset:8px;border-radius:50%;background:#b4532a;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;font-size:14px">🛵</span>
    <svg data-arrow width="44" height="44" viewBox="0 0 44 44" style="position:absolute;inset:0;transition:transform .6s"><path d="M22 1 L27 9 L17 9 Z" fill="#1f1b16"/></svg>`;
  if (!document.getElementById('rider-pulse-style')) {
    const style = document.createElement('style');
    style.id = 'rider-pulse-style';
    style.textContent = '@keyframes rider-pulse{0%{transform:scale(.6);opacity:1}100%{transform:scale(1.4);opacity:0}}';
    document.head.appendChild(style);
  }
  const arrow = el.querySelector<SVGElement>('[data-arrow]')!;
  return {
    el,
    setHeading(deg) {
      arrow.style.display = deg === null ? 'none' : '';
      if (deg !== null) arrow.style.transform = `rotate(${deg}deg)`;
    },
  };
}
