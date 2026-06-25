import {
  DEFAULT_NEWS_EXPORT_TIMEZONE,
  exportUnexportedArticlesToDirectory,
  isFileSystemAccessSupported,
  loadExportDirectoryHandle,
  pickExportDirectory,
  type NewsExportDateBasis,
  type NewsExportLayout,
} from './news-archive';
import { isNewsArchiveEnabled } from './ai-flow-settings';

export const AUTO_EXPORT_INTERVAL_OPTIONS = [
  { value: 15, labelKey: '15m' },
  { value: 30, labelKey: '30m' },
  { value: 60, labelKey: '1h' },
  { value: 120, labelKey: '2h' },
  { value: 360, labelKey: '6h' },
  { value: 1440, labelKey: '24h' },
] as const;

const STORAGE_ENABLED = 'wm-news-auto-export';
const STORAGE_INTERVAL = 'wm-news-auto-export-interval-min';
const STORAGE_DIR_LABEL = 'wm-news-auto-export-dir-label';
const STORAGE_LAST_RUN = 'wm-news-auto-export-last-run';
const STORAGE_LAST_FILE = 'wm-news-auto-export-last-file';
const STORAGE_LAST_COUNT = 'wm-news-auto-export-last-count';
const STORAGE_LAST_FILE_COUNT = 'wm-news-auto-export-last-file-count';
const STORAGE_LAYOUT = 'wm-news-export-layout';
const STORAGE_DATE_BASIS = 'wm-news-export-date-basis';
const STORAGE_TIMEZONE = 'wm-news-export-timezone';
const EVENT_NAME = 'news-archive-auto-export-changed';

let timerId: ReturnType<typeof setInterval> | null = null;
let running = false;

function readBool(key: string, defaultValue: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return defaultValue;
    return raw === 'true';
  } catch {
    return defaultValue;
  }
}

function writeBool(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch { /* ignore */ }
}

function readNumber(key: string, defaultValue: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return defaultValue;
    const n = Number(raw);
    return Number.isFinite(n) ? n : defaultValue;
  } catch {
    return defaultValue;
  }
}

function writeString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch { /* ignore */ }
}

export function isAutoExportEnabled(): boolean {
  return readBool(STORAGE_ENABLED, false);
}

export function setAutoExportEnabled(value: boolean): void {
  writeBool(STORAGE_ENABLED, value);
  notifyChanged();
}

export function getAutoExportIntervalMinutes(): number {
  const n = readNumber(STORAGE_INTERVAL, 60);
  const allowed = AUTO_EXPORT_INTERVAL_OPTIONS.map((o) => o.value);
  return allowed.includes(n as (typeof allowed)[number]) ? n : 60;
}

export function setAutoExportIntervalMinutes(minutes: number): void {
  writeString(STORAGE_INTERVAL, String(minutes));
  notifyChanged();
}

export function getAutoExportDirLabel(): string {
  try {
    return localStorage.getItem(STORAGE_DIR_LABEL) || '';
  } catch {
    return '';
  }
}

export function setAutoExportDirLabel(label: string): void {
  writeString(STORAGE_DIR_LABEL, label);
  notifyChanged();
}

export function getNewsExportLayout(): NewsExportLayout {
  try {
    return localStorage.getItem(STORAGE_LAYOUT) === 'flat' ? 'flat' : 'category-date';
  } catch {
    return 'category-date';
  }
}

export function setNewsExportLayout(value: NewsExportLayout): void {
  writeString(STORAGE_LAYOUT, value);
  notifyChanged();
}

export function getNewsExportDateBasis(): NewsExportDateBasis {
  try {
    return localStorage.getItem(STORAGE_DATE_BASIS) === 'archivedAt' ? 'archivedAt' : 'pubDate';
  } catch {
    return 'pubDate';
  }
}

export function setNewsExportDateBasis(value: NewsExportDateBasis): void {
  writeString(STORAGE_DATE_BASIS, value);
  notifyChanged();
}

export function getNewsExportTimezone(): string {
  try {
    return (localStorage.getItem(STORAGE_TIMEZONE) || '').trim() || DEFAULT_NEWS_EXPORT_TIMEZONE;
  } catch {
    return DEFAULT_NEWS_EXPORT_TIMEZONE;
  }
}

export function setNewsExportTimezone(value: string): void {
  writeString(STORAGE_TIMEZONE, value.trim());
  notifyChanged();
}

export interface AutoExportLastRun {
  at: number | null;
  fileName: string;
  count: number;
  fileCount: number;
}

export function getAutoExportLastRun(): AutoExportLastRun {
  return {
    at: readNumber(STORAGE_LAST_RUN, 0) || null,
    fileName: (() => {
      try { return localStorage.getItem(STORAGE_LAST_FILE) || ''; } catch { return ''; }
    })(),
    count: readNumber(STORAGE_LAST_COUNT, 0),
    fileCount: readNumber(STORAGE_LAST_FILE_COUNT, 0),
  };
}

function recordLastRun(count: number, fileCount: number, fileName: string): void {
  writeString(STORAGE_LAST_RUN, String(Date.now()));
  writeString(STORAGE_LAST_FILE, fileName);
  writeString(STORAGE_LAST_COUNT, String(count));
  writeString(STORAGE_LAST_FILE_COUNT, String(fileCount));
}

export function notifyChanged(): void {
  window.dispatchEvent(new CustomEvent(EVENT_NAME));
}

export function subscribeAutoExportChange(cb: () => void): () => void {
  const handler = () => cb();
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}

export async function chooseAutoExportDirectory(): Promise<string | null> {
  const picked = await pickExportDirectory();
  if (!picked) return null;
  setAutoExportDirLabel(picked.displayName);
  return picked.displayName;
}

export async function runAutoExportOnce(): Promise<{ ok: boolean; message: string }> {
  if (!isFileSystemAccessSupported()) {
    return { ok: false, message: 'UNSUPPORTED' };
  }
  if (!isNewsArchiveEnabled()) {
    return { ok: false, message: 'ARCHIVE_OFF' };
  }
  if (running) {
    return { ok: false, message: 'BUSY' };
  }

  running = true;
  try {
    const dir = await loadExportDirectoryHandle();
    if (!dir) {
      return { ok: false, message: 'NO_DIRECTORY' };
    }
    setAutoExportDirLabel(dir.displayName);

    const result = await exportUnexportedArticlesToDirectory({
      layout: getNewsExportLayout(),
      dateBasis: getNewsExportDateBasis(),
      timezone: getNewsExportTimezone(),
    });
    if (!result.ok) {
      if (result.error === 'PERMISSION_DENIED') return { ok: false, message: 'PERMISSION_DENIED' };
      if (result.error === 'NO_DIRECTORY') return { ok: false, message: 'NO_DIRECTORY' };
      return { ok: false, message: 'FAILED' };
    }
    if (result.skipped) {
      recordLastRun(0, 0, '');
      return { ok: true, message: 'SKIPPED_EMPTY' };
    }
    const singleFileName = result.files.length === 1 ? (result.files[0]?.fileName ?? '') : '';
    recordLastRun(result.totalCount, result.files.length, singleFileName);
    return { ok: true, message: 'EXPORTED' };
  } catch {
    return { ok: false, message: 'FAILED' };
  } finally {
    running = false;
  }
}

export function startNewsArchiveAutoExportScheduler(): void {
  stopNewsArchiveAutoExportScheduler();
  if (!isAutoExportEnabled() || !isFileSystemAccessSupported()) return;

  const tick = () => {
    if (!isAutoExportEnabled() || !isNewsArchiveEnabled()) return;
    void runAutoExportOnce();
  };

  void runAutoExportOnce();
  const ms = getAutoExportIntervalMinutes() * 60 * 1000;
  timerId = setInterval(tick, ms);
}

export function stopNewsArchiveAutoExportScheduler(): void {
  if (timerId !== null) {
    clearInterval(timerId);
    timerId = null;
  }
}

export function restartNewsArchiveAutoExportScheduler(): void {
  stopNewsArchiveAutoExportScheduler();
  startNewsArchiveAutoExportScheduler();
}
