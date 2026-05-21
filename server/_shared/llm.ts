import { CHROME_UA } from './constants';
import { isProviderAvailable } from './llm-health';

export interface ProviderCredentials {
  apiUrl: string;
  model: string;
  headers: Record<string, string>;
  extraBody?: Record<string, unknown>;
}

const OLLAMA_HOST_ALLOWLIST = new Set([
  'localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal',
]);

function isLocalDeployment(): boolean {
  const mode = typeof process !== 'undefined' ? (process.env?.LOCAL_API_MODE || '') : '';
  return mode.includes('sidecar') || mode.includes('docker');
}

export function getProviderCredentials(provider: string): ProviderCredentials | null {
  if (provider === 'ollama') {
    const baseUrl = process.env.OLLAMA_API_URL;
    if (!baseUrl) return null;

    if (!isLocalDeployment()) {
      try {
        const hostname = new URL(baseUrl).hostname;
        if (!OLLAMA_HOST_ALLOWLIST.has(hostname)) {
          console.warn(`[llm] Ollama blocked: hostname "${hostname}" not in allowlist`);
          return null;
        }
      } catch {
        return null;
      }
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const apiKey = process.env.OLLAMA_API_KEY;
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    return {
      apiUrl: new URL('/v1/chat/completions', baseUrl).toString(),
      model: process.env.OLLAMA_MODEL || 'llama3.1:8b',
      headers,
      extraBody: { think: false },
    };
  }

  if (provider === 'groq') {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return null;
    return {
      apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
      model: 'llama-3.1-8b-instant',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    };
  }

  if (provider === 'openrouter') {
    // Only use explicit OPENROUTER_API_KEY; do NOT auto-detect from LLM_API_KEY.
    // (Region-blocked users rely on generic provider with LLM_API_URL + LLM_API_KEY.)
    const apiKey = (process.env.OPENROUTER_API_KEY || '').trim() || undefined;
    if (!apiKey) return null;
    const model =
      process.env.OPENROUTER_MODEL ||
      process.env.LLM_MODEL ||
      'google/gemini-2.5-flash';

    let apiUrl = 'https://openrouter.ai/api/v1/chat/completions';
    const rawUrl = process.env.LLM_API_URL?.trim();
    if (rawUrl) {
      try {
        if (new URL(rawUrl).hostname.includes('openrouter.ai')) {
          apiUrl = rawUrl;
        }
      } catch {
        /* keep default */
      }
    }

    return {
      apiUrl,
      model,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://worldmonitor.app',
        'X-Title': 'World Monitor',
      },
    };
  }

  // Generic OpenAI-compatible endpoint via LLM_API_URL/LLM_API_KEY/LLM_MODEL
  if (provider === 'generic') {
    const apiUrl = process.env.LLM_API_URL;
    const apiKey = process.env.LLM_API_KEY;
    if (!apiUrl || !apiKey) return null;
    let isOpenRouter = false;
    try {
      isOpenRouter = new URL(apiUrl).hostname.includes('openrouter.ai');
    } catch {
      isOpenRouter = false;
    }
    return {
      apiUrl,
      model: process.env.LLM_MODEL || 'gpt-3.5-turbo',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(isOpenRouter ? {
          'HTTP-Referer': 'https://worldmonitor.app',
          'X-Title': 'World Monitor',
        } : {}),
      },
    };
  }

  return null;
}

export function stripThinkingTags(text: string): string {
  let s = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\|thinking\|>[\s\S]*?<\|\/thinking\|>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .replace(/<reflection>[\s\S]*?<\/reflection>/gi, '')
    .replace(/<\|begin_of_thought\|>[\s\S]*?<\|end_of_thought\|>/gi, '')
    .trim();

  s = s
    .replace(/<think>[\s\S]*/gi, '')
    .replace(/<\|thinking\|>[\s\S]*/gi, '')
    .replace(/<reasoning>[\s\S]*/gi, '')
    .replace(/<reflection>[\s\S]*/gi, '')
    .replace(/<\|begin_of_thought\|>[\s\S]*/gi, '')
    .trim();

  return s;
}

const PROVIDER_CHAIN = ['ollama', 'groq', 'openrouter', 'generic'] as const;

export interface LlmCallOptions {
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  provider?: string;
  stripThinkingTags?: boolean;
  validate?: (content: string) => boolean;
}

export interface LlmCallResult {
  content: string;
  model: string;
  provider: string;
  tokens: number;
}

function extractContentFromMessage(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const msg = message as { content?: unknown };
  const content = msg.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in (part as Record<string, unknown>)) {
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .join('\n')
      .trim();
    return joined;
  }
  return '';
}

export interface LlmProviderDiagnostic {
  provider: string;
  configured: boolean;
  apiUrl?: string;
  model?: string;
  reachable?: boolean;
  ok: boolean;
  reason: string;
  httpStatus?: number;
  details?: string;
}

export async function callLlm(opts: LlmCallOptions): Promise<LlmCallResult | null> {
  const {
    messages,
    temperature = 0.3,
    maxTokens = 1500,
    timeoutMs = 25_000,
    provider: forcedProvider,
    stripThinkingTags: shouldStrip = true,
    validate,
  } = opts;

  const providers = forcedProvider ? [forcedProvider] : [...PROVIDER_CHAIN];

  for (const providerName of providers) {
    const creds = getProviderCredentials(providerName);
    if (!creds) {
      if (forcedProvider) return null;
      continue;
    }

    // Health gate: skip provider if endpoint is unreachable
    const healthy = await isProviderAvailable(creds.apiUrl);
    // Soft gate for cloud providers: probe can fail transiently while direct
    // completion requests still succeed; try anyway once.
    if (!healthy && providerName !== 'generic' && providerName !== 'openrouter') {
      console.warn(`[llm:${providerName}] Offline, skipping`);
      if (forcedProvider) return null;
      continue;
    }

    try {
      let resp: Response | null = null;
      let lastError: unknown = null;
      const requestTimeout = providerName === 'generic' || providerName === 'openrouter'
        ? Math.max(timeoutMs, 35_000)
        : timeoutMs;
      const maxAttempts = providerName === 'generic' || providerName === 'openrouter' ? 2 : 1;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          resp = await fetch(creds.apiUrl, {
            method: 'POST',
            headers: { ...creds.headers, 'User-Agent': CHROME_UA },
            body: JSON.stringify({
              ...creds.extraBody,
              model: creds.model,
              messages,
              temperature,
              max_tokens: maxTokens,
            }),
            signal: AbortSignal.timeout(requestTimeout),
          });
          break;
        } catch (error) {
          lastError = error;
          if (attempt >= maxAttempts) throw error;
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
      }
      if (!resp) throw (lastError instanceof Error ? lastError : new Error('LLM request failed'));

      if (!resp.ok) {
        console.warn(`[llm:${providerName}] HTTP ${resp.status}`);
        if (forcedProvider) return null;
        continue;
      }

      const data = (await resp.json()) as {
        choices?: Array<{ message?: unknown }>;
        usage?: { total_tokens?: number };
        output_text?: string;
      };

      let content = extractContentFromMessage(data.choices?.[0]?.message) || '';
      if (!content && typeof data.output_text === 'string') {
        content = data.output_text.trim();
      }
      if (!content) {
        if (forcedProvider) return null;
        continue;
      }

      const tokens = data.usage?.total_tokens ?? 0;

      if (shouldStrip) {
        content = stripThinkingTags(content);
        if (!content) {
          if (forcedProvider) return null;
          continue;
        }
      }

      if (validate && !validate(content)) {
        console.warn(`[llm:${providerName}] validate() rejected response, trying next`);
        if (forcedProvider) return null;
        continue;
      }

      return { content, model: creds.model, provider: providerName, tokens };
    } catch (err) {
      console.warn(`[llm:${providerName}] ${(err as Error).message}`);
      if (forcedProvider) return null;
    }
  }

  return null;
}

function classifyHttpFailure(status: number): string {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 404) return 'endpoint_or_model_not_found';
  if (status === 408) return 'upstream_timeout';
  if (status === 429) return 'rate_limit_or_quota';
  if (status >= 500) return 'provider_error';
  return 'request_failed';
}

export async function diagnoseLlmProviders(): Promise<{
  available: boolean;
  checkedAt: number;
  diagnostics: LlmProviderDiagnostic[];
}> {
  const diagnostics: LlmProviderDiagnostic[] = [];

  for (const providerName of PROVIDER_CHAIN) {
    const creds = getProviderCredentials(providerName);
    if (!creds) {
      diagnostics.push({
        provider: providerName,
        configured: false,
        ok: false,
        reason: 'not_configured',
      });
      continue;
    }

    const reachable = await isProviderAvailable(creds.apiUrl);
    if (!reachable) {
      diagnostics.push({
        provider: providerName,
        configured: true,
        apiUrl: creds.apiUrl,
        model: creds.model,
        reachable: false,
        ok: false,
        reason: 'provider_unreachable',
      });
      continue;
    }

    try {
      const resp = await fetch(creds.apiUrl, {
        method: 'POST',
        headers: { ...creds.headers, 'User-Agent': CHROME_UA },
        body: JSON.stringify({
          ...creds.extraBody,
          model: creds.model,
          messages: [{ role: 'user', content: 'Reply with: ok' }],
          temperature: 0,
          max_tokens: 8,
        }),
        signal: AbortSignal.timeout(8_000),
      });

      if (!resp.ok) {
        const bodyText = (await resp.text()).slice(0, 300);
        diagnostics.push({
          provider: providerName,
          configured: true,
          apiUrl: creds.apiUrl,
          model: creds.model,
          reachable: true,
          ok: false,
          reason: classifyHttpFailure(resp.status),
          httpStatus: resp.status,
          details: bodyText,
        });
        continue;
      }

      const data = (await resp.json()) as {
        choices?: Array<{ message?: unknown }>;
        output_text?: string;
      };
      const content = extractContentFromMessage(data.choices?.[0]?.message)
        || (typeof data.output_text === 'string' ? data.output_text.trim() : '');
      diagnostics.push({
        provider: providerName,
        configured: true,
        apiUrl: creds.apiUrl,
        model: creds.model,
        reachable: true,
        ok: content.length > 0,
        reason: content.length > 0 ? 'ok' : 'empty_content',
      });
    } catch (error) {
      diagnostics.push({
        provider: providerName,
        configured: true,
        apiUrl: creds.apiUrl,
        model: creds.model,
        reachable: true,
        ok: false,
        reason: 'request_exception',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    available: diagnostics.some((item) => item.ok),
    checkedAt: Date.now(),
    diagnostics,
  };
}
