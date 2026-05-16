import type {
  ServerContext,
  GetCountryIntelBriefRequest,
  GetCountryIntelBriefResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { cachedFetchJson } from '../../../_shared/redis';
import { UPSTREAM_TIMEOUT_MS, TIER1_COUNTRIES, sha256Hex } from './_shared';
import { callLlm, getProviderCredentials } from '../../../_shared/llm';

const INTEL_CACHE_TTL = 7200;
const MIN_BRIEF_LEN = 80;

function isBriefLikelyGrounded(brief: string, countryCode: string, countryName: string): boolean {
  const text = (brief || '').trim();
  if (text.length < MIN_BRIEF_LEN) return false;
  const lower = text.toLowerCase();
  const countryTokens = [countryCode.toLowerCase(), countryName.toLowerCase()].filter(Boolean);
  const mentionsCountry = countryTokens.some((token) => token.length >= 2 && lower.includes(token));
  if (!mentionsCountry) return false;

  const years = [...text.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => Number(m[0]));
  const thisYear = new Date().getFullYear();
  // Hard guard against stale fabricated narratives unless explicitly recent.
  if (years.some((y) => y < thisYear - 3)) return false;
  return true;
}

function buildConservativeFallbackBrief(countryName: string, contextSnapshot: string): string {
  const lines = contextSnapshot
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= 20)
    .slice(0, 2);
  const contextPart = lines.length > 0
    ? `Observed signals: ${lines.join(' | ')}.`
    : 'No sufficient verified context signals are currently available.';
  return `${countryName}: insufficient verified evidence for a high-confidence AI intelligence brief. ${contextPart} Please verify critical claims with primary sources before operational use.`;
}

export async function getCountryIntelBrief(
  ctx: ServerContext,
  req: GetCountryIntelBriefRequest,
): Promise<GetCountryIntelBriefResponse> {
  const isDev = (process.env.NODE_ENV || 'development') !== 'production';
  let countryCode = req.countryCode;
  const empty: GetCountryIntelBriefResponse = {
    countryCode,
    countryName: '',
    brief: '',
    model: '',
    generatedAt: Date.now(),
  };

  let contextSnapshot = '';
  let lang = 'en';
  try {
    const url = new URL(ctx.request.url);
    // Backward-compatible fallback for callers still sending ?code=CN
    const codeFallback = (url.searchParams.get('country_code') || url.searchParams.get('code') || '').trim();
    if (!countryCode && codeFallback) {
      countryCode = codeFallback.toUpperCase();
      empty.countryCode = countryCode;
    }
    contextSnapshot = (url.searchParams.get('context') || '').trim().slice(0, 4000);
    lang = url.searchParams.get('lang') || 'en';
  } catch {
    contextSnapshot = '';
  }

  if (!countryCode) return empty;

  const contextHash = contextSnapshot ? (await sha256Hex(contextSnapshot)).slice(0, 16) : 'base';
  const cacheKey = `ci-sebuf:v2:${countryCode}:${lang}:${contextHash}`;
  const countryName = TIER1_COUNTRIES[countryCode] || countryCode;
  const conservativeFallback = buildConservativeFallbackBrief(countryName, contextSnapshot);
  const dateStr = new Date().toISOString().split('T')[0];

  const systemPrompt = `You are a senior intelligence analyst providing comprehensive country situation briefs. Current date: ${dateStr}. Provide geopolitical context appropriate for the current date.

Write a concise intelligence brief for the requested country covering:
1. Current Situation - what is happening right now
2. Military & Security Posture
3. Key Risk Factors
4. Regional Context
5. Outlook & Watch Items

Rules:
- Be specific and analytical
- 3 short paragraphs, 120-180 words total
- No speculation beyond what data supports
- Use plain language, not jargon
- Use only facts from the provided context and widely stable background facts
- If evidence is insufficient, explicitly say "insufficient verified evidence"
- If a context snapshot is provided, explicitly reflect each non-zero signal category in the brief${lang === 'fr' ? '\n- IMPORTANT: You MUST respond ENTIRELY in French language.' : ''}`;

  const userPromptParts = [`Country: ${countryName} (${req.countryCode})`];
  if (contextSnapshot) {
    userPromptParts.push(`Context snapshot:\n${contextSnapshot}`);
  }

  let result: GetCountryIntelBriefResponse | null = null;
  try {
    result = await cachedFetchJson<GetCountryIntelBriefResponse>(cacheKey, INTEL_CACHE_TTL, async () => {
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPromptParts.join('\n\n') },
      ];

      let llmResult = await callLlm({
        messages,
        temperature: 0.4,
        maxTokens: 420,
        timeoutMs: UPSTREAM_TIMEOUT_MS,
      });

      // Fallback: when stripThinkingTags clears valid content, retry generic once
      // without stripping to maximize visible AI output in local/dev setups.
      if (!llmResult && getProviderCredentials('generic')) {
        llmResult = await callLlm({
          messages,
          provider: 'generic',
          stripThinkingTags: false,
          temperature: 0.4,
          maxTokens: 420,
          timeoutMs: UPSTREAM_TIMEOUT_MS,
          validate: (content) => content.trim().length >= 40,
        });
      }

      // Final fallback: shorten prompt when large context causes weak/empty replies.
      if (!llmResult && contextSnapshot) {
        llmResult = await callLlm({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Country: ${countryName} (${countryCode})` },
          ],
          provider: getProviderCredentials('generic') ? 'generic' : undefined,
          stripThinkingTags: false,
          temperature: 0.4,
          maxTokens: 320,
          timeoutMs: UPSTREAM_TIMEOUT_MS,
          validate: (content) => content.trim().length >= 40,
        });
      }

      if (!llmResult) return null;
      if (!isBriefLikelyGrounded(llmResult.content, countryCode, countryName)) return null;

      return {
        countryCode,
        countryName,
        brief: llmResult.content,
        model: llmResult.model,
        generatedAt: Date.now(),
      };
    });
  } catch (error) {
    console.warn('[country-intel-brief] LLM generation failed', countryCode, error);
    if (isDev) {
      return {
        ...empty,
        countryCode,
        countryName,
        brief: '[DEV] LLM request failed. Check LLM_API_URL / LLM_API_KEY / model, and server logs.',
        model: 'guarded-fallback',
      };
    }
    return {
      ...empty,
      countryCode,
      countryName,
      brief: conservativeFallback,
      model: 'guarded-fallback',
    };
  }

  if (result) return result;
  if (isDev) {
    return {
      ...empty,
      countryCode,
      countryName,
      brief: '[DEV] LLM output failed grounding checks. Showing no brief to avoid hallucinated intelligence.',
      model: 'guarded-fallback',
    };
  }
  return {
    ...empty,
    countryCode,
    countryName,
    brief: conservativeFallback,
    model: 'guarded-fallback',
  };
}
