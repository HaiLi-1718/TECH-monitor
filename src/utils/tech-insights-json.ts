/**
 * Parse LLM JSON for SummarizeArticle mode `tech_insights`.
 * Shape must match the contract in `server/worldmonitor/news/v1/_shared.ts` (buildArticlePrompts).
 */

export type TechInsightsParsed = {
  brief: string;
  indices: number[];
};

const MAX_INDICES = 8;

function stripMarkdownFence(text: string): string {
  const m = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const inner = m?.[1];
  return typeof inner === 'string' ? inner.trim() : text.trim();
}

function sliceJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

function asPositiveInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const n = Number(value);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

export function parseTechInsightsModelOutput(
  raw: string,
  headlineCount: number,
): TechInsightsParsed | null {
  if (headlineCount < 1) return null;

  let text = stripMarkdownFence(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const slice = sliceJsonObject(text);
    if (!slice) return null;
    try {
      parsed = JSON.parse(slice);
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const briefRaw = o.brief;
  const indicesRaw = o.indices;

  if (typeof briefRaw !== 'string') return null;
  const brief = briefRaw.trim();
  if (brief.length < 4) return null;

  if (!Array.isArray(indicesRaw) || indicesRaw.length < 1 || indicesRaw.length > MAX_INDICES) {
    return null;
  }

  const seen = new Set<number>();
  const indices: number[] = [];
  for (const item of indicesRaw) {
    const n = asPositiveInt(item);
    if (n === null || n > headlineCount || seen.has(n)) return null;
    seen.add(n);
    indices.push(n);
  }

  return { brief, indices };
}
