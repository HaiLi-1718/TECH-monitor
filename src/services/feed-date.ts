const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const MAX_PAST_AGE_MS = 365 * 24 * 60 * 60 * 1000;

function normalizeTimestamp(ts: number, now = Date.now()): number {
  if (!Number.isFinite(ts)) return now;
  if (ts > now + FUTURE_TOLERANCE_MS) return now;
  if (ts < now - MAX_PAST_AGE_MS) return now - MAX_PAST_AGE_MS;
  return ts;
}

function parseUnknownDate(value: string | null | undefined, now = Date.now()): number {
  if (!value) return now;
  const trimmed = value.trim();
  if (!trimmed) return now;

  const asNum = Number(trimmed);
  if (Number.isFinite(asNum)) {
    // Support seconds and milliseconds.
    const millis = asNum < 1e11 ? asNum * 1000 : asNum;
    return normalizeTimestamp(millis, now);
  }

  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return now;
  return normalizeTimestamp(parsed, now);
}

export function parseFeedDateOrNow(value: string | null | undefined): Date {
  const now = Date.now();
  const ts = parseUnknownDate(value, now);
  return new Date(ts);
}
