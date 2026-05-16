/**
 * Logical datasets for the `localtech` (本地科技监测) build.
 * Implementations: `feeds.ts` (news RSS), `tech-companies.ts` + `tech-geo.ts` (map + search).
 * Tech conference map layer (`techEvents`) is optional and **default off** for this delivery.
 */
export const LOCALTECH_DATASETS = {
  news: {
    feedKeys: ['tech', 'ai', 'startups'] as const,
  },
  companies: {
    configModules: ['tech-companies', 'tech-geo'] as const,
  },
  events: {
    mapLayerKey: 'techEvents' as const,
  },
} as const;
