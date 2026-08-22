/**
 * Inline SVG icons — Momentum-adjacent glyphs drawn by hand so the bundle stays
 * self-contained (BUILD-PLAN.md Phase 6: "no external font/CDN dependencies").
 * Every icon is a plain `currentColor` stroke/fill path; each is a template string
 * assigned via a dedicated `innerHTML` write into a wrapper `<span>` that is never
 * built from attribute-sourced text, so there is no injection surface.
 */

const ICONS: Record<string, string> = {
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5c0 8.284 6.716 15 15 15l2-4-5-2-2 2c-2.5-1-4.5-3-5.5-5.5l2-2-2-5-4 1.5z"/></svg>',
  phoneDecline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5c0 8.284 6.716 15 15 15l2-4-5-2-2 2c-2.5-1-4.5-3-5.5-5.5l2-2-2-5-4 1.5z"/><path d="M3 3l18 18"/></svg>',
  hold: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
  resume: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8V4z"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 11a7 7 0 0 1-14 0"/><path d="M12 18v4"/></svg>',
  micOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 .34 1.36"/><path d="M15.6 15.6A3 3 0 0 1 9 14V9"/><path d="M19 11a7 7 0 0 1-1.34 4.13"/><path d="M5 11a7 7 0 0 0 9.8 6.4"/><path d="M12 18v4"/><path d="M3 3l18 18"/></svg>',
  end: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 15c-3.6 0-6.9-1.1-9.7-2.9-.5-.3-.8-.9-.7-1.5l.5-2.7c.1-.6.6-1.1 1.2-1.2C6 6.2 9 5.7 12 5.7s6 .5 8.7 1.1c.6.1 1.1.6 1.2 1.2l.5 2.7c.1.6-.2 1.2-.7 1.5C18.9 13.9 15.6 15 12 15z"/></svg>',
  transfer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h13l-3-3"/><path d="M20 17H7l3 3"/></svg>',
  dialpad: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="6" cy="6" r="1.6"/><circle cx="12" cy="6" r="1.6"/><circle cx="18" cy="6" r="1.6"/><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/><circle cx="6" cy="18" r="1.6"/><circle cx="12" cy="18" r="1.6"/><circle cx="18" cy="18" r="1.6"/></svg>',
  speaker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9v6h4l5 4V5l-5 4H5z"/><path d="M17 9a4 4 0 0 1 0 6"/></svg>',
  backspace: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l-6 6 6 6h11a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1H9z"/><path d="M14 10l4 4M18 10l-4 4"/></svg>',
};

/** Return an icon's raw SVG markup. Falls back to an empty span for an unknown key. */
export function icon(name: keyof typeof ICONS): string {
  return ICONS[name] ?? '';
}
