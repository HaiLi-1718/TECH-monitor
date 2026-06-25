/**
 * Local permanent news archive (IndexedDB).
 * Dedupes by stable id (link, or title+source+pubDate). No TTL — retention is until user clears or browser data is wiped.
 */

import type { NewsItem } from '@/types';
import { hashString } from '@/utils/hash';
import { isNewsArchiveEnabled } from './ai-flow-settings';

const DB_NAME = 'worldmonitor_news_archive';
const DB_VERSION = 2;
const STORE_NAME = 'articles';
const EXPORT_STATE_STORE = 'export_state';
const EXPORTED_IDS_KEY = 'exportedIds';

const HANDLE_DB_NAME = 'worldmonitor_fs_handles';
const HANDLE_DB_VERSION = 1;
const EXPORT_DIR_HANDLE_KEY = 'news-export-dir';

export interface ArchivedNewsRecord {
  id: string;
  category: string;
  source: string;
  title: string;
  link: string;
  pubDate: number;
  archivedAt: number;
  isAlert: boolean;
  lang?: string;
  locationName?: string;
  threatLevel?: string;
  threatCategory?: string;
}

export interface NewsArchiveStats {
  total: number;
  oldestPubDate: number | null;
  newestPubDate: number | null;
}

export interface ListArchivedNewsOptions {
  limit?: number;
  offset?: number;
  category?: string;
  source?: string;
  since?: number;
  until?: number;
}

let db: IDBDatabase | null = null;
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const task = queue.then(fn, () => fn());
  queue = task.then(() => {}, () => {});
  return task;
}

function openDB(): Promise<IDBDatabase> {
  if (db) return Promise.resolve(db);
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB unavailable'));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error('Failed to open news archive DB'));
    request.onsuccess = () => {
      db = request.result;
      db.onclose = () => { db = null; };
      resolve(db);
    };
    request.onupgradeneeded = (event) => {
      const database = (event.target as IDBOpenDBRequest).result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('by_pubDate', 'pubDate');
        store.createIndex('by_category', 'category');
        store.createIndex('by_source', 'source');
        store.createIndex('by_archivedAt', 'archivedAt');
      }
      if (!database.objectStoreNames.contains(EXPORT_STATE_STORE)) {
        database.createObjectStore(EXPORT_STATE_STORE, { keyPath: 'key' });
      }
    };
  });
}

export function makeArchiveId(item: Pick<NewsItem, 'link' | 'title' | 'source' | 'pubDate'>): string {
  const link = (item.link || '').trim();
  if (link) return `link:${hashString(link)}`;
  const pubMs = item.pubDate instanceof Date ? item.pubDate.getTime() : Number(item.pubDate);
  return `fallback:${hashString(JSON.stringify([item.source, item.title, pubMs]))}`;
}

function toArchivedRecord(item: NewsItem, category: string, now: number): ArchivedNewsRecord {
  const pubMs = item.pubDate instanceof Date ? item.pubDate.getTime() : Number(item.pubDate);
  return {
    id: makeArchiveId(item),
    category,
    source: item.source,
    title: item.title.slice(0, 2000),
    link: (item.link || '').slice(0, 4000),
    pubDate: Number.isFinite(pubMs) ? pubMs : now,
    archivedAt: now,
    isAlert: Boolean(item.isAlert),
    ...(item.lang ? { lang: item.lang } : {}),
    ...(item.locationName ? { locationName: item.locationName } : {}),
    ...(item.threat?.level ? { threatLevel: item.threat.level } : {}),
    ...(item.threat?.category ? { threatCategory: item.threat.category } : {}),
  };
}

/** Upsert headlines from a category refresh. Skipped when archive is disabled. */
export function archiveNewsItems(items: NewsItem[], category: string): Promise<number> {
  if (!isNewsArchiveEnabled() || items.length === 0) return Promise.resolve(0);

  return enqueue(async () => {
    const database = await openDB();
    const now = Date.now();
    let written = 0;

    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      for (const item of items) {
        const title = item.title?.trim();
        if (!title) continue;
        const record = toArchivedRecord(item, category, now);
        store.put(record);
        written += 1;
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    return written;
  });
}

export function listArchivedNews(options: ListArchivedNewsOptions = {}): Promise<ArchivedNewsRecord[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const offset = Math.max(0, options.offset ?? 0);

  return enqueue(async () => {
    const database = await openDB();
    const since = options.since ?? 0;
    const until = options.until ?? Number.MAX_SAFE_INTEGER;

    const rows = await new Promise<ArchivedNewsRecord[]>((resolve, reject) => {
      const tx = database.transaction(STORE_NAME, 'readonly');
      const index = tx.objectStore(STORE_NAME).index('by_pubDate');
      const range = IDBKeyRange.bound(since, until);
      const request = index.openCursor(range, 'prev');
      const collected: ArchivedNewsRecord[] = [];

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(collected);
          return;
        }
        const row = cursor.value as ArchivedNewsRecord;
        if (options.category && row.category !== options.category) {
          cursor.continue();
          return;
        }
        if (options.source && row.source !== options.source) {
          cursor.continue();
          return;
        }
        if (collected.length < offset + limit) {
          if (collected.length >= offset) collected.push(row);
        }
        if (collected.length >= offset + limit) {
          resolve(collected);
          return;
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });

    return rows;
  });
}

export function getNewsArchiveStats(): Promise<NewsArchiveStats> {
  return enqueue(async () => {
    const database = await openDB();
    return new Promise<NewsArchiveStats>((resolve, reject) => {
      const tx = database.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const countReq = store.count();
      let total = 0;
      let oldestPubDate: number | null = null;
      let newestPubDate: number | null = null;

      countReq.onsuccess = () => {
        total = countReq.result;
        if (total === 0) {
          resolve({ total: 0, oldestPubDate: null, newestPubDate: null });
          return;
        }

        const index = store.index('by_pubDate');
        const oldestReq = index.openCursor();
        oldestReq.onsuccess = () => {
          const oldest = oldestReq.result?.value as ArchivedNewsRecord | undefined;
          oldestPubDate = oldest?.pubDate ?? null;

          const newestReq = index.openCursor(null, 'prev');
          newestReq.onsuccess = () => {
            const newest = newestReq.result?.value as ArchivedNewsRecord | undefined;
            newestPubDate = newest?.pubDate ?? null;
            resolve({ total, oldestPubDate, newestPubDate });
          };
          newestReq.onerror = () => reject(newestReq.error);
        };
        oldestReq.onerror = () => reject(oldestReq.error);
      };
      countReq.onerror = () => reject(countReq.error);
    });
  });
}

export async function exportNewsArchiveJson(): Promise<string> {
  const database = await openDB();
  const all = await new Promise<ArchivedNewsRecord[]>((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve((req.result as ArchivedNewsRecord[]) ?? []);
    req.onerror = () => reject(req.error);
  });
  all.sort((a, b) => b.pubDate - a.pubDate);
  return JSON.stringify(
    { exportedAt: new Date().toISOString(), count: all.length, articles: all },
    null,
    2,
  );
}

export function downloadNewsArchiveExport(): Promise<void> {
  return exportNewsArchiveJson().then((json) => {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `news-archive-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

export function clearNewsArchive(): Promise<void> {
  return enqueue(async () => {
    const database = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction([STORE_NAME, EXPORT_STATE_STORE], 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.objectStore(EXPORT_STATE_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  });
}

async function readExportedIdSet(db: IDBDatabase): Promise<Set<string>> {
  const row = await new Promise<{ key: string; ids: string[] } | undefined>((resolve, reject) => {
    const tx = db.transaction(EXPORT_STATE_STORE, 'readonly');
    const req = tx.objectStore(EXPORT_STATE_STORE).get(EXPORTED_IDS_KEY);
    req.onsuccess = () => resolve(req.result as { key: string; ids: string[] } | undefined);
    req.onerror = () => reject(req.error);
  });
  return new Set(Array.isArray(row?.ids) ? row.ids : []);
}

async function readAllArticles(db: IDBDatabase): Promise<ArchivedNewsRecord[]> {
  return new Promise<ArchivedNewsRecord[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve((req.result as ArchivedNewsRecord[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}

export function listAllArchivedArticles(): Promise<ArchivedNewsRecord[]> {
  return enqueue(async () => readAllArticles(await openDB()));
}

export function loadExportedIdSet(): Promise<Set<string>> {
  return enqueue(async () => readExportedIdSet(await openDB()));
}

export function addExportedIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return Promise.resolve();
  return enqueue(async () => {
    const database = await openDB();
    const existing = await readExportedIdSet(database);
    for (const id of ids) existing.add(id);
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(EXPORT_STATE_STORE, 'readwrite');
      tx.objectStore(EXPORT_STATE_STORE).put({ key: EXPORTED_IDS_KEY, ids: [...existing] });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  });
}

export function listUnexportedArticles(): Promise<ArchivedNewsRecord[]> {
  return enqueue(async () => {
    const database = await openDB();
    const [all, exported] = await Promise.all([
      readAllArticles(database),
      readExportedIdSet(database),
    ]);
    return all.filter((row) => !exported.has(row.id));
  });
}

export function isFileSystemAccessSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HANDLE_DB_NAME, HANDLE_DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error('Failed to open handle DB'));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('handles')) {
        database.createObjectStore('handles', { keyPath: 'key' });
      }
    };
  });
}

export async function saveExportDirectoryHandle(handle: FileSystemDirectoryHandle, displayName: string): Promise<void> {
  const db = await openHandleDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').put({ key: EXPORT_DIR_HANDLE_KEY, handle, displayName });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadExportDirectoryHandle(): Promise<{ handle: FileSystemDirectoryHandle; displayName: string } | null> {
  if (!isFileSystemAccessSupported()) return null;
  const db = await openHandleDb();
  const row = await new Promise<{ key: string; handle: FileSystemDirectoryHandle; displayName?: string } | undefined>((resolve, reject) => {
    const tx = db.transaction('handles', 'readonly');
    const req = tx.objectStore('handles').get(EXPORT_DIR_HANDLE_KEY);
    req.onsuccess = () => resolve(req.result as { key: string; handle: FileSystemDirectoryHandle; displayName?: string } | undefined);
    req.onerror = () => reject(req.error);
  });
  if (!row?.handle) return null;
  return { handle: row.handle, displayName: row.displayName || row.handle.name || '' };
}

export async function clearExportDirectoryHandle(): Promise<void> {
  const db = await openHandleDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').delete(EXPORT_DIR_HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function pickExportDirectory(): Promise<{ handle: FileSystemDirectoryHandle; displayName: string } | null> {
  if (!isFileSystemAccessSupported()) return null;
  const handle = await window.showDirectoryPicker!({ mode: 'readwrite' });
  const displayName = handle.name || '';
  await saveExportDirectoryHandle(handle, displayName);
  return { handle, displayName };
}

async function ensureDirectoryPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const opts = { mode: 'readwrite' as const };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}

export type NewsExportLayout = 'flat' | 'category-date';
export type NewsExportDateBasis = 'pubDate' | 'archivedAt';

export const DEFAULT_NEWS_EXPORT_TIMEZONE = 'Asia/Shanghai';

export interface DeltaExportOptions {
  /** 'category-date' (default) writes data/{category}/{date}/delta-HHMMSS.json; 'flat' keeps one news-delta-*.json at the root. */
  layout?: NewsExportLayout;
  /** Which timestamp decides the date folder. Default 'pubDate'. */
  dateBasis?: NewsExportDateBasis;
  /** IANA timezone for the date folder and file time. Default Asia/Shanghai. */
  timezone?: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatExportFileStamp(date: Date): string {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

/** YYYY-MM-DD for a timestamp in the given IANA timezone; falls back to local time on an invalid zone. */
function formatDateInTimezone(ms: number, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(ms));
    const year = parts.find((p) => p.type === 'year')?.value;
    const month = parts.find((p) => p.type === 'month')?.value;
    const day = parts.find((p) => p.type === 'day')?.value;
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch { /* invalid timezone — fall through to local time */ }
  const dt = new Date(ms);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

/** HHMMSS for a timestamp in the given IANA timezone; falls back to local time on an invalid zone. */
function formatTimeInTimezone(ms: number, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(ms));
    const hour = parts.find((p) => p.type === 'hour')?.value;
    const minute = parts.find((p) => p.type === 'minute')?.value;
    const second = parts.find((p) => p.type === 'second')?.value;
    if (hour && minute && second) return `${hour}${minute}${second}`;
  } catch { /* invalid timezone — fall through to local time */ }
  const dt = new Date(ms);
  return `${pad2(dt.getHours())}${pad2(dt.getMinutes())}${pad2(dt.getSeconds())}`;
}

/** Make a category usable as a single path segment (categories are slugs like `ai`, but stay defensive). */
function sanitizePathSegment(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned || 'uncategorized';
}

/** Resolve (creating as needed) a nested subdirectory under root, e.g. ['data', category, date]. */
async function resolveExportPath(
  root: FileSystemDirectoryHandle,
  segments: string[],
): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const segment of segments) {
    dir = await dir.getDirectoryHandle(segment, { create: true });
  }
  return dir;
}

export async function writeDeltaExportFile(
  dir: FileSystemDirectoryHandle,
  articles: ArchivedNewsRecord[],
  fileName: string,
): Promise<string> {
  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  const payload = JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      count: articles.length,
      articles,
    },
    null,
    2,
  );
  const writable = await fileHandle.createWritable();
  await writable.write(payload);
  await writable.close();
  return fileName;
}

export interface DeltaExportFileInfo {
  category: string;
  date: string;
  fileName: string;
  count: number;
}

export interface DeltaExportResult {
  ok: boolean;
  files: DeltaExportFileInfo[];
  totalCount: number;
  skipped: boolean;
  error?: string;
}

export async function exportUnexportedArticlesToDirectory(
  options: DeltaExportOptions = {},
): Promise<DeltaExportResult> {
  const layout: NewsExportLayout = options.layout === 'flat' ? 'flat' : 'category-date';
  const dateBasis: NewsExportDateBasis = options.dateBasis === 'archivedAt' ? 'archivedAt' : 'pubDate';
  const timezone = options.timezone || DEFAULT_NEWS_EXPORT_TIMEZONE;

  const stored = await loadExportDirectoryHandle();
  if (!stored) {
    return { ok: false, files: [], totalCount: 0, skipped: false, error: 'NO_DIRECTORY' };
  }
  if (!(await ensureDirectoryPermission(stored.handle))) {
    return { ok: false, files: [], totalCount: 0, skipped: false, error: 'PERMISSION_DENIED' };
  }

  const pending = await listUnexportedArticles();
  if (pending.length === 0) {
    return { ok: true, files: [], totalCount: 0, skipped: true };
  }

  const now = Date.now();

  // Legacy flat layout: one news-delta-*.json at the chosen root.
  if (layout === 'flat') {
    pending.sort((a, b) => b.pubDate - a.pubDate);
    const fileName = await writeDeltaExportFile(
      stored.handle,
      pending,
      `news-delta-${formatExportFileStamp(new Date(now))}.json`,
    );
    await addExportedIds(pending.map((row) => row.id));
    return {
      ok: true,
      files: [{ category: '', date: '', fileName, count: pending.length }],
      totalCount: pending.length,
      skipped: false,
    };
  }

  // Layered layout: group by (category, date), then write data/{category}/{date}/delta-HHMMSS.json.
  const groups = new Map<string, { category: string; date: string; rows: ArchivedNewsRecord[] }>();
  for (const row of pending) {
    const category = sanitizePathSegment(row.category || 'uncategorized');
    const basisMs = dateBasis === 'archivedAt' ? row.archivedAt : row.pubDate;
    const date = formatDateInTimezone(Number.isFinite(basisMs) ? basisMs : now, timezone);
    const key = `${category} ${date}`;
    let group = groups.get(key);
    if (!group) {
      group = { category, date, rows: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
  }

  const timeStamp = formatTimeInTimezone(now, timezone);
  const files: DeltaExportFileInfo[] = [];
  const exportedIds: string[] = [];

  for (const group of groups.values()) {
    if (group.rows.length === 0) continue; // never write empty files or create empty dirs
    group.rows.sort((a, b) => b.pubDate - a.pubDate);
    const dir = await resolveExportPath(stored.handle, ['data', group.category, group.date]);
    const fileName = await writeDeltaExportFile(dir, group.rows, `delta-${timeStamp}.json`);
    files.push({ category: group.category, date: group.date, fileName, count: group.rows.length });
    for (const row of group.rows) exportedIds.push(row.id);
  }

  // Mark exported only after every group wrote successfully (a throw above retries the whole batch next run).
  await addExportedIds(exportedIds);
  return { ok: true, files, totalCount: exportedIds.length, skipped: false };
}
