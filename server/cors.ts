/**
 * CORS header generation -- TypeScript port of api/_cors.js.
 *
 * Add custom domains via TRUSTED_ORIGINS env var (comma-separated).
 */

const EXTRA_TRUSTED_ORIGINS: RegExp[] = (process.env.TRUSTED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(host => new RegExp(`^https://${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));

const PRODUCTION_PATTERNS: RegExp[] = [
  /^https:\/\/(.*\.)?worldmonitor\.app$/,
  /^https:\/\/worldmonitor-[a-z0-9-]+-elie-[a-z0-9]+\.vercel\.app$/,
  /^https:\/\/tech-monitor-beta\.vercel\.app$/,
  /^https?:\/\/tauri\.localhost(:\d+)?$/,
  /^https?:\/\/[a-z0-9-]+\.tauri\.localhost(:\d+)?$/i,
  /^tauri:\/\/localhost$/,
  /^asset:\/\/localhost$/,
];

const DEV_PATTERNS: RegExp[] = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
];

const ALLOWED_ORIGIN_PATTERNS: RegExp[] = [
  ...(process.env.NODE_ENV === 'production'
    ? PRODUCTION_PATTERNS
    : [...PRODUCTION_PATTERNS, ...DEV_PATTERNS]),
  ...EXTRA_TRUSTED_ORIGINS,
];

function isAllowedOrigin(origin: string): boolean {
  return Boolean(origin) && ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}

export function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || '';
  const allowOrigin = isAllowedOrigin(origin) ? origin : 'https://worldmonitor.app';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-WorldMonitor-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

export function isDisallowedOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  return !isAllowedOrigin(origin);
}
