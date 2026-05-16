const buildVariant = (() => {
  try {
    return import.meta.env?.VITE_VARIANT || 'full';
  } catch {
    return 'full';
  }
})();

const ALLOWED_STORED_VARIANTS = new Set(['tech', 'localtech', 'full', 'finance', 'happy', 'commodity']);

export const SITE_VARIANT: string = (() => {
  if (typeof window === 'undefined') return buildVariant;

  const isTauri = '__TAURI_INTERNALS__' in window || '__TAURI__' in window;
  if (isTauri) {
    // Desktop build is pinned to one VITE_VARIANT — it must win over stale web localStorage.
    if (buildVariant !== 'full') return buildVariant;
    const stored = localStorage.getItem('worldmonitor-variant');
    if (stored && ALLOWED_STORED_VARIANTS.has(stored)) return stored;
    return buildVariant;
  }

  const h = location.hostname;
  if (h.startsWith('tech.')) return 'tech';
  if (h.startsWith('finance.')) return 'finance';
  if (h.startsWith('happy.')) return 'happy';
  if (h.startsWith('commodity.')) return 'commodity';

  if (h === 'localhost' || h === '127.0.0.1') {
    // `npm run dev:tech` / `dev:localtech` / … sets VITE_VARIANT — that must win over
    // `worldmonitor-variant` left from an earlier session (e.g. after trying localtech).
    if (buildVariant !== 'full') return buildVariant;
    const stored = localStorage.getItem('worldmonitor-variant');
    if (stored && ALLOWED_STORED_VARIANTS.has(stored)) return stored;
    return buildVariant;
  }

  return 'full';
})();

/** Tech map layers, HQ search, and tech-event loaders match the hosted tech variant. */
export const IS_TECH_LIKE_VARIANT = SITE_VARIANT === 'tech' || SITE_VARIANT === 'localtech';
