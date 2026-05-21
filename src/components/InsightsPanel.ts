import { Panel } from './Panel';
import { generateSummary, type SummarizeOptions } from '@/services/summarization';

import { isMobileDevice } from '@/utils';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { deletePersistentCache } from '@/services/persistent-cache';
import { getCurrentLanguage, t } from '@/services/i18n';
import { isDesktopRuntime } from '@/services/runtime';
import { getAiFlowSettings, isAnyAiProviderEnabled, subscribeAiFlowChange } from '@/services/ai-flow-settings';
import { fetchRankedTechInsights, prepareTechInsightFeed } from '@/services/tech-insights-llm';
import type { ClusteredEvent, NewsItem } from '@/types';

export class InsightsPanel extends Panel {
  private lastClusters: ClusteredEvent[] = [];
  private lastRecentNews: NewsItem[] | undefined;
  private techInsightsCache: { sig: string; brief: string; picks: NewsItem[]; verificationNote: string } | null = null;
  private techInsightsCooldownUntil = 0;
  private aiFlowUnsubscribe: (() => void) | null = null;
  private updateGeneration = 0;
  private static readonly BRIEF_COOLDOWN_MS = 120000; // 2 min cooldown (API has limits)
  private static readonly BRIEF_CACHE_KEY = 'summary:world-brief';

  constructor() {
    super({
      id: 'insights',
      title: t('panels.insights'),
      showCount: false,
      infoTooltip: t('components.insights.infoTooltip'),
    });

    // Web-only: subscribe to AI flow changes so toggling providers re-runs analysis
    // Skip on mobile — only server-side insights are used there (no client-side AI)
    if (!isDesktopRuntime() && !isMobileDevice()) {
      this.aiFlowUnsubscribe = subscribeAiFlowChange((changedKey) => {
        if (changedKey === 'mapNewsFlash') return;
        void this.onAiFlowChanged();
      });
    }

    this.setupLocaltechExpandButton();
  }

  public setMilitaryFlights(_flights: unknown): void {}

  private buildRuleBasedBrief(titles: string[]): string | null {
    if (titles.length === 0) return null;
    const top = titles.slice(0, 3).map((title) => `- ${title.slice(0, 120)}`).join('\n');
    const focus = 'Tech focus: AI, policy/regulation, security incidents, and funding signals.';
    return `${focus}\nKey developments:\n${top}`;
  }

  private setProgress(step: number, total: number, message: string): void {
    const percent = Math.round((step / total) * 100);
    this.setContent(`
      <div class="insights-progress">
        <div class="insights-progress-bar">
          <div class="insights-progress-fill" style="width: ${percent}%"></div>
        </div>
        <div class="insights-progress-info">
          <span class="insights-progress-step">${t('components.insights.step', { step: String(step), total: String(total) })}</span>
          <span class="insights-progress-message">${message}</span>
        </div>
      </div>
    `);
  }

  public async updateInsights(clusters: ClusteredEvent[], recentNews?: NewsItem[]): Promise<void> {
    this.lastClusters = clusters;
    if (recentNews !== undefined) {
      this.lastRecentNews = recentNews;
    }
    this.updateGeneration++;
    const thisGeneration = this.updateGeneration;

    const feed = recentNews ?? this.lastRecentNews ?? [];
    if (feed.length === 0) {
      this.setDataBadge('unavailable');
      this.setContent(`<div class="insights-empty">${t('components.insights.waitingForData')}</div>`);
      return;
    }
    await this.updateTechVariantFromNews(feed, thisGeneration);
  }

  private renderWorldBrief(
    brief: string,
    meta?: { confidenceLevel?: 'high' | 'medium' | 'low'; verificationNote?: string },
  ): string {
    const confidence = meta?.confidenceLevel || 'medium';
    const confidenceLabel = confidence === 'high'
      ? 'High Confidence'
      : confidence === 'low'
        ? 'Low Confidence'
        : 'Medium Confidence';
    const note = meta?.verificationNote ? `<div class="insights-brief-note">${escapeHtml(meta.verificationNote)}</div>` : '';
    return `
      <div class="insights-brief">
        <div class="insights-section-title">
          🚀 TECH BRIEF
          <span class="insight-badge ${confidence === 'high' ? 'confirmed' : confidence === 'low' ? 'alert' : 'multi'}">${confidenceLabel}</span>
        </div>
        <div class="insights-brief-text">${escapeHtml(brief)}</div>
        ${note}
      </div>
    `;
  }

  private async onAiFlowChanged(): Promise<void> {
    this.updateGeneration++;
    // Reset brief cache so new provider settings take effect immediately
    this.techInsightsCache = null;
    this.techInsightsCooldownUntil = 0;
    try {
      await deletePersistentCache(InsightsPanel.BRIEF_CACHE_KEY);
    } catch {
      // Best effort; fallback regeneration still works from memory reset.
    }
    if (!this.element?.isConnected) return;

    // Re-run full updateInsights; when providers are disabled we now fall back
    // to rule-based summaries instead of hard-unavailable state.
    void this.updateInsights(this.lastClusters, this.lastRecentNews);
  }

  private techInsightsSignature(news: NewsItem[]): string {
    return prepareTechInsightFeed(news)
      .slice(0, 18)
      .map((n) => n.link)
      .join('\0');
  }

  private async updateTechVariantFromNews(recentNews: NewsItem[], thisGeneration: number): Promise<void> {
    const sig = this.techInsightsSignature(recentNews);

    if (
      this.techInsightsCache &&
      this.techInsightsCache.sig === sig &&
      Date.now() < this.techInsightsCooldownUntil
    ) {
      if (this.updateGeneration !== thisGeneration) return;
      this.setDataBadge('live');
      this.renderTechLlmInsights(
        this.techInsightsCache.brief,
        this.techInsightsCache.picks,
        this.techInsightsCache.verificationNote,
      );
      return;
    }

    const feed = prepareTechInsightFeed(recentNews);
    if (feed.length === 0) {
      if (this.updateGeneration !== thisGeneration) return;
      this.setDataBadge('unavailable');
      this.setContent(`<div class="insights-empty">${t('components.insights.waitingForData')}</div>`);
      return;
    }

    const totalSteps = 3;
    this.setProgress(1, totalSteps, t('components.insights.generatingBrief'));

    const aiFlow = isDesktopRuntime() ? { cloudLlm: true, browserModel: true } : getAiFlowSettings();
    const summarizeOpts: SummarizeOptions = {
      skipCloudProviders: !aiFlow.cloudLlm,
      skipBrowserFallback: !aiFlow.browserModel,
    };
    const hasAi = isDesktopRuntime() || isAnyAiProviderEnabled();
    const lang = getCurrentLanguage() || 'en';

    // 1) Structured multi-headline ranking (needs cloud LLM + JSON mode on server)
    if (hasAi && aiFlow.cloudLlm) {
      const ranked = await fetchRankedTechInsights(recentNews, { skipCloudProviders: false });
      if (this.updateGeneration !== thisGeneration) return;
      if (ranked && ranked.picks.length > 0) {
        const note = 'Model-ranked from current feeds. Open links to read originals.';
        this.techInsightsCache = { sig, brief: ranked.brief, picks: ranked.picks, verificationNote: note };
        this.techInsightsCooldownUntil = Date.now() + 90_000;
        this.setDataBadge('live');
        this.renderTechLlmInsights(ranked.brief, ranked.picks, note);
        return;
      }
    }

    // 2) Same pipeline as geopolitical "world brief": brief-mode summary + feed links (browser T5 when cloud off)
    if (hasAi) {
      this.setProgress(2, totalSteps, t('components.insights.generatingBrief'));
      const titles = feed.slice(0, 8).map((n) => (n.title || '').trim()).filter(Boolean);
      if (titles.length >= 2) {
        const result = await generateSummary(
          titles,
          (_step, _total, msg) => {
            this.setProgress(2, totalSteps, msg);
          },
          '',
          lang,
          summarizeOpts,
        );
        if (this.updateGeneration !== thisGeneration) return;
        if (result?.summary) {
          const picks = feed.slice(0, 12);
          const note =
            result.provider === 'browser'
              ? 'Local model summary from headlines; open links to verify details.'
              : result.provider === 'cache'
                ? 'Cached summary from recent headlines; open links to read originals.'
                : 'Model-generated summary from current headlines. Open links to read originals.';
          this.techInsightsCache = { sig, brief: result.summary, picks, verificationNote: note };
          this.techInsightsCooldownUntil = Date.now() + InsightsPanel.BRIEF_COOLDOWN_MS;
          this.setDataBadge('live');
          this.renderTechLlmInsights(result.summary, picks, note);
          return;
        }
      }
    }

    if (this.updateGeneration !== thisGeneration) return;
    this.setDataBadge('live');
    this.renderTechNewsFallback(feed);
  }

  private renderTechLlmInsights(brief: string, picks: NewsItem[], verificationNote: string): void {
    const briefHtml = this.renderWorldBrief(brief, {
      confidenceLevel: 'medium',
      verificationNote,
    });
    const linksHtml = picks.map((item) => {
      const url = sanitizeUrl(item.link);
      const raw = item.title || '';
      const displayTitle = raw.length > 160 ? `${raw.slice(0, 160)}...` : raw;
      const title = escapeHtml(displayTitle);
      const src = escapeHtml((item.source || '').slice(0, 48));
      if (!url) {
        return `
        <div class="insight-story">
          <div class="insight-story-header">
            <span class="insight-story-title">${title}</span>
          </div>
          <div class="insight-story-meta">${src}</div>
        </div>`;
      }
      return `
        <a href="${url}" target="_blank" rel="noopener noreferrer" class="insight-story insight-story-link">
          <div class="insight-story-header">
            <span class="insight-story-title">${title}</span>
          </div>
          <div class="insight-story-meta">${src}</div>
        </a>`;
    }).join('');

    this.setContent(`
      ${briefHtml}
      <div class="insights-section">
        <div class="insights-section-title">⚡ HIGH PRIORITY</div>
        ${linksHtml}
      </div>
    `);
  }

  private renderTechNewsFallback(items: NewsItem[]): void {
    const briefHtml = this.renderWorldBrief(
      this.buildRuleBasedBrief(items.map((i) => i.title)) || 'Recent headlines (open links for full articles).',
      { confidenceLevel: 'low', verificationNote: 'LLM unavailable — showing newest unique items from feeds.' },
    );
    const linksHtml = items.slice(0, 12).map((item) => {
      const url = sanitizeUrl(item.link);
      const raw = item.title || '';
      const displayTitle = raw.length > 160 ? `${raw.slice(0, 160)}...` : raw;
      const title = escapeHtml(displayTitle);
      const src = escapeHtml((item.source || '').slice(0, 48));
      if (!url) {
        return `<div class="insight-story"><div class="insight-story-header"><span class="insight-story-title">${title}</span></div></div>`;
      }
      return `
        <a href="${url}" target="_blank" rel="noopener noreferrer" class="insight-story insight-story-link">
          <div class="insight-story-header">
            <span class="insight-story-title">${title}</span>
          </div>
          <div class="insight-story-meta">${src}</div>
        </a>`;
    }).join('');
    this.setContent(`
      ${briefHtml}
      <div class="insights-section">
        <div class="insights-section-title">⚡ RECENT</div>
        ${linksHtml}
      </div>
    `);
  }

  public override destroy(): void {
    this.aiFlowUnsubscribe?.();
    super.destroy();
  }
}
