/**
 * CSS baseline every composition renders under — identical in the preview, thumbnails and the
 * headless renderer, so a template never depends on the host page's stylesheet.
 */
export const COMPOSITION_ATTR = 'data-neon-composition';

const BASELINE_CSS = `[${COMPOSITION_ATTR}], [${COMPOSITION_ATTR}] *, [${COMPOSITION_ATTR}] *::before, [${COMPOSITION_ATTR}] *::after { box-sizing: border-box; }
[${COMPOSITION_ATTR}] { -webkit-font-smoothing: antialiased; text-rendering: geometricPrecision; }`;

export function ensureBaselineStyles(doc: Document = document): void {
  if (doc.getElementById('neon-motion-baseline')) return;
  const style = doc.createElement('style');
  style.id = 'neon-motion-baseline';
  style.textContent = BASELINE_CSS;
  doc.head.appendChild(style);
}
