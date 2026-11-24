import type { PanoramaMetadata, StreetViewLink } from '../types/streetview';
import { formatStreetAndLocation, offsetCoordinates } from '../utils/geo';

export class StreetViewApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly isQuotaError: boolean;
  public readonly isAuthError: boolean;

  constructor(
    status: number,
    code: string,
    message: string,
    options?: { isQuotaError?: boolean; isAuthError?: boolean },
  ) {
    super(message);
    this.name = 'StreetViewApiError';
    this.status = status;
    this.code = code;
    this.isQuotaError = Boolean(options?.isQuotaError);
    this.isAuthError = Boolean(options?.isAuthError);
  }
}

interface RawMetadataResponse {
  panoId?: string;
  lat?: number;
  lng?: number;
  originalLat?: number;
  originalLng?: number;
  imageHeight?: number;
  imageWidth?: number;
  tileHeight?: number;
  tileWidth?: number;
  heading?: number;
  tilt?: number;
  roll?: number;
  imageryType?: string;
  date?: string;
  copyright?: string;
  reportProblemLink?: string;
  addressComponents?: Array<{
    longName?: string;
    shortName?: string;
    types?: string[];
  }>;
  links?: Array<{
    panoId?: string;
    heading?: number;
    text?: string;
  }>;
  error?: {
    code?: string;
    message?: string;
    isQuotaError?: boolean;
    isAuthError?: boolean;
  };
}

export function notifyQuotaExceededIfApplicable(status: number, code?: string): void {
  if (
    typeof window !== 'undefined' &&
    (status === 429 || code === 'RESOURCE_EXHAUSTED')
  ) {
    window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
  }
}

export function normalizeMetadataResponse(raw: RawMetadataResponse): PanoramaMetadata {
  if (!raw.panoId || typeof raw.lat !== 'number' || typeof raw.lng !== 'number') {
    throw new StreetViewApiError(
      404,
      'NO_COVERAGE',
      'No Street View panorama metadata was returned for this location.',
    );
  }

  const addressComponents = Array.isArray(raw.addressComponents)
    ? raw.addressComponents.map((c) => ({
        longName: c.longName || '',
        shortName: c.shortName || c.longName || '',
        types: Array.isArray(c.types) ? c.types : [],
      }))
    : [];

  const { streetName, formattedLocation } = formatStreetAndLocation(
    addressComponents,
    raw.lat,
    raw.lng,
  );

  const seenLinks = new Set<string>();
  const links: StreetViewLink[] = [];
  if (Array.isArray(raw.links)) {
    for (const item of raw.links) {
      if (!item?.panoId || item.panoId === raw.panoId || seenLinks.has(item.panoId)) {
        continue;
      }
      seenLinks.add(item.panoId);
      links.push({
        panoId: item.panoId,
        heading: typeof item.heading === 'number' && Number.isFinite(item.heading) ? item.heading : 0,
        text: item.text || undefined,
      });
    }
  }

  return {
    panoId: raw.panoId,
    lat: raw.lat,
    lng: raw.lng,
    originalLat: raw.originalLat,
    originalLng: raw.originalLng,
    imageHeight: raw.imageHeight || 6656,
    imageWidth: raw.imageWidth || 13312,
    tileHeight: raw.tileHeight || 512,
    tileWidth: raw.tileWidth || 512,
    heading: typeof raw.heading === 'number' && Number.isFinite(raw.heading) ? raw.heading : 0,
    tilt: raw.tilt,
    roll: raw.roll,
    imageryType: raw.imageryType || 'outdoor',
    date: raw.date,
    copyright: raw.copyright || '© Google',
    reportProblemLink:
      raw.reportProblemLink ||
      `https://cbks0.googleapis.com/cbk?output=report&panoid=${encodeURIComponent(raw.panoId)}`,
    addressComponents,
    links,
    streetName,
    formattedLocation,
  };
}

const MAX_SESSION_METADATA_CACHE = 120;

export class PanoramaMetadataService {
  private readonly cache = new Map<string, PanoramaMetadata>();
  private readonly inflight = new Map<string, Promise<PanoramaMetadata>>();
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;

  constructor(fetchImpl?: typeof fetch, apiBase = '/api/streetview') {
    this.fetchImpl =
      !fetchImpl || fetchImpl === globalThis.fetch
        ? (input, init) => globalThis.fetch(input, init)
        : (input, init) => fetchImpl(input, init);
    this.apiBase = apiBase;
  }

  private setCache(panoId: string, metadata: PanoramaMetadata): void {
    if (this.cache.has(panoId)) {
      this.cache.delete(panoId);
    }
    this.cache.set(panoId, metadata);
    if (this.cache.size > MAX_SESSION_METADATA_CACHE) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }
  }

  public getCachedByPanoId(panoId: string): PanoramaMetadata | undefined {
    return this.cache.get(panoId);
  }

  public clearCache(): void {
    this.cache.clear();
    this.inflight.clear();
  }

  public async getMetadataByPanoId(
    panoId: string,
    signal?: AbortSignal,
  ): Promise<PanoramaMetadata> {
    const cached = this.cache.get(panoId);
    if (cached) {
      return cached;
    }

    const requestKey = `pano:${panoId}`;
    const existing = this.inflight.get(requestKey);
    if (existing) {
      return existing;
    }

    const promise = this.requestMetadata(
      `${this.apiBase}/metadata?panoId=${encodeURIComponent(panoId)}`,
      signal,
    ).finally(() => {
      this.inflight.delete(requestKey);
    });

    this.inflight.set(requestKey, promise);
    return promise;
  }

  public async getMetadataByLocation(
    lat: number,
    lng: number,
    radius = 50,
    signal?: AbortSignal,
  ): Promise<PanoramaMetadata> {
    const requestKey = `loc:${lat.toFixed(5)},${lng.toFixed(5)},${radius}`;
    const existing = this.inflight.get(requestKey);
    if (existing) {
      return existing;
    }

    const url = `${this.apiBase}/metadata?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}&radius=${encodeURIComponent(radius)}`;
    const promise = this.requestMetadata(url, signal).finally(() => {
      this.inflight.delete(requestKey);
    });

    this.inflight.set(requestKey, promise);
    return promise;
  }

  /**
   * Attempts to find the nearest verified Street View panorama when an exact
   * coordinate lacks coverage, probing progressively wider radii and nearby road offsets.
   */
  public async findNearbyCoveredLocation(
    lat: number,
    lng: number,
    signal?: AbortSignal,
  ): Promise<PanoramaMetadata | null> {
    const radii = [150, 500, 1500];
    for (const radius of radii) {
      try {
        return await this.getMetadataByLocation(lat, lng, radius, signal);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw err;
        }
        if (err instanceof StreetViewApiError && (err.isAuthError || err.isQuotaError)) {
          throw err;
        }
      }
    }

    // Try a small ring of 4 cardinal probe points via /panoIds
    const probeOffsets = [0, 90, 180, 270].map((bearing) =>
      offsetCoordinates(lat, lng, 300, bearing),
    );
    try {
      const response = await this.fetchImpl(`${this.apiBase}/panoIds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locations: probeOffsets, radius: 500 }),
        signal,
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as { panoIds?: string[] };
      const firstValid = payload.panoIds?.find((id) => typeof id === 'string' && id.length > 0);
      if (firstValid) {
        return await this.getMetadataByPanoId(firstValid, signal);
      }
    } catch {
      return null;
    }

    return null;
  }

  /**
   * When a searched landmark lands on an unlinked user photosphere (0 street links),
   * probes a ring of nearby points via /panoIds to find the nearest connected drivable road.
   */
  public async findNearbyDrivableLocation(
    lat: number,
    lng: number,
    excludePanoId?: string,
    signal?: AbortSignal,
  ): Promise<PanoramaMetadata | null> {
    const probePoints = [
      ...([0, 60, 120, 180, 240, 300].map((b) => offsetCoordinates(lat, lng, 45, b))),
      ...([30, 150, 270].map((b) => offsetCoordinates(lat, lng, 95, b))),
    ];

    try {
      const response = await this.fetchImpl(`${this.apiBase}/panoIds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locations: probePoints, radius: 50 }),
        signal,
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as { panoIds?: string[] };
      const uniqueIds = Array.from(
        new Set(
          (payload.panoIds || []).filter(
            (id): id is string => typeof id === 'string' && id.length > 0 && id !== excludePanoId,
          ),
        ),
      );

      for (const panoId of uniqueIds.slice(0, 6)) {
        try {
          const candidate = await this.getMetadataByPanoId(panoId, signal);
          if (candidate.links.length > 0) {
            return candidate;
          }
        } catch {
          // Continue probing remaining candidates
        }
      }
    } catch {
      return null;
    }

    return null;
  }

  private async requestMetadata(
    url: string,
    signal?: AbortSignal,
  ): Promise<PanoramaMetadata> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: 'GET', signal });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      throw new StreetViewApiError(
        0,
        'NETWORK_ERROR',
        'Network error while fetching Street View metadata. Check your connection.',
      );
    }

    const payload = (await response.json().catch(() => ({}))) as RawMetadataResponse;

    if (!response.ok) {
      const code = payload.error?.code || (response.status === 404 ? 'NO_COVERAGE' : 'API_ERROR');
      const isQuota = Boolean(payload.error?.isQuotaError) || response.status === 429;
      if (isQuota) {
        notifyQuotaExceededIfApplicable(response.status, code);
      }
      throw new StreetViewApiError(
        response.status,
        code,
        payload.error?.message || `Street View metadata request failed (${response.status}).`,
        {
          isQuotaError: isQuota,
          isAuthError: Boolean(payload.error?.isAuthError) || response.status === 401 || response.status === 403,
        },
      );
    }

    const metadata = normalizeMetadataResponse(payload);
    this.setCache(metadata.panoId, metadata);
    return metadata;
  }
}
