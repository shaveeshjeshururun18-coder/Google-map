import { getServerConfig, isApiKeyConfigured } from '../config/env';

const TILE_API_BASE = 'https://tile.googleapis.com/v1';
const PLACES_API_BASE = 'https://places.googleapis.com/v1';
const SESSION_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface StreetViewSessionState {
  token: string;
  expiryMs: number;
  tileWidth: number;
  tileHeight: number;
  imageFormat: string;
  language: string;
  region: string;
}

export class UpstreamApiError extends Error {
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
    this.name = 'UpstreamApiError';
    this.status = status;
    this.code = code;
    this.isQuotaError = Boolean(options?.isQuotaError);
    this.isAuthError = Boolean(options?.isAuthError);
  }
}

interface GoogleErrorDetail {
  '@type'?: string;
  reason?: string;
  domain?: string;
  metadata?: Record<string, string>;
}

interface GoogleErrorPayload {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: GoogleErrorDetail[];
  };
}

function sanitizeErrorMessage(raw: string): string {
  // Never leak any API key or session token in error messages
  return raw
    .replace(/key=[^&\s"']+/gi, 'key=[REDACTED]')
    .replace(/session=[^&\s"']+/gi, 'session=[REDACTED]');
}

function classifyGoogleError(status: number, payload: GoogleErrorPayload | null): UpstreamApiError {
  const upstreamStatus = payload?.error?.status || '';
  const rawMessage = sanitizeErrorMessage(payload?.error?.message || '');
  const lower = rawMessage.toLowerCase();
  const errorInfo = payload?.error?.details?.find(
    (d) => typeof d.reason === 'string' && d.reason.length > 0,
  );
  const reason = errorInfo?.reason || '';
  const lowerReason = reason.toLowerCase();

  if (
    status === 429 ||
    upstreamStatus === 'RESOURCE_EXHAUSTED' ||
    lowerReason.includes('quota') ||
    lowerReason.includes('rate_limit') ||
    lower.includes('quota') ||
    lower.includes('rate limit')
  ) {
    return new UpstreamApiError(
      429,
      'RESOURCE_EXHAUSTED',
      'Google Maps Platform quota limit reached. Please check your quota or try again later.',
      { isQuotaError: true },
    );
  }

  if (lower.includes('billing') || lowerReason.includes('billing')) {
    return new UpstreamApiError(
      403,
      'BILLING_ERROR',
      'Google Maps Platform billing is not enabled or active on the configured Google Cloud project.',
      { isAuthError: true },
    );
  }

  if (
    status === 401 ||
    status === 403 ||
    upstreamStatus === 'PERMISSION_DENIED' ||
    upstreamStatus === 'UNAUTHENTICATED'
  ) {
    if (
      lowerReason === 'service_disabled' ||
      lowerReason === 'api_key_service_blocked' ||
      lower.includes('not activated') ||
      lower.includes('has not been used') ||
      lower.includes('disabled')
    ) {
      return new UpstreamApiError(
        403,
        'API_NOT_ENABLED',
        'Required Google Maps Platform API (Map Tiles API or Places API New) is not enabled for this API key.',
        { isAuthError: true },
      );
    }
    if (
      lowerReason === 'api_key_invalid' ||
      lowerReason === 'api_key_http_referrer_blocked' ||
      lower.includes('api key') ||
      lower.includes('invalid')
    ) {
      return new UpstreamApiError(
        403,
        'INVALID_API_KEY',
        `The configured Google Maps Platform API key is invalid or restricted (${reason || 'INVALID_API_KEY'}).`,
        { isAuthError: true },
      );
    }
    const detailSuffix = reason ? ` (${reason})` : '';
    return new UpstreamApiError(
      403,
      reason || 'PERMISSION_DENIED',
      (rawMessage || 'Permission denied by Google Maps Platform API.') + detailSuffix,
      { isAuthError: true },
    );
  }

  if (status === 404 || upstreamStatus === 'NOT_FOUND') {
    return new UpstreamApiError(
      404,
      'NO_COVERAGE',
      'No Google Street View panorama is available at this location.',
    );
  }

  return new UpstreamApiError(
    status >= 400 && status < 600 ? status : 502,
    upstreamStatus || 'UPSTREAM_ERROR',
    rawMessage || `Google Maps Platform request failed with HTTP ${status}.`,
  );
}

export class GoogleMapsProxyService {
  private session: StreetViewSessionState | null = null;
  private inflightSessionPromise: Promise<StreetViewSessionState> | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl?: typeof fetch) {
    this.fetchImpl =
      !fetchImpl || fetchImpl === globalThis.fetch
        ? (input, init) => globalThis.fetch(input, init)
        : (input, init) => fetchImpl(input, init);
  }

  private requireApiKey(): string {
    if (!isApiKeyConfigured()) {
      throw new UpstreamApiError(
        503,
        'MISSING_API_KEY',
        'Google Maps Platform API key is not configured on the server. Set GOOGLE_MAPS_API_KEY in environment secrets.',
        { isAuthError: true },
      );
    }
    return getServerConfig().googleMapsApiKey;
  }

  private getSolutionHeaders(extra?: Record<string, string>): Record<string, string> {
    const { solutionId } = getServerConfig();
    return {
      'X-Goog-Maps-Solution-ID': solutionId,
      ...extra,
    };
  }

  public isSessionValid(session: StreetViewSessionState | null): boolean {
    if (!session) return false;
    return Date.now() + SESSION_REFRESH_MARGIN_MS < session.expiryMs;
  }

  public invalidateSession(): void {
    this.session = null;
  }

  public async ensureSession(
    language = 'en-US',
    region = 'US',
    forceRefresh = false,
  ): Promise<StreetViewSessionState> {
    if (!forceRefresh && this.isSessionValid(this.session)) {
      return this.session!;
    }

    if (!forceRefresh && this.inflightSessionPromise) {
      return this.inflightSessionPromise;
    }

    const createPromise = this.createStreetViewSession(language, region).finally(() => {
      if (this.inflightSessionPromise === createPromise) {
        this.inflightSessionPromise = null;
      }
    });

    this.inflightSessionPromise = createPromise;
    return createPromise;
  }

  private async createStreetViewSession(
    language: string,
    region: string,
  ): Promise<StreetViewSessionState> {
    const apiKey = this.requireApiKey();
    const url = new URL(`${TILE_API_BASE}/createSession`);
    url.searchParams.set('key', apiKey);

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: 'POST',
        headers: this.getSolutionHeaders({
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          mapType: 'streetview',
          language,
          region,
        }),
      });
    } catch {
      throw new UpstreamApiError(
        502,
        'NETWORK_ERROR',
        'Unable to reach Google Map Tiles API to create a Street View session.',
      );
    }

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as GoogleErrorPayload | null;
      throw classifyGoogleError(response.status, payload);
    }

    const data = (await response.json()) as {
      session?: string;
      expiry?: string;
      tileWidth?: number;
      tileHeight?: number;
      imageFormat?: string;
    };

    if (!data.session) {
      throw new UpstreamApiError(
        502,
        'INVALID_SESSION_RESPONSE',
        'Google Map Tiles API did not return a valid session token.',
      );
    }

    const expirySec = Number.parseInt(data.expiry || '', 10);
    const expiryMs = Number.isFinite(expirySec)
      ? expirySec * 1000
      : Date.now() + 60 * 60 * 1000;

    const nextSession: StreetViewSessionState = {
      token: data.session,
      expiryMs,
      tileWidth: data.tileWidth ?? 512,
      tileHeight: data.tileHeight ?? 512,
      imageFormat: data.imageFormat ?? 'jpeg',
      language,
      region,
    };

    this.session = nextSession;
    return nextSession;
  }

  private async withSessionRetry<T>(
    operation: (session: StreetViewSessionState, apiKey: string) => Promise<Response>,
    parse: (response: Response) => Promise<T>,
  ): Promise<T> {
    const apiKey = this.requireApiKey();
    let session = await this.ensureSession();
    let response: Response;

    try {
      response = await operation(session, apiKey);
    } catch {
      throw new UpstreamApiError(
        502,
        'NETWORK_ERROR',
        'Network failure communicating with Google Street View Tiles API.',
      );
    }

    // Retry once if the session token expired upstream
    if (response.status === 400 || response.status === 401) {
      const cloned = response.clone();
      const errBody = (await cloned.json().catch(() => null)) as GoogleErrorPayload | null;
      const errMsg = (errBody?.error?.message || '').toLowerCase();
      if (errMsg.includes('session') || errMsg.includes('expired') || response.status === 401) {
        this.invalidateSession();
        session = await this.ensureSession(session.language, session.region, true);
        try {
          response = await operation(session, apiKey);
        } catch {
          throw new UpstreamApiError(
            502,
            'NETWORK_ERROR',
            'Network failure after refreshing Street View session.',
          );
        }
      }
    }

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as GoogleErrorPayload | null;
      throw classifyGoogleError(response.status, payload);
    }

    return parse(response);
  }

  public async getStreetViewMetadata(params: {
    lat?: number;
    lng?: number;
    radius?: number;
    panoId?: string;
  }): Promise<Record<string, unknown>> {
    return this.withSessionRetry(
      (session, apiKey) => {
        const url = new URL(`${TILE_API_BASE}/streetview/metadata`);
        url.searchParams.set('session', session.token);
        url.searchParams.set('key', apiKey);
        if (params.panoId) {
          url.searchParams.set('panoId', params.panoId);
        } else if (params.lat !== undefined && params.lng !== undefined) {
          url.searchParams.set('lat', String(params.lat));
          url.searchParams.set('lng', String(params.lng));
          if (params.radius !== undefined) {
            url.searchParams.set('radius', String(params.radius));
          }
        }
        return this.fetchImpl(url.toString(), {
          method: 'GET',
          headers: this.getSolutionHeaders(),
        });
      },
      async (res) => (await res.json()) as Record<string, unknown>,
    );
  }

  public async searchPanoIds(
    locations: Array<{ lat: number; lng: number }>,
    radius = 50,
  ): Promise<{ panoIds: string[] }> {
    return this.withSessionRetry(
      (session, apiKey) => {
        const url = new URL(`${TILE_API_BASE}/streetview/panoIds`);
        url.searchParams.set('session', session.token);
        url.searchParams.set('key', apiKey);
        return this.fetchImpl(url.toString(), {
          method: 'POST',
          headers: this.getSolutionHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ locations, radius }),
        });
      },
      async (res) => {
        const json = (await res.json()) as { panoIds?: string[] };
        return { panoIds: Array.isArray(json.panoIds) ? json.panoIds : [] };
      },
    );
  }

  public async getStreetViewTile(params: {
    z: number;
    x: number;
    y: number;
    panoId: string;
  }): Promise<{ buffer: Buffer; contentType: string }> {
    return this.withSessionRetry(
      (session, apiKey) => {
        const url = new URL(
          `${TILE_API_BASE}/streetview/tiles/${params.z}/${params.x}/${params.y}`,
        );
        url.searchParams.set('session', session.token);
        url.searchParams.set('key', apiKey);
        url.searchParams.set('panoId', params.panoId);
        return this.fetchImpl(url.toString(), {
          method: 'GET',
          headers: this.getSolutionHeaders(),
        });
      },
      async (res) => {
        const arrayBuffer = await res.arrayBuffer();
        return {
          buffer: Buffer.from(arrayBuffer),
          contentType: res.headers.get('content-type') || 'image/jpeg',
        };
      },
    );
  }

  public async autocompletePlaces(params: {
    input: string;
    sessionToken?: string;
    lat?: number;
    lng?: number;
  }): Promise<Record<string, unknown>> {
    const apiKey = this.requireApiKey();
    const body: Record<string, unknown> = {
      input: params.input,
      languageCode: 'en',
    };
    if (params.sessionToken) {
      body.sessionToken = params.sessionToken;
    }
    if (params.lat !== undefined && params.lng !== undefined) {
      body.locationBias = {
        circle: {
          center: { latitude: params.lat, longitude: params.lng },
          radius: 50000.0,
        },
      };
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${PLACES_API_BASE}/places:autocomplete`, {
        method: 'POST',
        headers: this.getSolutionHeaders({
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask':
            'suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat,suggestions.placePrediction.types',
        }),
        body: JSON.stringify(body),
      });
    } catch {
      throw new UpstreamApiError(
        502,
        'NETWORK_ERROR',
        'Unable to reach Google Places API for autocomplete.',
      );
    }

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as GoogleErrorPayload | null;
      throw classifyGoogleError(response.status, payload);
    }

    return (await response.json()) as Record<string, unknown>;
  }

  public async searchPlacesByText(params: {
    textQuery: string;
    lat?: number;
    lng?: number;
  }): Promise<Record<string, unknown>> {
    const apiKey = this.requireApiKey();
    const body: Record<string, unknown> = {
      textQuery: params.textQuery,
      pageSize: 6,
      languageCode: 'en',
    };
    if (params.lat !== undefined && params.lng !== undefined) {
      body.locationBias = {
        circle: {
          center: { latitude: params.lat, longitude: params.lng },
          radius: 50000.0,
        },
      };
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${PLACES_API_BASE}/places:searchText`, {
        method: 'POST',
        headers: this.getSolutionHeaders({
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask':
            'places.id,places.displayName,places.formattedAddress,places.location,places.types',
        }),
        body: JSON.stringify(body),
      });
    } catch {
      throw new UpstreamApiError(
        502,
        'NETWORK_ERROR',
        'Unable to reach Google Places API for text search.',
      );
    }

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as GoogleErrorPayload | null;
      throw classifyGoogleError(response.status, payload);
    }

    return (await response.json()) as Record<string, unknown>;
  }

  public async getPlaceDetails(
    placeId: string,
    sessionToken?: string,
  ): Promise<Record<string, unknown>> {
    const apiKey = this.requireApiKey();
    const url = new URL(`${PLACES_API_BASE}/places/${encodeURIComponent(placeId)}`);
    if (sessionToken) {
      url.searchParams.set('sessionToken', sessionToken);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: this.getSolutionHeaders({
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'id,displayName,formattedAddress,location,types',
        }),
      });
    } catch {
      throw new UpstreamApiError(
        502,
        'NETWORK_ERROR',
        'Unable to reach Google Places API for place details.',
      );
    }

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as GoogleErrorPayload | null;
      throw classifyGoogleError(response.status, payload);
    }

    return (await response.json()) as Record<string, unknown>;
  }
}

export const googleMapsProxy = new GoogleMapsProxyService();
