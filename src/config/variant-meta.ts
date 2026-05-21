export interface VariantMeta {
  title: string;
  description: string;
  keywords: string;
  url: string;
  siteName: string;
  shortName: string;
  subject: string;
  classification: string;
  categories: string[];
  features: string[];
}

export const VARIANT_META: { localtech: VariantMeta; [key: string]: VariantMeta } = {
  localtech: {
    title: '科技监测 — 本地科技情报看板',
    description: '科技监测：科技新闻、公司与活动地图；可选连接本机 Ollama / LM Studio 做摘要。',
    keywords: '科技监测, 科技新闻, 科技公司, 技术活动, tech news',
    url: 'http://localhost:5173/',
    siteName: '科技监测',
    shortName: '科技监测',
    subject: 'Technology monitoring',
    classification: 'Tech dashboard',
    categories: ['news', 'productivity'],
    features: [
      '科技新闻聚合',
      '科技公司 / 总部地图',
      '技术活动与会议',
      '本机大模型摘要（Ollama 兼容）',
    ],
  },
};
