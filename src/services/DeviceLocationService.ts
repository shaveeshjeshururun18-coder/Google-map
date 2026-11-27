export interface ResolvedDeviceLocation {
  lat: number;
  lng: number;
  accuracyMeters?: number;
  label: string;
  source: 'gps' | 'network';
}

export interface BrowserGeolocationLike {
  getCurrentPosition: (
    successCallback: (position: {
      coords: {
        latitude: number;
        longitude: number;
        accuracy?: number;
      };
    }) => void,
    errorCallback?: (error: { code: number; message: string }) => void,
    options?: {
      enableHighAccuracy?: boolean;
      timeout?: number;
      maximumAge?: number;
    },
  ) => void;
}

export interface DeviceLocationServiceOptions {
  geolocation?: BrowserGeolocationLike | null;
  fetchImpl?: typeof fetch;
  highAccuracyTimeoutMs?: number;
  lowAccuracyTimeoutMs?: number;
  networkTimeoutMs?: number;
}

function isValidLatLng(lat: unknown, lng: unknown): lat is number {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

function formatLocationLabel(
  city?: string,
  region?: string,
  country?: string,
  fallback = 'Current Location',
): string {
  const parts = [city, region, country]
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean);
  if (parts.length === 0) return fallback;
  return parts.slice(0, 2).join(', ');
}

export class DeviceLocationService {
  private readonly geolocation: BrowserGeolocationLike | null;
  private readonly fetchImpl: typeof fetch;
  private readonly highAccuracyTimeoutMs: number;
  private readonly lowAccuracyTimeoutMs: number;
  private readonly networkTimeoutMs: number;

  constructor(options: DeviceLocationServiceOptions = {}) {
    this.geolocation =
      options.geolocation !== undefined
        ? options.geolocation
        : typeof navigator !== 'undefined' && navigator.geolocation
          ? navigator.geolocation
          : null;
    this.fetchImpl =
      !options.fetchImpl || options.fetchImpl === globalThis.fetch
        ? (input, init) => globalThis.fetch(input, init)
        : (input, init) => options.fetchImpl!(input, init);
    this.highAccuracyTimeoutMs = options.highAccuracyTimeoutMs ?? 4500;
    this.lowAccuracyTimeoutMs = options.lowAccuracyTimeoutMs ?? 4500;
    this.networkTimeoutMs = options.networkTimeoutMs ?? 4000;
  }

  private requestBrowserPosition(options: {
    enableHighAccuracy: boolean;
    timeout: number;
    maximumAge: number;
  }): Promise<ResolvedDeviceLocation> {
    return new Promise<ResolvedDeviceLocation>((resolve, reject) => {
      if (!this.geolocation) {
        reject(new Error('Geolocation API unavailable'));
        return;
      }

      let settled = false;
      const timer = globalThis.setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(Object.assign(new Error('Geolocation timed out'), { code: 3 }));
        }
      }, options.timeout + 250);

      try {
        this.geolocation.getCurrentPosition(
          (pos) => {
            if (settled) return;
            settled = true;
            globalThis.clearTimeout(timer);
            const lat = pos?.coords?.latitude;
            const lng = pos?.coords?.longitude;
            if (!isValidLatLng(lat, lng)) {
              reject(new Error('Invalid GPS coordinates returned'));
              return;
            }
            resolve({
              lat,
              lng,
              accuracyMeters:
                typeof pos.coords.accuracy === 'number' && Number.isFinite(pos.coords.accuracy)
                  ? pos.coords.accuracy
                  : undefined,
              label: 'Current GPS Location',
              source: 'gps',
            });
          },
          (err) => {
            if (settled) return;
            settled = true;
            globalThis.clearTimeout(timer);
            reject(err || new Error('Browser geolocation failed'));
          },
          options,
        );
      } catch (err) {
        if (!settled) {
          settled = true;
          globalThis.clearTimeout(timer);
          reject(err);
        }
      }
    });
  }

  private async fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), this.networkTimeoutMs);
    try {
      return await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      globalThis.clearTimeout(timer);
    }
  }

  private async tryClientIpGeolocation(): Promise<ResolvedDeviceLocation | null> {
    // 1. ipwho.is (CORS-enabled, accurate city-level client IP lookup)
    try {
      const res = await this.fetchWithTimeout('https://ipwho.is/');
      if (res.ok) {
        const data = (await res.json()) as {
          success?: boolean;
          latitude?: number;
          longitude?: number;
          city?: string;
          region?: string;
          country?: string;
        };
        if (data.success !== false && isValidLatLng(data.latitude, data.longitude)) {
          return {
            lat: data.latitude,
            lng: data.longitude!,
            label: formatLocationLabel(data.city, data.region, data.country, 'Current Network Location'),
            source: 'network',
          };
        }
      }
    } catch {
      // Try next provider
    }

    // 2. get.geojs.io (CORS-enabled fast IP geo endpoint)
    try {
      const res = await this.fetchWithTimeout('https://get.geojs.io/v1/ip/geo.json');
      if (res.ok) {
        const data = (await res.json()) as {
          latitude?: string | number;
          longitude?: string | number;
          city?: string;
          region?: string;
          country?: string;
        };
        const lat = Number(data.latitude);
        const lng = Number(data.longitude);
        if (isValidLatLng(lat, lng)) {
          return {
            lat,
            lng,
            label: formatLocationLabel(data.city, data.region, data.country, 'Current Network Location'),
            source: 'network',
          };
        }
      }
    } catch {
      // Try next provider
    }

    // 3. ipapi.co
    try {
      const res = await this.fetchWithTimeout('https://ipapi.co/json/');
      if (res.ok) {
        const data = (await res.json()) as {
          latitude?: number;
          longitude?: number;
          city?: string;
          region?: string;
          country_name?: string;
        };
        if (isValidLatLng(data.latitude, data.longitude)) {
          return {
            lat: data.latitude,
            lng: data.longitude!,
            label: formatLocationLabel(
              data.city,
              data.region,
              data.country_name,
              'Current Network Location',
            ),
            source: 'network',
          };
        }
      }
    } catch {
      // Fall through to server proxy
    }

    return null;
  }

  private async tryServerGeolocationFallback(): Promise<ResolvedDeviceLocation | null> {
    try {
      const res = await this.fetchWithTimeout('/api/geolocation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        lat?: number;
        lng?: number;
        accuracy?: number;
        label?: string;
      };
      if (isValidLatLng(data.lat, data.lng)) {
        return {
          lat: data.lat,
          lng: data.lng!,
          accuracyMeters:
            typeof data.accuracy === 'number' && Number.isFinite(data.accuracy)
              ? data.accuracy
              : undefined,
          label:
            typeof data.label === 'string' && data.label.trim().length > 0
              ? data.label.trim()
              : 'Current Network Location',
          source: 'network',
        };
      }
    } catch {
      // Exhausted server fallback
    }
    return null;
  }

  private async getPermissionState(): Promise<'granted' | 'prompt' | 'denied' | 'unknown'> {
    try {
      if (
        typeof navigator !== 'undefined' &&
        navigator.permissions &&
        typeof navigator.permissions.query === 'function'
      ) {
        const status = await navigator.permissions.query({ name: 'geolocation' });
        if (status.state === 'granted' || status.state === 'prompt' || status.state === 'denied') {
          return status.state;
        }
      }
    } catch {
      // Permissions API not supported or restricted
    }
    return 'unknown';
  }

  /**
   * Resolves the user's current geographic coordinates using a resilient 3-stage pipeline:
   *  1. Browser High-Accuracy GPS (`enableHighAccuracy: true`), giving 15s when a permission
   *     prompt is shown so the user has time to click "Allow"
   *  2. Browser System / Wi-Fi Location (`enableHighAccuracy: false`) if hardware GPS times out
   *  3. Network / IP Geolocation (Client GeoIP + Server `/api/geolocation` fallback) when
   *     browser geolocation is blocked by iframe permissions or unavailable.
   */
  public async resolveDeviceLocation(): Promise<ResolvedDeviceLocation> {
    if (this.geolocation) {
      const permState = await this.getPermissionState();
      if (permState !== 'denied') {
        const firstTimeout =
          permState === 'prompt'
            ? Math.max(this.highAccuracyTimeoutMs, 15_000)
            : this.highAccuracyTimeoutMs;

        try {
          return await this.requestBrowserPosition({
            enableHighAccuracy: true,
            timeout: firstTimeout,
            maximumAge: 60_000,
          });
        } catch (err) {
          const code = (err as { code?: number })?.code;
          // If not explicitly permission-denied (1), retry with system/Wi-Fi low-accuracy position
          if (code !== 1) {
            try {
              return await this.requestBrowserPosition({
                enableHighAccuracy: false,
                timeout: this.lowAccuracyTimeoutMs,
                maximumAge: 600_000,
              });
            } catch {
              // Fall through to network/IP geolocation
            }
          }
        }
      }
    }

    const clientIpLoc = await this.tryClientIpGeolocation();
    if (clientIpLoc) {
      return clientIpLoc;
    }

    const serverLoc = await this.tryServerGeolocationFallback();
    if (serverLoc) {
      return serverLoc;
    }

    throw new Error(
      'Unable to determine your current location via GPS or network. Please search your city or street in the search bar.',
    );
  }
}
