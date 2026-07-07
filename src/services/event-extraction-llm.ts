import type { ClusteredEvent, ExtractedEvent, ExtractedEventSeverity } from '@/types';
import {
  IntelligenceServiceClient,
  ApiError,
  type EventClassification,
  type SeverityLevel,
} from '@/generated/client/worldmonitor/intelligence/v1/service_client';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { extractEntitiesFromCluster } from '@/services/entity-extraction';
import { getPersistentCache, setPersistentCache } from '@/services/persistent-cache';

const client = new IntelligenceServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });

// Cross-reload persistence: the tracked event log is mirrored to IndexedDB so a
// page refresh resumes the same events instead of starting from an empty board.
const PERSIST_KEY = 'tech-extracted-events:v1';

// Cost controls: only the top-N multi-source clusters are sent to the LLM per run.
const MAX_CLUSTERS_PER_RUN = 12;
const CALL_GAP_MS = 1200;
const MAX_SOURCES_STORED = 5;
// Lifecycle: tracked events persist across runs until they go stale.
const MAX_TRACKED = 60;
const EVENT_TTL_MS = 24 * 60 * 60 * 1000;
// Identity fallback: match a drifted cluster id to an existing event by title overlap.
const TITLE_SIM_THRESHOLD = 0.6;
const SEVERITY_WEIGHT: Record<ExtractedEventSeverity, number> = { high: 3, medium: 2, low: 1, unknown: 0 };

// Persistent event log keyed by the event's own id (the cluster id that first
// created it). LLM content is sticky — an event is only ever sent to the LLM
// once; later passes just refresh its lifecycle fields.
const trackedEvents = new Map<string, ExtractedEvent>();
let running = false;
let hasRun = false;
let lastCallAt = 0;
let hydratePromise: Promise<void> | null = null;

export function getExtractedEvents(): ExtractedEvent[] {
  return [...trackedEvents.values()].sort((a, b) => {
    const w = SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity];
    if (w !== 0) return w;
    return new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime();
  });
}

export function hasExtractionRun(): boolean {
  return hasRun;
}

// ── Persistence ──────────────────────────────────────────────────────────────

/**
 * Load the persisted event log into memory once. Stale entries are dropped on
 * load. Safe to call repeatedly — the underlying read happens at most once.
 * The panel awaits this so a refresh shows persisted events before any new run.
 */
export function ensureHydrated(): Promise<void> {
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    try {
      const cached = await getPersistentCache<ExtractedEvent[]>(PERSIST_KEY);
      if (cached?.data?.length) {
        const now = Date.now();
        for (const ev of cached.data) {
          if (now - new Date(ev.lastUpdated).getTime() > EVENT_TTL_MS) continue;
          // Reloaded events start with no "new activity" highlight.
          ev.hasNewActivity = false;
          if (!trackedEvents.has(ev.id)) trackedEvents.set(ev.id, ev);
        }
        // A prior session already ran extraction; treat the board as populated
        // so the panel shows events instead of the "extracting…" placeholder.
        if (trackedEvents.size > 0) hasRun = true;
      }
    } catch (err) {
      console.warn('[EventExtraction] hydrate failed:', err);
    }
  })();
  return hydratePromise;
}

async function persist(): Promise<void> {
  try {
    await setPersistentCache(PERSIST_KEY, [...trackedEvents.values()]);
  } catch (err) {
    console.warn('[EventExtraction] persist failed:', err);
  }
}

function severityFromProto(s: SeverityLevel): ExtractedEventSeverity {
  if (s === 'SEVERITY_LEVEL_HIGH') return 'high';
  if (s === 'SEVERITY_LEVEL_MEDIUM') return 'medium';
  if (s === 'SEVERITY_LEVEL_LOW') return 'low';
  return 'unknown';
}

function severityFromThreatLevel(level?: string): ExtractedEventSeverity {
  if (level === 'critical' || level === 'high') return 'high';
  if (level === 'medium') return 'medium';
  if (level === 'low' || level === 'info') return 'low';
  return 'unknown';
}

function buildFromClassification(cluster: ClusteredEvent, c: EventClassification): ExtractedEvent {
  return {
    id: cluster.id,
    title: cluster.primaryTitle,
    category: c.category || 'general',
    subcategory: c.subcategory || '',
    severity: severityFromProto(c.severity),
    confidence: c.confidence || 0.9,
    summary: c.analysis || '',
    entities: c.entities ?? [],
    sources: cluster.allItems.slice(0, MAX_SOURCES_STORED),
    sourceCount: cluster.sourceCount,
    link: cluster.primaryLink,
    firstSeen: cluster.firstSeen.toISOString(),
    lastUpdated: cluster.lastUpdated.toISOString(),
    updateCount: 0,
    hasNewActivity: false,
    lat: cluster.lat,
    lon: cluster.lon,
    extractionSource: 'llm',
  };
}

function buildFallback(cluster: ClusteredEvent): ExtractedEvent {
  const ctx = extractEntitiesFromCluster(cluster);
  return {
    id: cluster.id,
    title: cluster.primaryTitle,
    category: cluster.threat?.category || 'general',
    subcategory: cluster.threat?.level ?? '',
    severity: severityFromThreatLevel(cluster.threat?.level),
    confidence: cluster.threat?.confidence ?? 0.3,
    summary: '',
    entities: ctx.entities.slice(0, 6).map(e => e.name),
    sources: cluster.allItems.slice(0, MAX_SOURCES_STORED),
    sourceCount: cluster.sourceCount,
    link: cluster.primaryLink,
    firstSeen: cluster.firstSeen.toISOString(),
    lastUpdated: cluster.lastUpdated.toISOString(),
    updateCount: 0,
    hasNewActivity: false,
    lat: cluster.lat,
    lon: cluster.lon,
    extractionSource: 'fallback',
  };
}

// ── Identity + lifecycle ─────────────────────────────────────────────────────

function tokenize(title: string): Set<string> {
  return new Set(
    title.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Match a cluster to an already-tracked event by exact id, else title overlap. */
function findTracked(cluster: ClusteredEvent): ExtractedEvent | null {
  const byId = trackedEvents.get(cluster.id);
  if (byId) return byId;

  const tokens = tokenize(cluster.primaryTitle);
  let best: ExtractedEvent | null = null;
  let bestSim = 0;
  for (const ev of trackedEvents.values()) {
    const sim = jaccard(tokens, tokenize(ev.title));
    if (sim > bestSim) { bestSim = sim; best = ev; }
  }
  return bestSim >= TITLE_SIM_THRESHOLD ? best : null;
}

function grew(prev: ExtractedEvent, cluster: ClusteredEvent): boolean {
  return cluster.sourceCount > prev.sourceCount
    || cluster.lastUpdated.getTime() > new Date(prev.lastUpdated).getTime();
}

/** Fold fresh lifecycle data into an existing event, preserving its identity. */
function applyLifecycle(prev: ExtractedEvent, cluster: ClusteredEvent, content: ExtractedEvent): void {
  const bumped = grew(prev, cluster);
  // Keep prev.id + prev.firstSeen frozen; take new content but preserve the
  // original title so similarity matching stays stable across passes.
  prev.category = content.category;
  prev.subcategory = content.subcategory;
  prev.severity = content.severity;
  prev.confidence = content.confidence;
  if (content.summary) prev.summary = content.summary;
  if (content.entities.length) prev.entities = content.entities;
  prev.extractionSource = content.extractionSource;
  prev.sources = cluster.allItems.slice(0, MAX_SOURCES_STORED);
  prev.sourceCount = cluster.sourceCount;
  prev.link = cluster.primaryLink;
  if (cluster.lat != null) prev.lat = cluster.lat;
  if (cluster.lon != null) prev.lon = cluster.lon;
  if (bumped) {
    prev.lastUpdated = cluster.lastUpdated.toISOString();
    prev.updateCount += 1;
    prev.hasNewActivity = true;
  }
}

/** Refresh only lifecycle fields for a sticky LLM event (no re-classification). */
function refreshSticky(prev: ExtractedEvent, cluster: ClusteredEvent): void {
  const bumped = grew(prev, cluster);
  prev.sources = cluster.allItems.slice(0, MAX_SOURCES_STORED);
  prev.sourceCount = cluster.sourceCount;
  prev.link = cluster.primaryLink;
  if (cluster.lat != null) prev.lat = cluster.lat;
  if (cluster.lon != null) prev.lon = cluster.lon;
  if (bumped) {
    prev.lastUpdated = cluster.lastUpdated.toISOString();
    prev.updateCount += 1;
    prev.hasNewActivity = true;
  }
}

function expire(): void {
  const now = Date.now();
  for (const [id, ev] of trackedEvents) {
    if (now - new Date(ev.lastUpdated).getTime() > EVENT_TTL_MS) trackedEvents.delete(id);
  }
  if (trackedEvents.size > MAX_TRACKED) {
    const oldestFirst = [...trackedEvents.values()]
      .sort((a, b) => new Date(a.lastUpdated).getTime() - new Date(b.lastUpdated).getTime());
    for (let i = 0; i < trackedEvents.size - MAX_TRACKED; i++) {
      trackedEvents.delete(oldestFirst[i]!.id);
    }
  }
}

async function waitGap(): Promise<void> {
  const elapsed = Date.now() - lastCallAt;
  if (elapsed < CALL_GAP_MS) await new Promise(r => setTimeout(r, CALL_GAP_MS - elapsed));
  lastCallAt = Date.now();
}

async function classifyCluster(cluster: ClusteredEvent): Promise<ExtractedEvent> {
  const desc = cluster.allItems.slice(0, 5).map(i => `- ${i.title}`).join('\n');
  const resp = await client.classifyEvent({
    title: cluster.primaryTitle,
    description: desc,
    source: cluster.primarySource,
    country: '',
  });
  const c = resp.classification;
  return c?.analysis ? buildFromClassification(cluster, c) : buildFallback(cluster);
}

/**
 * Distill the top multi-source clusters into a persistent, deduplicated event
 * log. Each distinct event is sent to the LLM at most once; later passes fold
 * new source activity into the existing event (updating its lifecycle, marking
 * new activity) rather than re-classifying. Idempotent per run. Read results
 * via getExtractedEvents(); a run in flight is skipped.
 */
export async function extractEventsFromClusters(clusters: ClusteredEvent[]): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Merge with any persisted events before matching, so a refresh keeps
    // building on the prior board rather than duplicating events.
    await ensureHydrated();

    const candidates = [...clusters]
      .sort((a, b) => b.sourceCount - a.sourceCount)
      .slice(0, MAX_CLUSTERS_PER_RUN);

    const touched = new Set<string>();
    let paused = false;

    for (const cluster of candidates) {
      const matched = findTracked(cluster);
      if (matched && touched.has(matched.id)) continue;  // already handled this event this run

      // Sticky: an LLM-classified event is never re-sent to the LLM.
      if (matched?.extractionSource === 'llm') {
        refreshSticky(matched, cluster);
        touched.add(matched.id);
        continue;
      }

      // New event, or a fallback event we can try to upgrade.
      let content: ExtractedEvent;
      if (paused) {
        content = buildFallback(cluster);
      } else {
        await waitGap();
        try {
          content = await classifyCluster(cluster);
        } catch (err) {
          if (err instanceof ApiError && (err.statusCode === 401 || err.statusCode === 429 || err.statusCode >= 500)) {
            paused = true;
          }
          content = buildFallback(cluster);
        }
      }

      if (matched) {
        applyLifecycle(matched, cluster, content);
        touched.add(matched.id);
      } else {
        trackedEvents.set(content.id, content);
        touched.add(content.id);
      }
    }

    // Events not seen this run keep their data but lose the "new activity" flag.
    for (const [id, ev] of trackedEvents) {
      if (!touched.has(id)) ev.hasNewActivity = false;
    }

    expire();
    hasRun = true;
    await persist();
  } finally {
    running = false;
  }
}
