import { Router, type Request, type Response } from 'express';
import { createRateLimiter } from '../middleware/rateLimit';
import {
  isValidPanoId,
  parseLatitude,
  parseLongitude,
  parseRadius,
  parseTileCoordinate,
  sanitizeLanguage,
  sanitizeRegion,
} from '../middleware/validation';
import { googleMapsProxy, UpstreamApiError } from '../services/googleMapsProxy';

function sendApiError(res: Response, err: unknown): void {
  if (err instanceof UpstreamApiError) {
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        isQuotaError: err.isQuotaError,
        isAuthError: err.isAuthError,
      },
    });
    return;
  }

  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected server error occurred while contacting Street View.',
    },
  });
}

export function createStreetViewRouter(): Router {
  const router = Router();

  const metadataLimiter = createRateLimiter({
    windowMs: 60_000,
    maxRequests: 120,
    keyPrefix: 'sv-meta',
  });

  const tileLimiter = createRateLimiter({
    windowMs: 60_000,
    maxRequests: 600,
    keyPrefix: 'sv-tile',
  });

  router.post('/session', metadataLimiter, async (req: Request, res: Response) => {
    try {
      const language = sanitizeLanguage(req.body?.language);
      const region = sanitizeRegion(req.body?.region);
      const forceRefresh = req.body?.forceRefresh === true;
      const session = await googleMapsProxy.ensureSession(language, region, forceRefresh);

      // Return session metadata (never expose raw upstream credentials)
      res.json({
        active: true,
        expiryMs: session.expiryMs,
        tileWidth: session.tileWidth,
        tileHeight: session.tileHeight,
        imageFormat: session.imageFormat,
        language: session.language,
        region: session.region,
      });
    } catch (err) {
      sendApiError(res, err);
    }
  });

  router.get('/metadata', metadataLimiter, async (req: Request, res: Response) => {
    try {
      const panoIdParam = req.query.panoId;
      if (panoIdParam !== undefined && panoIdParam !== '') {
        if (!isValidPanoId(panoIdParam)) {
          res.status(400).json({
            error: {
              code: 'INVALID_PARAMETER',
              message: 'Invalid panorama identifier format.',
            },
          });
          return;
        }
        const metadata = await googleMapsProxy.getStreetViewMetadata({
          panoId: panoIdParam,
        });
        res.json(metadata);
        return;
      }

      const lat = parseLatitude(req.query.lat);
      const lng = parseLongitude(req.query.lng);
      if (lat === null || lng === null) {
        res.status(400).json({
          error: {
            code: 'INVALID_PARAMETER',
            message: 'Provide either a valid panoId or valid lat and lng coordinates.',
          },
        });
        return;
      }

      const radius = parseRadius(req.query.radius, 50);
      const metadata = await googleMapsProxy.getStreetViewMetadata({
        lat,
        lng,
        radius,
      });
      res.json(metadata);
    } catch (err) {
      sendApiError(res, err);
    }
  });

  router.post('/panoIds', metadataLimiter, async (req: Request, res: Response) => {
    try {
      const rawLocations = req.body?.locations;
      if (!Array.isArray(rawLocations) || rawLocations.length === 0 || rawLocations.length > 25) {
        res.status(400).json({
          error: {
            code: 'INVALID_PARAMETER',
            message: 'locations must be a non-empty array of up to 25 coordinate pairs.',
          },
        });
        return;
      }

      const locations: Array<{ lat: number; lng: number }> = [];
      for (const item of rawLocations) {
        const lat = parseLatitude(item?.lat);
        const lng = parseLongitude(item?.lng);
        if (lat === null || lng === null) {
          res.status(400).json({
            error: {
              code: 'INVALID_PARAMETER',
              message: 'Every location entry must include valid lat and lng coordinates.',
            },
          });
          return;
        }
        locations.push({ lat, lng });
      }

      const radius = parseRadius(req.body?.radius, 50);
      const result = await googleMapsProxy.searchPanoIds(locations, radius);
      res.json(result);
    } catch (err) {
      sendApiError(res, err);
    }
  });

  router.get('/tiles/:z/:x/:y', tileLimiter, async (req: Request, res: Response) => {
    try {
      const z = parseTileCoordinate(req.params.z, 0, 5);
      const x = parseTileCoordinate(req.params.x, 0, 64);
      const y = parseTileCoordinate(req.params.y, 0, 32);
      const panoId = req.query.panoId;

      if (z === null || x === null || y === null || !isValidPanoId(panoId)) {
        res.status(400).json({
          error: {
            code: 'INVALID_PARAMETER',
            message: 'Invalid tile coordinates (z, x, y) or panorama identifier.',
          },
        });
        return;
      }

      const { buffer, contentType } = await googleMapsProxy.getStreetViewTile({
        z,
        x,
        y,
        panoId,
      });

      // Short private cache for active session rendering; complies with Google Maps Platform usage terms
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.send(buffer);
    } catch (err) {
      sendApiError(res, err);
    }
  });

  return router;
}
