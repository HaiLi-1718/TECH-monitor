import { Panel } from './Panel';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { t, getCurrentLanguage } from '@/services/i18n';
import { sanitizeUrl } from '@/utils/sanitize';
import { h, replaceChildren } from '@/utils/dom-utils';
import { formatTime } from '@/utils';
import { isDesktopRuntime } from '@/services/runtime';
import { ResearchServiceClient } from '@/generated/client/worldmonitor/research/v1/service_client';
import type { TechEvent, ListTechEventsResponse } from '@/generated/client/worldmonitor/research/v1/service_client';
import type { NewsItem, DeductContextDetail } from '@/types';
import { buildNewsContext } from '@/utils/news-context';
import { getHydratedData } from '@/services/bootstrap';
type ViewMode = 'upcoming' | 'conferences' | 'earnings' | 'all';
type MainMode = 'news' | 'calendar';

/** News categories shown in the multi-category timeline, in display order. */
const CATEGORY_ORDER = ['ai', 'security', 'policy', 'biopharma', 'tech', 'startups'] as const;

/** Per-category accent color for the timeline dot / filter chip. */
const CATEGORY_COLORS: Record<string, string> = {
  ai: '#4488ff',
  security: '#ff4444',
  policy: '#ffaa00',
  biopharma: '#44ff88',
  tech: '#44ffff',
  startups: '#ff44ff',
};

/** Max items rendered in the timeline (across all categories). */
const TIMELINE_LIMIT = 60;

type TimelineItem = NewsItem & { category: string };

const researchClient = new ResearchServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });

export class TechEventsPanel extends Panel {
  private mainMode: MainMode = 'news';
  private newsFilter = 'all';
  private viewMode: ViewMode = 'upcoming';
  private events: TechEvent[] = [];
  private loading = true;
  private error: string | null = null;
  private calendarLoaded = false;

  constructor(
    id: string,
    private getLatestNews?: () => NewsItem[],
    private getNewsByCategory?: () => Record<string, NewsItem[]>,
  ) {
    super({ id, title: t('panels.events'), showCount: true });
    this.element.classList.add('panel-tall');
    this.setupLocaltechExpandButton();
    // Default view is the news timeline; the tech calendar RPC loads lazily on first switch.
    this.render();
  }

  /** Called by the data loader whenever any news category refreshes. */
  public onNewsUpdated(): void {
    if (this.mainMode === 'news') this.render();
  }

  private async fetchEvents(): Promise<void> {
    this.loading = true;
    this.error = null;
    // Only repaint when the calendar tab is active, so a slow/failing RPC can't
    // clobber the news timeline the user may have switched back to.
    if (this.mainMode === 'calendar') this.render();

    // Try hydrated bootstrap data first (instant, no RPC call)
    const hydrated = getHydratedData('techEvents') as ListTechEventsResponse | undefined;
    if (hydrated?.events?.length) {
      this.events = hydrated.events;
      this.setCount(hydrated.conferenceCount || hydrated.events.filter((e: TechEvent) => e.type === 'conference').length);
      this.loading = false;
      if (this.mainMode === 'calendar') this.render();
      return;
    }

    // Fallback: RPC call with retry (exponential backoff)
    const retryDelays = [2_000, 5_000, 10_000];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const data = await researchClient.listTechEvents({
          type: '',
          mappable: false,
          days: 180,
          limit: 100,
        });
        if (!this.element?.isConnected) return;
        if (!data.success) throw new Error(data.error || 'Unknown error');

        this.events = data.events;
        this.setCount(data.conferenceCount);
        this.error = null;

        if (this.events.length === 0 && attempt < 2) {
          const delay = retryDelays[attempt] ?? 15_000;
          await new Promise(r => setTimeout(r, delay));
          if (!this.element?.isConnected) return;
          continue;
        }
        break;
      } catch (err) {
        if (this.isAbortError(err)) return;
        if (!this.element?.isConnected) return;
        if (attempt < 2) {
          const delay = retryDelays[attempt] ?? 15_000;
          await new Promise(r => setTimeout(r, delay));
          if (!this.element?.isConnected) return;
          continue;
        }
        this.error = t('common.failedToLoad');
        console.error('[TechEvents] Fetch error:', err);
      }
    }
    this.loading = false;
    if (this.mainMode === 'calendar') this.render();
  }

  protected render(): void {
    replaceChildren(this.content,
      h('div', { className: 'tech-events-panel' },
        this.buildMainTabs(),
        this.mainMode === 'news' ? this.renderNewsTimeline() : this.renderCalendar(),
      ),
    );
  }

  /** Top-level switch between the news timeline and the legacy tech calendar. */
  private buildMainTabs(): HTMLElement {
    const entries: [MainMode, string][] = [
      ['news', t('components.techEvents.tabNews')],
      ['calendar', t('components.techEvents.tabCalendar')],
    ];
    return h('div', { className: 'panel-tabs tech-events-main-tabs' },
      ...entries.map(([mode, label]) =>
        h('button', {
          className: `panel-tab ${this.mainMode === mode ? 'active' : ''}`,
          dataset: { mainMode: mode },
          onClick: () => {
            if (this.mainMode === mode) return;
            this.mainMode = mode;
            // Lazy-load the calendar RPC only when the user first opens that tab.
            if (mode === 'calendar' && !this.calendarLoaded) {
              this.calendarLoaded = true;
              void this.fetchEvents();
            } else {
              this.render();
            }
          },
        }, label),
      ),
    );
  }

  // ── News timeline ──────────────────────────────────────────────────────────

  /** Merge all categories, tag each item, sort newest-first, cap at TIMELINE_LIMIT. */
  private collectTimelineItems(): TimelineItem[] {
    const byCategory = this.getNewsByCategory?.() ?? {};
    const merged: TimelineItem[] = [];
    for (const category of CATEGORY_ORDER) {
      if (this.newsFilter !== 'all' && this.newsFilter !== category) continue;
      const items = byCategory[category] ?? [];
      for (const item of items) merged.push({ ...item, category });
    }
    merged.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());
    return merged.slice(0, TIMELINE_LIMIT);
  }

  /** Group items into Today / Yesterday / Earlier buckets, preserving order. */
  private groupByDay(items: TimelineItem[]): Array<{ label: string; items: TimelineItem[] }> {
    const now = new Date();
    const todayStr = now.toDateString();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const yesterdayStr = yesterday.toDateString();

    const today: TimelineItem[] = [];
    const yest: TimelineItem[] = [];
    const earlier: TimelineItem[] = [];
    for (const item of items) {
      const d = new Date(item.pubDate).toDateString();
      if (d === todayStr) today.push(item);
      else if (d === yesterdayStr) yest.push(item);
      else earlier.push(item);
    }

    const groups: Array<{ label: string; items: TimelineItem[] }> = [];
    if (today.length) groups.push({ label: t('components.techEvents.groupToday'), items: today });
    if (yest.length) groups.push({ label: t('components.techEvents.groupYesterday'), items: yest });
    if (earlier.length) groups.push({ label: t('components.techEvents.groupEarlier'), items: earlier });
    return groups;
  }

  private renderNewsTimeline(): HTMLElement {
    this.setErrorState(false);
    const items = this.collectTimelineItems();
    this.setCount(items.length);

    const filterEntries: [string, string][] = [
      ['all', t('components.techEvents.filterAll')],
      ...CATEGORY_ORDER.map((c): [string, string] => [c, t(`panels.${c}`)]),
    ];

    const groups = this.groupByDay(items);

    return h('div', { className: 'news-timeline-wrap' },
      h('div', { className: 'panel-tabs news-timeline-filters' },
        ...filterEntries.map(([key, label]) =>
          h('button', {
            className: `panel-tab ${this.newsFilter === key ? 'active' : ''}`,
            dataset: { filter: key },
            onClick: () => { this.newsFilter = key; this.render(); },
          },
            key !== 'all'
              ? h('span', { className: 'category-dot', style: `background:${CATEGORY_COLORS[key] ?? '#888'}` })
              : false,
            label,
          ),
        ),
      ),
      groups.length > 0
        ? h('div', { className: 'news-timeline' },
          ...groups.map(g =>
            h('div', { className: 'timeline-day-group' },
              h('div', { className: 'timeline-day-header' }, g.label),
              ...g.items.map(item => this.buildTimelineRow(item)),
            ),
          ),
        )
        : h('div', { className: 'empty-state' }, t('components.techEvents.noNews')),
    );
  }

  private buildTimelineRow(item: TimelineItem): HTMLElement {
    const showLang = item.lang && item.lang !== getCurrentLanguage();
    return h('div', { className: `item timeline-item ${item.isAlert ? 'alert' : ''}` },
      h('div', { className: 'item-source' },
        h('span', { className: 'category-dot', style: `background:${CATEGORY_COLORS[item.category] ?? '#888'}`, title: t(`panels.${item.category}`) }),
        item.source,
        showLang ? h('span', { className: 'lang-badge' }, (item.lang ?? '').toUpperCase()) : false,
        item.isAlert ? h('span', { className: 'alert-tag' }, 'ALERT') : false,
      ),
      h('a', { className: 'item-title', href: sanitizeUrl(item.link), target: '_blank', rel: 'noopener' }, item.title),
      h('div', { className: 'item-time' }, formatTime(new Date(item.pubDate))),
    );
  }

  // ── Tech calendar (legacy) ───────────────────────────────────────────────────

  private renderCalendar(): HTMLElement {
    if (this.loading) {
      return h('div', { className: 'tech-events-loading' },
        h('div', { className: 'loading-spinner' }),
        h('span', null, t('components.techEvents.loading')),
      );
    }

    if (this.error) {
      return h('div', { className: 'empty-state' },
        h('span', null, this.error),
        h('button', { className: 'panel-tab', onClick: () => this.refresh() }, t('components.techEvents.retry')),
      );
    }

    this.setErrorState(false);
    const filteredEvents = this.getFilteredEvents();
    const upcomingConferences = this.events.filter(e => e.type === 'conference' && new Date(e.startDate) >= new Date());
    const mappableCount = upcomingConferences.filter(e => e.coords && !e.coords.virtual).length;

    const tabEntries: [ViewMode, string][] = [
      ['upcoming', t('components.techEvents.upcoming')],
      ['conferences', t('components.techEvents.conferences')],
      ['earnings', t('components.techEvents.earnings')],
      ['all', t('components.techEvents.all')],
    ];

    return h('div', { className: 'tech-calendar' },
      h('div', { className: 'panel-tabs' },
        ...tabEntries.map(([view, label]) =>
          h('button', {
            className: `panel-tab ${this.viewMode === view ? 'active' : ''}`,
            dataset: { view },
            onClick: () => { this.viewMode = view; this.render(); },
          }, label),
        ),
      ),
      h('div', { className: 'tech-events-stats' },
        h('span', { className: 'stat' }, `📅 ${t('components.techEvents.conferencesCount', { count: String(upcomingConferences.length) })}`),
        h('span', { className: 'stat' }, `📍 ${t('components.techEvents.onMap', { count: String(mappableCount) })}`),
        h('a', { href: 'https://www.techmeme.com/events', target: '_blank', rel: 'noopener', className: 'source-link' }, t('components.techEvents.techmemeEvents')),
      ),
      h('div', { className: 'tech-events-list' },
        ...(filteredEvents.length > 0
          ? filteredEvents.map(e => this.buildEvent(e))
          : [h('div', { className: 'empty-state' }, t('components.techEvents.noEvents'))]),
      ),
    );
  }

  private getFilteredEvents(): TechEvent[] {
    const now = new Date();
    // Wider than 30d so major conferences (often 6–12 weeks out) still appear under「即将到来」.
    const upcomingHorizon = new Date(now.getTime() + 120 * 24 * 60 * 60 * 1000);

    switch (this.viewMode) {
      case 'upcoming':
        return this.events.filter(e => {
          const start = new Date(e.startDate);
          return start >= now && start <= upcomingHorizon;
        }).slice(0, 20);

      case 'conferences':
        return this.events.filter(e => e.type === 'conference' && new Date(e.startDate) >= now).slice(0, 30);

      case 'earnings':
        return this.events.filter(e => e.type === 'earnings' && new Date(e.startDate) >= now).slice(0, 30);

      case 'all':
        return this.events.filter(e => new Date(e.startDate) >= now).slice(0, 50);

      default:
        return [];
    }
  }

  private buildEvent(event: TechEvent): HTMLElement {
    const startDate = new Date(event.startDate);
    const endDate = new Date(event.endDate);
    const now = new Date();

    const isToday = startDate.toDateString() === now.toDateString();
    const isSoon = !isToday && startDate <= new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
    const isThisWeek = startDate <= new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const dateStr = startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const endDateStr = endDate > startDate && endDate.toDateString() !== startDate.toDateString()
      ? ` - ${endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
      : '';

    const typeIcons: Record<string, string> = {
      conference: '🎤',
      earnings: '📊',
      ipo: '🔔',
      other: '📌',
    };

    const typeClasses: Record<string, string> = {
      conference: 'type-conference',
      earnings: 'type-earnings',
      ipo: 'type-ipo',
      other: 'type-other',
    };

    const className = [
      'tech-event',
      typeClasses[event.type],
      isToday ? 'is-today' : '',
      isSoon ? 'is-soon' : '',
      isThisWeek ? 'is-this-week' : '',
    ].filter(Boolean).join(' ');

    const safeEventUrl = sanitizeUrl(event.url || '');

    return h('div', { className },
      h('div', { className: 'event-date' },
        h('span', { className: 'event-month' }, startDate.toLocaleDateString('en-US', { month: 'short' }).toUpperCase()),
        h('span', { className: 'event-day' }, String(startDate.getDate())),
        isToday ? h('span', { className: 'today-badge' }, t('components.techEvents.today')) : false,
        isSoon ? h('span', { className: 'soon-badge' }, t('components.techEvents.soon')) : false,
      ),
      h('div', { className: 'event-content' },
        h('div', { className: 'event-header' },
          h('span', { className: 'event-icon' }, typeIcons[event.type] ?? '📌'),
          h('span', { className: 'event-title' }, event.title),
          safeEventUrl
            ? h('a', { href: safeEventUrl, target: '_blank', rel: 'noopener', className: 'event-url', title: t('components.techEvents.moreInfo') }, '↗')
            : false,
        ),
        h('div', { className: 'event-meta' },
          h('span', { className: 'event-dates' }, `${dateStr}${endDateStr}`),
          event.location
            ? h('span', { className: 'event-location' }, event.location)
            : false,
          isDesktopRuntime() ? h('button', {
            className: 'event-deduce-link',
            title: 'Deduce Situation with AI',
            style: 'background: none; border: none; cursor: pointer; opacity: 0.7; font-size: 1.1em; transition: opacity 0.2s; margin-left: auto; padding-right: 4px;',
            onClick: (e: Event) => {
              e.preventDefault();
              e.stopPropagation();

              let geoContext = `Event details: ${event.title} (${event.type}) taking place from ${dateStr}${endDateStr}. Location: ${event.location || 'Unknown/Virtual'}.`;

              if (this.getLatestNews) {
                const newsCtx = buildNewsContext(this.getLatestNews);
                if (newsCtx) geoContext += `\n\n${newsCtx}`;
              }

              const detail: DeductContextDetail = {
                query: `What is the expected impact of the tech event: ${event.title}?`,
                geoContext,
                autoSubmit: true,
              };
              document.dispatchEvent(new CustomEvent('wm:deduct-context', { detail }));
            },
          }, '\u{1F9E0}') : false,
          event.coords && !event.coords.virtual
            ? h('button', {
              className: 'event-map-link',
              title: t('components.techEvents.showOnMap'),
              onClick: (e: Event) => {
                e.preventDefault();
                this.panToLocation(event.coords!.lat, event.coords!.lng);
              },
            }, '📍')
            : false,
        ),
      ),
    );
  }

  private panToLocation(lat: number, lng: number): void {
    // Dispatch event for map to handle
    window.dispatchEvent(new CustomEvent('tech-event-location', {
      detail: { lat, lng, zoom: 10 }
    }));
  }

  public refresh(): void {
    void this.fetchEvents();
  }

  public getConferencesForMap(): TechEvent[] {
    return this.events.filter(e =>
      e.type === 'conference' &&
      e.coords &&
      !e.coords.virtual &&
      new Date(e.startDate) >= new Date()
    );
  }

  public override destroy(): void {
    super.destroy();
  }
}
