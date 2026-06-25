const DESKTOP_ORIGIN_PATTERNS = [
  /^https?:\/\/tauri\.localhost(:\d+)?$/,
  /^https?:\/\/[a-z0-9-]+\.tauri\.localhost(:\d+)?$/i,
  /^tauri:\/\/localhost$/,
  /^asset:\/\/localhost$/,
];

// Hard-coded trusted origins — mainly for cross-origin embeds and the official deployment.
// Self-hosted deployments are covered automatically by the same-origin check below.
const BROWSER_ORIGIN_PATTERNS = [
  /^https:\/\/(.*\.)?worldmonitor\.app$/,
  /^https:\/\/worldmonitor-[a-z0-9-]+-elie-[a-z0-9]+\.vercel\.app$/,
  ...(process.env.NODE_ENV === 'production' ? [] : [
    /^https?:\/\/localhost(:\d+)?$/,
    /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  ]),
];

function isDesktopOrigin(origin) {
  return Boolean(origin) && DESKTOP_ORIGIN_PATTERNS.some(p => p.test(origin));
}

function isTrustedBrowserOrigin(origin) {
  return Boolean(origin) && BROWSER_ORIGIN_PATTERNS.some(p => p.test(origin));
}

function isSameOrigin(origin, req) {
  if (!origin) return false;
  try {
    const originHost = new URL(origin).host;
    // Use the request URL's host primarily — Vercel may rewrite the Host header
    // to an internal routing host that doesn't match the external origin.
    const urlHost = new URL(req.url).host;
    const headerHost = req.headers.get('Host');
    return originHost === urlHost || (!!headerHost && originHost === headerHost);
  } catch {
    return false;
  }
}

function hasSameOriginHost(req) {
  // Fallback when no Origin/Referer — check if Host header matches request URL host.
  // If they differ (Vercel rewrote Host), trust the request URL host.
  try {
    const headerHost = req.headers.get('Host');
    if (!headerHost) return true; // no host = can't check, allow
    const urlHost = new URL(req.url).host;
    return headerHost === urlHost;
  } catch {
    return true; // can't check, allow
  }
}

function extractOriginFromReferer(referer) {
  if (!referer) return '';
  try {
    return new URL(referer).origin;
  } catch {
    return '';
  }
}

export function validateApiKey(req, options = {}) {
  const forceKey = options.forceKey === true;
  const key = req.headers.get('X-WorldMonitor-Key');
  const origin = req.headers.get('Origin') || extractOriginFromReferer(req.headers.get('Referer')) || '';

  // Desktop app — always require API key
  if (isDesktopOrigin(origin)) {
    if (!key) return { valid: false, required: true, error: 'API key required for desktop access' };
    const validKeys = (process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean);
    if (!validKeys.includes(key)) return { valid: false, required: true, error: 'Invalid API key' };
    return { valid: true, required: true };
  }

  // Same-origin — always trusted (covers all self-hosted / custom-domain deployments)
  if (isSameOrigin(origin, req)) {
    if (forceKey && !key) {
      return { valid: false, required: true, error: 'API key required' };
    }
    if (key) {
      const validKeys = (process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean);
      if (!validKeys.includes(key)) return { valid: false, required: true, error: 'Invalid API key' };
    }
    return { valid: true, required: forceKey };
  }

  // No Origin/Referer but same host — likely same-origin GET (browsers omit
  // Origin for same-origin GET requests). Trust it.
  if (!origin && hasSameOriginHost(req)) {
    if (forceKey && !key) {
      return { valid: false, required: true, error: 'API key required' };
    }
    return { valid: true, required: forceKey };
  }

  // Trusted browser origin (worldmonitor.app, Vercel previews, localhost dev) — no key needed
  if (isTrustedBrowserOrigin(origin)) {
    if (forceKey && !key) {
      return { valid: false, required: true, error: 'API key required' };
    }
    if (key) {
      const validKeys = (process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean);
      if (!validKeys.includes(key)) return { valid: false, required: true, error: 'Invalid API key' };
    }
    return { valid: true, required: forceKey };
  }

  // Explicit key provided from unknown origin — validate it
  if (key) {
    const validKeys = (process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean);
    if (!validKeys.includes(key)) return { valid: false, required: true, error: 'Invalid API key' };
    return { valid: true, required: true };
  }

  // No origin, no key — require API key (blocks unauthenticated curl/scripts)
  return { valid: false, required: true, error: 'API key required' };
}
