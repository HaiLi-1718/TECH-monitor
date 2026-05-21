import type { NewsItem } from '@/types';
import { NewsServiceClient } from '@/generated/client/worldmonitor/news/v1/service_client';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { getCurrentLanguage } from '@/services/i18n';
import { isFeatureAvailable, type RuntimeFeatureId } from '@/services/runtime-config';

const newsClient = new NewsServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });

const PROVIDERS: { provider: 'ollama' | 'groq' | 'openrouter' | 'generic'; feature: RuntimeFeatureId }[] = [
  { provider: 'ollama', feature: 'aiOllama' },
  { provider: 'groq', feature: 'aiGroq' },
  { provider: 'openrouter', feature: 'aiOpenRouter' },
  { provider: 'generic', feature: 'aiLlmGeneric' },
];

function buildTechInsightHeadlines(feed: NewsItem[]): string[] {
  return feed.map((n) => {
    const title = (n.title || '').replace(/\t/g, ' ').trim().slice(0, 400);
    const source = (n.source || '').replace(/\t/g, ' ').trim().slice(0, 120);
    const link = (n.link || '').replace(/\t/g, '').trim().slice(0, 2000);
    return `${title}\t${source}\t${link}`;
  });
}

/** Deduped recent headlines for tech-insights ranking and UI fallbacks. */
export function prepareTechInsightFeed(news: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  const sorted = [...news].sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());
  for (const n of sorted) {
    const link = (n.link || '').trim();
    if (!link || seen.has(link)) continue;
    seen.add(link);
    if ((n.title || '').trim().length < 4) continue;
    out.push(n);
    if (out.length >= 40) break;
  }
  return out;
}

export interface FetchRankedTechInsightsOptions {
  skipCloudProviders?: boolean;
}

/**
 * Calls SummarizeArticle with `mode: tech_insights` and maps 1-based indices back to feed items.
 */
export async function fetchRankedTechInsights(
  news: NewsItem[],
  options?: FetchRankedTechInsightsOptions,
): Promise<{ brief: string; picks: NewsItem[] } | null> {
  const feed = prepareTechInsightFeed(news).slice(0, 25);
  if (feed.length < 1) return null;
  if (options?.skipCloudProviders) return null;

  const headlines = buildTechInsightHeadlines(feed);
  const lang = getCurrentLanguage() || 'en';

  for (const { provider, feature } of PROVIDERS) {
    if (!isFeatureAvailable(feature)) continue;
    try {
      const resp = await newsClient.summarizeArticle({
        provider,
        headlines,
        mode: 'tech_insights',
        geoContext: '',
        variant: 'localtech',
        lang,
      });
      if (resp.fallback || resp.status === 'SUMMARIZE_STATUS_SKIPPED') continue;
      const raw = typeof resp.summary === 'string' ? resp.summary.trim() : '';
      if (!raw) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const o = parsed as Record<string, unknown>;
      const brief = o.brief;
      const indices = o.indices;
      if (typeof brief !== 'string' || brief.trim().length < 4) continue;
      if (!Array.isArray(indices) || indices.length < 1) continue;

      const picks: NewsItem[] = [];
      for (const idx of indices) {
        const i =
          typeof idx === 'number' && Number.isInteger(idx)
            ? idx
            : Number.parseInt(String(idx), 10);
        if (!Number.isFinite(i) || i < 1 || i > feed.length) continue;
        const item = feed[i - 1];
        if (item) picks.push(item);
      }
      if (picks.length < 1) continue;

      return { brief: brief.trim(), picks };
    } catch (e) {
      console.warn('[tech-insights-llm]', provider, e);
    }
  }
  return null;
}
