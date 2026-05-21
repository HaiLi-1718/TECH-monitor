import type { AppContext, AppModule } from '@/app/app-context';
import type { SearchResult } from '@/components/SearchModal';
import type { NewsItem, MapLayers } from '@/types';
import type { MapView } from '@/components';
import type { Command } from '@/config/commands';
import { SearchModal } from '@/components';
import { STORAGE_KEYS } from '@/config';
import { getAllowedLayerKeys } from '@/config/map-layer-definitions';
import type { MapVariant } from '@/config/map-layer-definitions';
import { LAYER_PRESETS, LAYER_KEY_MAP } from '@/config/commands';
import { calculateCII, TIER1_COUNTRIES } from '@/services/country-instability';
import { CURATED_COUNTRIES } from '@/config/countries';
import { getCountryBbox } from '@/services/country-geometry';
import { UNDERSEA_CABLES } from '@/config/geo';
import { AI_DATA_CENTERS } from '@/config/ai-datacenters';

import { TECH_COMPANIES } from '@/config/tech-companies';
import { AI_RESEARCH_LABS } from '@/config/ai-research-labs';
import { STARTUP_ECOSYSTEMS } from '@/config/startup-ecosystems';
import { TECH_HQS, ACCELERATORS } from '@/config/tech-geo';
import { trackSearchResultSelected, trackCountrySelected } from '@/services/analytics';
import { t } from '@/services/i18n';
import { saveToStorage, setTheme } from '@/utils';
import { CountryIntelManager } from '@/app/country-intel';

export interface SearchManagerCallbacks {
  openCountryBriefByCode: (code: string, country: string) => void;
}

export class SearchManager implements AppModule {
  private ctx: AppContext;
  private callbacks: SearchManagerCallbacks;
  private boundKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private highlightTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

  constructor(ctx: AppContext, callbacks: SearchManagerCallbacks) {
    this.ctx = ctx;
    this.callbacks = callbacks;
  }

  init(): void {
    this.setupSearchModal();
  }

  destroy(): void {
    if (this.boundKeydownHandler) {
      document.removeEventListener('keydown', this.boundKeydownHandler);
      this.boundKeydownHandler = null;
    }
  }

  private setupSearchModal(): void {
    this.ctx.searchModal = new SearchModal(this.ctx.container, {
      placeholder: t('modals.search.placeholderTech'),
    });

    this.ctx.searchModal.registerSource('techcompany', TECH_COMPANIES.map(c => ({
      id: c.id,
      title: c.name,
      subtitle: `${c.sector} ${c.city} ${c.keyProducts?.join(' ') || ''}`.trim(),
      data: c,
    })));

    this.ctx.searchModal.registerSource('ailab', AI_RESEARCH_LABS.map(l => ({
      id: l.id,
      title: l.name,
      subtitle: `${l.type} ${l.city} ${l.focusAreas?.join(' ') || ''}`.trim(),
      data: l,
    })));

    this.ctx.searchModal.registerSource('startup', STARTUP_ECOSYSTEMS.map(s => ({
      id: s.id,
      title: s.name,
      subtitle: `${s.ecosystemTier} ${s.topSectors?.join(' ') || ''} ${s.notableStartups?.join(' ') || ''}`.trim(),
      data: s,
    })));

    this.ctx.searchModal.registerSource('datacenter', AI_DATA_CENTERS.map(d => ({
      id: d.id,
      title: d.name,
      subtitle: `${d.owner} ${d.chipType || ''}`.trim(),
      data: d,
    })));

    this.ctx.searchModal.registerSource('cable', UNDERSEA_CABLES.map(c => ({
      id: c.id,
      title: c.name,
      subtitle: c.major ? 'Major internet backbone' : 'Undersea cable',
      data: c,
    })));

    this.ctx.searchModal.registerSource('techhq', TECH_HQS.map(h => ({
      id: h.id,
      title: h.company,
      subtitle: `${h.type === 'faang' ? 'Big Tech' : h.type === 'unicorn' ? 'Unicorn' : 'Public'} • ${h.city}, ${h.country}`,
      data: h,
    })));

    this.ctx.searchModal.registerSource('accelerator', ACCELERATORS.map(a => ({
      id: a.id,
      title: a.name,
      subtitle: `${a.type} • ${a.city}, ${a.country}${a.notable ? ` • ${a.notable.slice(0, 2).join(', ')}` : ''}`,
      data: a,
    })));

    this.ctx.searchModal.registerSource('country', this.buildCountrySearchItems());

    this.ctx.searchModal.setActivePanels(Object.keys(this.ctx.panels));
    this.ctx.searchModal.setOnSelect((result) => this.handleSearchResult(result));
    this.ctx.searchModal.setOnCommand((cmd) => this.handleCommand(cmd));

    this.boundKeydownHandler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        if (this.ctx.searchModal?.isOpen()) {
          this.ctx.searchModal.close();
        } else {
          this.updateSearchIndex();
          this.ctx.searchModal?.open();
        }
      }
    };
    document.addEventListener('keydown', this.boundKeydownHandler);
  }

  private handleSearchResult(result: SearchResult): void {
    trackSearchResultSelected(result.type);
    switch (result.type) {
      case 'news': {
        const item = result.data as NewsItem;
        this.scrollToPanel('live-news');
        this.highlightNewsItem(item.link);
        break;
      }
      case 'market': {
        this.scrollToPanel('markets');
        break;
      }
      case 'prediction': {
        this.scrollToPanel('polymarket');
        break;
      }
      case 'cable': {
        const cable = result.data as typeof UNDERSEA_CABLES[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('cables');
        this.ctx.mapLayers.cables = true;
        setTimeout(() => { this.ctx.map?.triggerCableClick(cable.id); }, 300);
        break;
      }
      case 'datacenter': {
        const dc = result.data as typeof AI_DATA_CENTERS[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('datacenters');
        this.ctx.mapLayers.datacenters = true;
        setTimeout(() => { this.ctx.map?.triggerDatacenterClick(dc.id); }, 300);
        break;
      }
      case 'techcompany': {
        const company = result.data as typeof TECH_COMPANIES[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('techHQs');
        this.ctx.mapLayers.techHQs = true;
        setTimeout(() => { this.ctx.map?.setCenter(company.lat, company.lon, 4); }, 300);
        break;
      }
      case 'ailab': {
        const lab = result.data as typeof AI_RESEARCH_LABS[0];
        this.ctx.map?.setView('global');
        setTimeout(() => { this.ctx.map?.setCenter(lab.lat, lab.lon, 4); }, 300);
        break;
      }
      case 'startup': {
        const ecosystem = result.data as typeof STARTUP_ECOSYSTEMS[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('startupHubs');
        this.ctx.mapLayers.startupHubs = true;
        setTimeout(() => { this.ctx.map?.setCenter(ecosystem.lat, ecosystem.lon, 4); }, 300);
        break;
      }
      case 'techevent':
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('techEvents');
        this.ctx.mapLayers.techEvents = true;
        break;
      case 'techhq': {
        const hq = result.data as typeof TECH_HQS[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('techHQs');
        this.ctx.mapLayers.techHQs = true;
        setTimeout(() => { this.ctx.map?.setCenter(hq.lat, hq.lon, 4); }, 300);
        break;
      }
      case 'accelerator': {
        const acc = result.data as typeof ACCELERATORS[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('accelerators');
        this.ctx.mapLayers.accelerators = true;
        setTimeout(() => { this.ctx.map?.setCenter(acc.lat, acc.lon, 4); }, 300);
        break;
      }
      case 'country': {
        const { code, name } = result.data as { code: string; name: string };
        trackCountrySelected(code, name, 'search');
        this.callbacks.openCountryBriefByCode(code, name);
        break;
      }
    }
  }

  private handleCommand(cmd: Command): void {
    const colonIdx = cmd.id.indexOf(':');
    if (colonIdx === -1) return;
    const category = cmd.id.slice(0, colonIdx);
    const action = cmd.id.slice(colonIdx + 1);

    switch (category) {
      case 'nav':
        this.ctx.map?.setView(action as MapView);
        {
          const sel = document.getElementById('regionSelect') as HTMLSelectElement;
          if (sel) sel.value = action;
        }
        break;

      case 'layers': {
        const allowed = getAllowedLayerKeys('localtech' as MapVariant);
        if (action === 'all') {
          for (const key of Object.keys(this.ctx.mapLayers)) {
            this.ctx.mapLayers[key as keyof MapLayers] = allowed.has(key as keyof MapLayers);
          }
        } else if (action === 'none') {
          for (const key of Object.keys(this.ctx.mapLayers))
            this.ctx.mapLayers[key as keyof MapLayers] = false;
        } else {
          const preset = LAYER_PRESETS[action];
          if (preset) {
            for (const key of Object.keys(this.ctx.mapLayers))
              this.ctx.mapLayers[key as keyof MapLayers] = false;
            for (const layer of preset) {
              if (allowed.has(layer)) this.ctx.mapLayers[layer] = true;
            }
          }
        }
        saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
        this.ctx.map?.setLayers(this.ctx.mapLayers);
        break;
      }

      case 'layer': {
        const layerKey = (LAYER_KEY_MAP[action] || action) as keyof MapLayers;
        if (!(layerKey in this.ctx.mapLayers)) return;
        const variantAllowed = getAllowedLayerKeys('localtech' as MapVariant);
        if (!variantAllowed.has(layerKey)) return;
        this.ctx.mapLayers[layerKey] = !this.ctx.mapLayers[layerKey];
        saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
        if (this.ctx.mapLayers[layerKey]) {
          this.ctx.map?.enableLayer(layerKey);
        } else {
          this.ctx.map?.setLayers(this.ctx.mapLayers);
        }
        break;
      }

      case 'panel':
        this.scrollToPanel(action);
        break;

      case 'view':
        if (action === 'dark' || action === 'light') {
          setTheme(action);
        } else if (action === 'fullscreen') {
          if (document.fullscreenElement) {
            try { void document.exitFullscreen()?.catch(() => {}); } catch {}
          } else {
            const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
            if (el.requestFullscreen) {
              try { void el.requestFullscreen()?.catch(() => {}); } catch {}
            } else if (el.webkitRequestFullscreen) {
              try { el.webkitRequestFullscreen(); } catch {}
            }
          }
        } else if (action === 'settings') {
          this.ctx.unifiedSettings?.open();
        } else if (action === 'refresh') {
          window.location.reload();
        }
        break;

      case 'time':
        this.ctx.map?.setTimeRange(action as import('@/components').TimeRange);
        break;

      case 'country': {
        const name = TIER1_COUNTRIES[action]
          || CURATED_COUNTRIES[action]?.name
          || new Intl.DisplayNames(['en'], { type: 'region' }).of(action)
          || action;
        trackCountrySelected(action, name, 'command');
        this.callbacks.openCountryBriefByCode(action, name);
        break;
      }

      case 'country-map': {
        const bbox = getCountryBbox(action);
        if (bbox) {
          const [minLon, minLat, maxLon, maxLat] = bbox;
          const lat = (minLat + maxLat) / 2;
          const lon = (minLon + maxLon) / 2;
          const span = Math.max(maxLat - minLat, maxLon - minLon);
          const zoom = span > 40 ? 3 : span > 15 ? 4 : span > 5 ? 5 : 6;
          this.ctx.map?.setView('global');
          setTimeout(() => { this.ctx.map?.setCenter(lat, lon, zoom); }, 300);
        }
        break;
      }
    }
  }

  private scrollToPanel(panelId: string): void {
    const panel = document.querySelector(`[data-panel="${panelId}"]`);
    if (panel) {
      panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
      this.applyHighlight(panel);
    }
  }

  private highlightNewsItem(itemId: string): void {
    setTimeout(() => {
      const item = document.querySelector(`[data-news-id="${CSS.escape(itemId)}"]`);
      if (item) {
        item.scrollIntoView({ behavior: 'smooth', block: 'center' });
        this.applyHighlight(item);
      }
    }, 100);
  }

  private applyHighlight(el: Element): void {
    const prev = this.highlightTimers.get(el);
    if (prev) clearTimeout(prev);
    el.classList.remove('search-highlight');
    void (el as HTMLElement).offsetWidth;
    el.classList.add('search-highlight');
    this.highlightTimers.set(el, setTimeout(() => {
      el.classList.remove('search-highlight');
      this.highlightTimers.delete(el);
    }, 3100));
  }

  updateSearchIndex(): void {
    if (!this.ctx.searchModal) return;

    this.ctx.searchModal.setActivePanels(Object.keys(this.ctx.panels));
    this.ctx.searchModal.registerSource('country', this.buildCountrySearchItems());

    const newsItems = this.ctx.allNews.slice(0, 500).map(n => ({
      id: n.link,
      title: n.title,
      subtitle: n.source,
      data: n,
    }));
    console.log(`[Search] Indexing ${newsItems.length} news items (allNews total: ${this.ctx.allNews.length})`);
    this.ctx.searchModal.registerSource('news', newsItems);

    if (this.ctx.latestPredictions.length > 0) {
      this.ctx.searchModal.registerSource('prediction', this.ctx.latestPredictions.map(p => ({
        id: p.title,
        title: p.title,
        subtitle: `${Math.round(p.yesPrice)}% probability`,
        data: p,
      })));
    }

    if (this.ctx.latestMarkets.length > 0) {
      this.ctx.searchModal.registerSource('market', this.ctx.latestMarkets.map(m => ({
        id: m.symbol,
        title: `${m.symbol} - ${m.name}`,
        subtitle: `$${m.price?.toFixed(2) || 'N/A'}`,
        data: m,
      })));
    }
  }

  private buildCountrySearchItems(): { id: string; title: string; subtitle: string; data: { code: string; name: string } }[] {
    const scores = calculateCII();
    const ciiByCode = new Map(scores.map((score) => [score.code, score]));
    return Object.entries(TIER1_COUNTRIES).map(([code, name]) => {
      const score = ciiByCode.get(code);
      return {
        id: code,
        title: `${CountryIntelManager.toFlagEmoji(code)} ${name}`,
        subtitle: score ? `CII: ${score.score}/100 • ${score.level}` : 'Country Brief',
        data: { code, name },
      };
    });
  }
}
