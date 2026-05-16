import { Panel } from './Panel';
import { TECH_MONITORING_COMPANIES } from '@/config/tech-monitoring-companies';
import { h, replaceChildren } from '@/utils/dom-utils';
import { t } from '@/services/i18n';

export class TechMonitoringCompaniesPanel extends Panel {
  constructor() {
    super({
      id: 'tech-monitoring-companies',
      title: t('panels.techMonitoringCompanies'),
      showCount: true,
      infoTooltip: 'Companies used for entity linking, keyword monitors, and news relevance.',
    });
    this.element.classList.add('panel-tall');
    this.setCount(TECH_MONITORING_COMPANIES.length);
    this.render();
  }

  protected render(): void {
    const rows = TECH_MONITORING_COMPANIES.map((c) =>
      h('div', { className: 'tech-monitoring-company-row' },
        h('div', { className: 'tech-monitoring-company-main' },
          h('span', { className: 'tech-monitoring-company-name' }, c.name),
          h('span', { className: 'tech-monitoring-company-id' }, c.id),
        ),
        c.sector
          ? h('div', { className: 'tech-monitoring-company-sector' }, c.sector)
          : null,
      ),
    );

    replaceChildren(
      this.content,
      h('div', { className: 'tech-monitoring-company-list' }, ...rows),
    );
  }
}
