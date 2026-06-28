import { isDesktopRuntime, toApiUrl, toRuntimeUrl } from '../services/runtime';
import { getPersistentCache, setPersistentCache } from '../services/persistent-cache';

const isDev = import.meta.env.DEV;
const RESPONSE_CACHE_PREFIX = 'api-response:';

// RSS proxy: route directly to Railway relay via Cloudflare CDN when enabled.
// Feature flag controls rollout; default off for safe staged deployment.
const RSS_DIRECT_TO_RELAY = import.meta.env.VITE_RSS_DIRECT_TO_RELAY === 'true';
const RSS_PROXY_BASE = isDev
  ? '' // Dev uses Vite's rssProxyPlugin
  : RSS_DIRECT_TO_RELAY
    ? 'https://proxy.worldmonitor.app'
    : '';

export function rssProxyUrl(feedUrl: string): string {
  if (isDesktopRuntime()) return proxyUrl(feedUrl);
  if (RSS_PROXY_BASE) {
    return `${RSS_PROXY_BASE}/rss?url=${encodeURIComponent(feedUrl)}`;
  }
  return `/api/rss-proxy?url=${encodeURIComponent(feedUrl)}`;
}

type CachedResponsePayload = {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
};

// In production browser deployments, routes are handled by Vercel serverless functions.
// In local dev, Vite proxy handles these routes.
// In Tauri desktop mode, route requests need an absolute remote host.
export function proxyUrl(localPath: string): string {
  if (isDesktopRuntime()) {
    return toRuntimeUrl(localPath);
  }

  if (isDev) {
    return localPath;
  }

  return toApiUrl(localPath);
}

function shouldPersistResponse(url: string): boolean {
  return url.startsWith('/api/');
}

function buildResponseCacheKey(url: string): string {
  return `${RESPONSE_CACHE_PREFIX}${url}`;
}

function toCachedPayload(url: string, response: Response, body: string): CachedResponsePayload {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    url,
    status: response.status,
    statusText: response.statusText,
    headers,
    body,
  };
}

function toResponse(payload: CachedResponsePayload): Response {
  return new Response(payload.body, {
    status: payload.status,
    statusText: payload.statusText,
    headers: payload.headers,
  });
}

const FETCH_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAndPersist(url: string, retries = 1): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchWithTimeout(proxyUrl(url));
      if (response.ok && shouldPersistResponse(url)) {
        try {
          const body = await response.clone().text();
          void setPersistentCache(buildResponseCacheKey(url), toCachedPayload(url, response, body));
        } catch (error) {
          console.warn('[proxy] Failed to persist API response cache', error);
        }
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        // Exponential backoff: 800ms, 1600ms, ...
        await new Promise(r => setTimeout(r, 800 * (2 ** attempt)));
      }
    }
  }
  throw lastError;
}

export async function fetchWithProxy(url: string): Promise<Response> {
  if (!shouldPersistResponse(url)) {
    return fetchWithTimeout(proxyUrl(url));
  }

  const cacheKey = buildResponseCacheKey(url);
  const cached = await getPersistentCache<CachedResponsePayload>(cacheKey);

  if (cached?.data) {
    void fetchAndPersist(url, 0).catch((error) => {
      console.warn('[proxy] Background refresh failed for cached API response', error);
    });
    return toResponse(cached.data);
  }

  // First visit (no cache): retry once with backoff for cold-start resilience
  return fetchAndPersist(url, 1);
}
