import type { PlaceResult, PlaceSuggestion } from '../types/streetview';
import {
  notifyQuotaExceededIfApplicable,
  StreetViewApiError,
} from './PanoramaMetadataService';

interface AutocompleteApiResponse {
  suggestions?: Array<{
    placePrediction?: {
      placeId?: string;
      text?: { text?: string };
      structuredFormat?: {
        mainText?: { text?: string };
        secondaryText?: { text?: string };
      };
      types?: string[];
    };
  }>;
  error?: {
    code?: string;
    message?: string;
    isQuotaError?: boolean;
    isAuthError?: boolean;
  };
}

interface PlaceDetailsApiResponse {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  types?: string[];
  error?: {
    code?: string;
    message?: string;
    isQuotaError?: boolean;
    isAuthError?: boolean;
  };
}

interface SearchTextApiResponse {
  places?: PlaceDetailsApiResponse[];
  error?: {
    code?: string;
    message?: string;
    isQuotaError?: boolean;
    isAuthError?: boolean;
  };
}

function generateSessionToken(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `sv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export class LocationSearchService {
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private sessionToken: string = generateSessionToken();

  constructor(fetchImpl?: typeof fetch, apiBase = '/api/places') {
    this.fetchImpl =
      !fetchImpl || fetchImpl === globalThis.fetch
        ? (input, init) => globalThis.fetch(input, init)
        : (input, init) => fetchImpl(input, init);
    this.apiBase = apiBase;
  }

  public resetSessionToken(): void {
    this.sessionToken = generateSessionToken();
  }

  public async autocomplete(
    input: string,
    bias?: { lat: number; lng: number },
    signal?: AbortSignal,
  ): Promise<PlaceSuggestion[]> {
    const trimmed = input.trim();
    if (trimmed.length < 2) {
      return [];
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBase}/autocomplete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: trimmed,
          sessionToken: this.sessionToken,
          lat: bias?.lat,
          lng: bias?.lng,
        }),
        signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      throw new StreetViewApiError(
        0,
        'NETWORK_ERROR',
        'Network failure while searching for places.',
      );
    }

    const payload = (await response.json().catch(() => ({}))) as AutocompleteApiResponse;
    if (!response.ok) {
      const code = payload.error?.code || 'PLACES_ERROR';
      const isQuota = Boolean(payload.error?.isQuotaError) || response.status === 429;
      if (isQuota) {
        notifyQuotaExceededIfApplicable(response.status, code);
      }
      throw new StreetViewApiError(
        response.status,
        code,
        payload.error?.message || `Location autocomplete failed (${response.status}).`,
        { isQuotaError: isQuota, isAuthError: Boolean(payload.error?.isAuthError) },
      );
    }

    const suggestions = payload.suggestions || [];
    const results: PlaceSuggestion[] = [];

    for (const item of suggestions) {
      const pred = item.placePrediction;
      if (!pred?.placeId) continue;
      const fullText = pred.text?.text || '';
      results.push({
        placeId: pred.placeId,
        mainText: pred.structuredFormat?.mainText?.text || fullText,
        secondaryText: pred.structuredFormat?.secondaryText?.text || '',
        fullText,
        types: Array.isArray(pred.types) ? pred.types : [],
      });
    }

    return results;
  }

  public async getPlaceDetails(
    placeId: string,
    signal?: AbortSignal,
  ): Promise<PlaceResult> {
    const token = this.sessionToken;
    this.resetSessionToken();

    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.apiBase}/${encodeURIComponent(placeId)}?sessionToken=${encodeURIComponent(token)}`,
        { method: 'GET', signal },
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      throw new StreetViewApiError(
        0,
        'NETWORK_ERROR',
        'Network failure while loading place coordinates.',
      );
    }

    const payload = (await response.json().catch(() => ({}))) as PlaceDetailsApiResponse;
    if (!response.ok) {
      const code = payload.error?.code || 'PLACES_ERROR';
      const isQuota = Boolean(payload.error?.isQuotaError) || response.status === 429;
      if (isQuota) {
        notifyQuotaExceededIfApplicable(response.status, code);
      }
      throw new StreetViewApiError(
        response.status,
        code,
        payload.error?.message || `Place lookup failed (${response.status}).`,
        { isQuotaError: isQuota, isAuthError: Boolean(payload.error?.isAuthError) },
      );
    }

    if (
      typeof payload.location?.latitude !== 'number' ||
      typeof payload.location?.longitude !== 'number'
    ) {
      throw new StreetViewApiError(
        404,
        'MISSING_LOCATION',
        'This place does not include geographic coordinates.',
      );
    }

    return {
      placeId: payload.id || placeId,
      name: payload.displayName?.text || payload.formattedAddress || 'Selected Location',
      formattedAddress: payload.formattedAddress || payload.displayName?.text || '',
      lat: payload.location.latitude,
      lng: payload.location.longitude,
      types: Array.isArray(payload.types) ? payload.types : [],
    };
  }

  public async searchByText(
    textQuery: string,
    bias?: { lat: number; lng: number },
    signal?: AbortSignal,
  ): Promise<PlaceResult[]> {
    const trimmed = textQuery.trim();
    if (!trimmed) return [];

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBase}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          textQuery: trimmed,
          lat: bias?.lat,
          lng: bias?.lng,
        }),
        signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      throw new StreetViewApiError(
        0,
        'NETWORK_ERROR',
        'Network failure while searching locations.',
      );
    }

    const payload = (await response.json().catch(() => ({}))) as SearchTextApiResponse;
    if (!response.ok) {
      const code = payload.error?.code || 'PLACES_ERROR';
      const isQuota = Boolean(payload.error?.isQuotaError) || response.status === 429;
      if (isQuota) {
        notifyQuotaExceededIfApplicable(response.status, code);
      }
      throw new StreetViewApiError(
        response.status,
        code,
        payload.error?.message || `Location search failed (${response.status}).`,
        { isQuotaError: isQuota, isAuthError: Boolean(payload.error?.isAuthError) },
      );
    }

    const places = payload.places || [];
    const results: PlaceResult[] = [];
    for (const p of places) {
      if (
        typeof p.location?.latitude !== 'number' ||
        typeof p.location?.longitude !== 'number'
      ) {
        continue;
      }
      results.push({
        placeId: p.id || `${p.location.latitude},${p.location.longitude}`,
        name: p.displayName?.text || p.formattedAddress || 'Location',
        formattedAddress: p.formattedAddress || '',
        lat: p.location.latitude,
        lng: p.location.longitude,
        types: Array.isArray(p.types) ? p.types : [],
      });
    }

    return results;
  }
}
