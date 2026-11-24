const PANO_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,160}$/;
const PLACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const LANGUAGE_PATTERN = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/;
const REGION_PATTERN = /^[A-Za-z]{2}$/;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;

export function parseLatitude(value: unknown): number | null {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num < -90 || num > 90) {
    return null;
  }
  return num;
}

export function parseLongitude(value: unknown): number | null {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num < -180 || num > 180) {
    return null;
  }
  return num;
}

export function parseRadius(value: unknown, fallback = 50): number {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.max(5, Math.min(5000, Math.round(num)));
}

export function isValidPanoId(value: unknown): value is string {
  return typeof value === 'string' && PANO_ID_PATTERN.test(value);
}

export function isValidPlaceId(value: unknown): value is string {
  return typeof value === 'string' && PLACE_ID_PATTERN.test(value);
}

export function parseTileCoordinate(
  value: unknown,
  min: number,
  max: number,
): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }
  const num = Number(value);
  if (!Number.isInteger(num) || num < min || num > max) {
    return null;
  }
  return num;
}

export function sanitizeLanguage(value: unknown, fallback = 'en-US'): string {
  if (typeof value === 'string' && LANGUAGE_PATTERN.test(value.trim())) {
    return value.trim();
  }
  return fallback;
}

export function sanitizeRegion(value: unknown, fallback = 'US'): string {
  if (typeof value === 'string' && REGION_PATTERN.test(value.trim())) {
    return value.trim().toUpperCase();
  }
  return fallback;
}

export function sanitizeSessionToken(value: unknown): string | undefined {
  if (typeof value === 'string' && SESSION_TOKEN_PATTERN.test(value.trim())) {
    return value.trim();
  }
  return undefined;
}

export function sanitizeQueryText(value: unknown, maxLength = 200): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    return null;
  }
  return trimmed;
}
