import type { PanelConfig, MapLayers, DataSourceId } from '@/types';

// ============================================
// 科技监测面板配置
// ============================================
const LOCALTECH_PANELS: Record<string, PanelConfig> = {
  map: { name: '科技地图', enabled: true, priority: 1 },
  'live-news': { name: '科技快讯', enabled: true, priority: 1 },
  ai: { name: 'AI / 机器学习', enabled: true, priority: 1 },
  insights: { name: 'AI 摘要', enabled: true, priority: 1 },
  events: { name: '事件时间线', enabled: true, priority: 1 },
  policy: { name: '政策监管', enabled: true, priority: 1 },
  security: { name: '安全事件', enabled: true, priority: 1 },
  monitors: { name: '生物医药自定义监控', enabled: true, priority: 1 },
  biopharma: { name: '生物医药', enabled: true, priority: 1 },
  startups: { name: '创业与融资', enabled: false, priority: 2 },
  'tech-monitoring-companies': { name: '重点企业库', enabled: false, priority: 2 },
};

const LOCALTECH_MAP_LAYERS: MapLayers = {
  gpsJamming: false,
  satellites: false,
  conflicts: false,
  bases: false,
  cables: true,
  pipelines: true,
  hotspots: false,
  ais: false,
  nuclear: false,
  irradiators: false,
  sanctions: false,
  weather: false,
  economic: false,
  waterways: false,
  outages: false,
  cyberThreats: false,
  datacenters: true,
  protests: false,
  flights: false,
  military: false,
  natural: false,
  spaceports: false,
  minerals: false,
  fires: false,
  ucdpEvents: false,
  displacement: false,
  climate: false,
  startupHubs: true,
  cloudRegions: true,
  accelerators: true,
  techHQs: true,
  techEvents: false,
  stockExchanges: false,
  financialCenters: false,
  centralBanks: false,
  commodityHubs: false,
  gulfInvestments: false,
  positiveEvents: false,
  kindness: false,
  happiness: false,
  speciesRecovery: false,
  renewableInstallations: false,
  tradeRoutes: false,
  iranAttacks: false,
  ciiChoropleth: false,
  dayNight: false,
  miningSites: false,
  processingPlants: false,
  commodityPorts: false,
  webcams: false,
};

const LOCALTECH_MOBILE_MAP_LAYERS: MapLayers = {
  gpsJamming: false,
  satellites: false,
  conflicts: false,
  bases: false,
  cables: false,
  pipelines: true,
  hotspots: false,
  ais: false,
  nuclear: false,
  irradiators: false,
  sanctions: false,
  weather: false,
  economic: false,
  waterways: false,
  outages: false,
  cyberThreats: false,
  datacenters: true,
  protests: false,
  flights: false,
  military: false,
  natural: false,
  spaceports: false,
  minerals: false,
  fires: false,
  ucdpEvents: false,
  displacement: false,
  climate: false,
  startupHubs: true,
  cloudRegions: false,
  accelerators: true,
  techHQs: false,
  techEvents: false,
  stockExchanges: false,
  financialCenters: false,
  centralBanks: false,
  commodityHubs: false,
  gulfInvestments: false,
  positiveEvents: false,
  kindness: false,
  happiness: false,
  speciesRecovery: false,
  renewableInstallations: false,
  tradeRoutes: false,
  iranAttacks: false,
  ciiChoropleth: false,
  dayNight: false,
  miningSites: false,
  processingPlants: false,
  commodityPorts: false,
  webcams: false,
};

// ============================================
// 导出
// ============================================
export const DEFAULT_PANELS = LOCALTECH_PANELS;
export const DEFAULT_MAP_LAYERS = LOCALTECH_MAP_LAYERS;
export const MOBILE_DEFAULT_MAP_LAYERS = LOCALTECH_MOBILE_MAP_LAYERS;

export const LAYER_TO_SOURCE: Partial<Record<keyof MapLayers, DataSourceId[]>> = {
  natural: ['usgs'],
  weather: ['weather'],
  outages: ['outages'],
  cyberThreats: ['cyber_threats'],
};

// ============================================
// 面板分类
// ============================================
export const PANEL_CATEGORY_MAP: Record<string, { labelKey: string; panelKeys: string[] }> = {
  core: {
    labelKey: 'header.panelCatCore',
    panelKeys: ['map', 'live-news', 'insights'],
  },
  techAi: {
    labelKey: 'header.panelCatTechAi',
    panelKeys: ['ai', 'events'],
  },
  securityPolicy: {
    labelKey: 'header.panelCatSecurityPolicy',
    panelKeys: ['security', 'policy'],
  },
  biopharmaGroup: {
    labelKey: 'header.panelCatStartupsVc',
    panelKeys: ['biopharma', 'monitors'],
  },
  companies: {
    labelKey: 'header.panelCatMarkets',
    panelKeys: ['startups', 'tech-monitoring-companies'],
  },
};

export const MONITOR_COLORS = [
  '#44ff88',
  '#ff8844',
  '#4488ff',
  '#ff44ff',
  '#ffff44',
  '#ff4444',
  '#44ffff',
  '#88ff44',
  '#ff88ff',
  '#88ffff',
];

export const STORAGE_KEYS = {
  panels: 'worldmonitor-panels',
  monitors: 'worldmonitor-monitors',
  mapLayers: 'worldmonitor-layers',
  disabledFeeds: 'worldmonitor-disabled-feeds',
} as const;
