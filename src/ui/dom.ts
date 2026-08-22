/**
 * Tiny DOM-construction helpers shared by every view in src/ui. Deliberately not a
 * framework: every view is "clear + rebuild this small subtree on render", which is
 * cheap at this widget's scale and keeps the "UI has no business logic" rule
 * trivially auditable (no diffing, no virtual DOM, no hidden state machine).
 *
 * `el()` never accepts pre-built HTML strings for text content — only `textContent`
 * — so nothing derived from attribute/SDK-sourced strings (caller-ID names, error
 * messages, agent ids) can ever be interpreted as markup.
 */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Set an SVG icon's markup on a wrapper span. The markup comes only from icons.ts. */
export function iconSpan(svgMarkup: string, className = 'vw-icon-wrap'): HTMLSpanElement {
  const span = el('span', className);
  span.innerHTML = svgMarkup; // fixed, module-authored SVG only — never attribute-sourced text
  return span;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}
