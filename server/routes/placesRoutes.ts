import { Router, type Request, type Response } from 'express';
import { createRateLimiter } from '../middleware/rateLimit';
import {
  isValidPlaceId,
  parseLatitude,
  parseLongitude,
  sanitizeQueryText,
  sanitizeSessionToken,
} from '../middleware/validation';
import { googleMapsProxy, UpstreamApiError } from '../services/googleMapsProxy';

function sendPlacesError(res: Response, err: unknown): void {
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
      message: 'An unexpected server error occurred while searching locations.',
    },
  });
}

export function createPlacesRouter(): Router {
  const router = Router();

  const placesLimiter = createRateLimiter({
    windowMs: 60_000,
    maxRequests: 60,
    keyPrefix: 'places',
  });

  router.post('/autocomplete', placesLimiter, async (req: Request, res: Response) => {
    try {
      const input = sanitizeQueryText(req.body?.input, 160);
      if (!input) {
        res.status(400).json({
          error: {
            code: 'INVALID_PARAMETER',
            message: 'Search input must be a non-empty string up to 160 characters.',
          },
        });
        return;
      }

      const sessionToken = sanitizeSessionToken(req.body?.sessionToken);
      const lat =
        req.body?.lat !== undefined ? parseLatitude(req.body.lat) ?? undefined : undefined;
      const lng =
        req.body?.lng !== undefined ? parseLongitude(req.body.lng) ?? undefined : undefined;

      const data = await googleMapsProxy.autocompletePlaces({
        input,
        sessionToken,
        lat,
        lng,
      });
      res.json(data);
    } catch (err) {
      sendPlacesError(res, err);
    }
  });

  router.post('/search', placesLimiter, async (req: Request, res: Response) => {
    try {
      const textQuery = sanitizeQueryText(req.body?.textQuery, 200);
      if (!textQuery) {
        res.status(400).json({
          error: {
            code: 'INVALID_PARAMETER',
            message: 'textQuery must be a non-empty string up to 200 characters.',
          },
        });
        return;
      }

      const lat =
        req.body?.lat !== undefined ? parseLatitude(req.body.lat) ?? undefined : undefined;
      const lng =
        req.body?.lng !== undefined ? parseLongitude(req.body.lng) ?? undefined : undefined;

      const data = await googleMapsProxy.searchPlacesByText({
        textQuery,
        lat,
        lng,
      });
      res.json(data);
    } catch (err) {
      sendPlacesError(res, err);
    }
  });

  router.get('/:placeId', placesLimiter, async (req: Request, res: Response) => {
    try {
      const { placeId } = req.params;
      if (!isValidPlaceId(placeId)) {
        res.status(400).json({
          error: {
            code: 'INVALID_PARAMETER',
            message: 'Invalid Google Place ID format.',
          },
        });
        return;
      }

      const sessionToken = sanitizeSessionToken(req.query.sessionToken);
      const data = await googleMapsProxy.getPlaceDetails(placeId, sessionToken);
      res.json(data);
    } catch (err) {
      sendPlacesError(res, err);
    }
  });

  return router;
}
