import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getServerConfig, isApiKeyConfigured } from './server/config/env';
import { createPlacesRouter } from './server/routes/placesRoutes';
import { createStreetViewRouter } from './server/routes/streetViewRoutes';

import { googleMapsProxy } from './server/services/googleMapsProxy';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let cachedTilesProbe: { available: boolean; checkedAt: number } | null = null;

async function probeTilesApiAvailability(): Promise<boolean> {
  if (!isApiKeyConfigured()) return false;
  const now = Date.now();
  if (cachedTilesProbe && now - cachedTilesProbe.checkedAt < 5 * 60_000) {
    return cachedTilesProbe.available;
  }
  try {
    await googleMapsProxy.ensureSession('en-US', 'US', false);
    cachedTilesProbe = { available: true, checkedAt: now };
    return true;
  } catch {
    cachedTilesProbe = { available: false, checkedAt: now };
    return false;
  }
}

export async function createAppServer() {
  const app = express();
  const config = getServerConfig();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/config', async (_req, res) => {
    const apiConfigured = isApiKeyConfigured();
    const tilesApiAvailable = apiConfigured ? await probeTilesApiAvailability() : false;
    res.json({
      apiConfigured,
      tilesApiAvailable,
      environment: config.nodeEnv,
    });
  });

  app.post('/api/geolocation', async (req, res) => {
    const forwardedHeader = req.headers['x-forwarded-for'];
    const rawForwarded = Array.isArray(forwardedHeader)
      ? forwardedHeader[0]
      : typeof forwardedHeader === 'string'
        ? forwardedHeader.split(',')[0]
        : '';
    const clientIp = (rawForwarded || '').trim();
    const isPublicIp =
      Boolean(clientIp) &&
      clientIp !== '127.0.0.1' &&
      clientIp !== '::1' &&
      !clientIp.startsWith('10.') &&
      !clientIp.startsWith('192.168.') &&
      !clientIp.startsWith('172.16.');

    // 1. If request carries a real client IP via X-Forwarded-For, resolve that client IP first
    if (isPublicIp) {
      try {
        const ipRes = await fetch(`https://ipwho.is/${encodeURIComponent(clientIp)}`);
        if (ipRes.ok) {
          const data = (await ipRes.json()) as {
            success?: boolean;
            latitude?: number;
            longitude?: number;
            city?: string;
            region?: string;
            country?: string;
          };
          if (
            data.success !== false &&
            typeof data.latitude === 'number' &&
            typeof data.longitude === 'number' &&
            Number.isFinite(data.latitude) &&
            Number.isFinite(data.longitude)
          ) {
            const parts = [data.city, data.region, data.country].filter(Boolean);
            res.json({
              lat: data.latitude,
              lng: data.longitude,
              label: parts.slice(0, 2).join(', ') || 'Current Network Location',
              source: 'network',
            });
            return;
          }
        }
      } catch {
        // Fall through to Google Geolocation API or GeoJS
      }
    }

    // 2. Official Google Maps Platform Geolocation API (HTTPS POST /geolocation/v1/geolocate)
    if (isApiKeyConfigured()) {
      try {
        const geoUrl = new URL('https://www.googleapis.com/geolocation/v1/geolocate');
        geoUrl.searchParams.set('key', config.googleMapsApiKey);
        const gRes = await fetch(geoUrl.toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ considerIp: true }),
        });
        if (gRes.ok) {
          const gData = (await gRes.json()) as {
            location?: { lat?: number; lng?: number };
            accuracy?: number;
          };
          if (
            typeof gData.location?.lat === 'number' &&
            typeof gData.location?.lng === 'number' &&
            Number.isFinite(gData.location.lat) &&
            Number.isFinite(gData.location.lng)
          ) {
            res.json({
              lat: gData.location.lat,
              lng: gData.location.lng,
              accuracy: gData.accuracy,
              label: 'Current Network Location',
              source: 'network',
            });
            return;
          }
        }
      } catch {
        // Fall through to server IP geo lookup
      }
    }

    // 3. Final fallback via GeoJS
    try {
      const geoJsUrl = isPublicIp
        ? `https://get.geojs.io/v1/ip/geo/${encodeURIComponent(clientIp)}.json`
        : 'https://get.geojs.io/v1/ip/geo.json';
      const fallbackRes = await fetch(geoJsUrl);
      if (fallbackRes.ok) {
        const data = (await fallbackRes.json()) as {
          latitude?: string | number;
          longitude?: string | number;
          city?: string;
          region?: string;
        };
        const lat = Number(data.latitude);
        const lng = Number(data.longitude);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          const parts = [data.city, data.region].filter(Boolean);
          res.json({
            lat,
            lng,
            label: parts.join(', ') || 'Current Network Location',
            source: 'network',
          });
          return;
        }
      }
    } catch {
      // Exhausted
    }

    res.status(503).json({
      error: {
        code: 'GEOLOCATION_UNAVAILABLE',
        message: 'Unable to determine current location.',
      },
    });
  });

  app.use('/api/streetview', createStreetViewRouter());
  app.use('/api/places', createPlacesRouter());

  if (config.nodeEnv === 'production') {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  return app;
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMainModule) {
  const config = getServerConfig();
  createAppServer()
    .then((app) => {
      app.listen(config.port, '0.0.0.0', () => {
        console.log(
          `Real Street View Drive server listening on http://0.0.0.0:${config.port}`,
        );
      });
    })
    .catch((err) => {
      console.error('Failed to start server:', err);
      process.exit(1);
    });
}
