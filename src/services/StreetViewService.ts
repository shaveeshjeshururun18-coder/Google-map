import type {
  PanoramaMetadata,
  QualityPreset,
  StreetViewSessionInfo,
  TileGridSpec,
} from '../types/streetview';
import { computeTileGridSpec } from '../utils/geo';
import {
  notifyQuotaExceededIfApplicable,
  PanoramaMetadataService,
  StreetViewApiError,
} from './PanoramaMetadataService';

export interface TileLoadProgress {
  zoom: number;
  loaded: number;
  total: number;
  failed: number;
  canvas: HTMLCanvasElement;
  complete: boolean;
}

export interface ProgressivePanoramaOptions {
  quality: QualityPreset;
  maxTextureWidth?: number;
  signal?: AbortSignal;
  onProgress?: (progress: TileLoadProgress) => void;
}

const MAX_TILE_CONCURRENCY = 6;
const MAX_CANVAS_CACHE_ENTRIES = 10;

export function getTargetZoomForQuality(
  quality: QualityPreset,
  isMobileOrSoftwareGl: boolean,
): number {
  if (quality === 'fast') return 1;
  if (quality === 'high') return isMobileOrSoftwareGl ? 2 : 3;
  // Balanced: 8 tiles (z=2, up to 2048x1024) on desktop, 2 tiles (z=1) on constrained devices
  return isMobileOrSoftwareGl ? 1 : 2;
}

export class StreetViewService {
  public readonly metadataService: PanoramaMetadataService;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private sessionInfo: StreetViewSessionInfo | null = null;
  private inflightSession: Promise<StreetViewSessionInfo> | null = null;
  private readonly inflightTileBlobs = new Map<string, Promise<Blob>>();
  private readonly canvasCache = new Map<string, HTMLCanvasElement>();

  constructor(fetchImpl?: typeof fetch, apiBase = '/api/streetview') {
    const safeFetch: typeof fetch =
      !fetchImpl || fetchImpl === globalThis.fetch
        ? (input, init) => globalThis.fetch(input, init)
        : (input, init) => fetchImpl(input, init);
    this.fetchImpl = safeFetch;
    this.apiBase = apiBase;
    this.metadataService = new PanoramaMetadataService(safeFetch, apiBase);
  }

  public async checkServerConfig(): Promise<{
    apiConfigured: boolean;
    tilesApiAvailable?: boolean;
  }> {
    try {
      const res = await this.fetchImpl('/api/config');
      if (!res.ok) return { apiConfigured: false, tilesApiAvailable: false };
      const data = (await res.json()) as {
        apiConfigured?: boolean;
        tilesApiAvailable?: boolean;
      };
      return {
        apiConfigured: Boolean(data.apiConfigured),
        tilesApiAvailable:
          typeof data.tilesApiAvailable === 'boolean' ? data.tilesApiAvailable : undefined,
      };
    } catch {
      return { apiConfigured: false, tilesApiAvailable: false };
    }
  }

  public isSessionActive(): boolean {
    if (!this.sessionInfo) return false;
    return Date.now() + 60_000 < this.sessionInfo.expiryMs;
  }

  public async ensureSession(
    options?: { language?: string; region?: string; forceRefresh?: boolean },
  ): Promise<StreetViewSessionInfo> {
    if (!options?.forceRefresh && this.isSessionActive()) {
      return this.sessionInfo!;
    }

    if (!options?.forceRefresh && this.inflightSession) {
      return this.inflightSession;
    }

    const promise = (async () => {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.apiBase}/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            language: options?.language || 'en-US',
            region: options?.region || 'US',
            forceRefresh: Boolean(options?.forceRefresh),
          }),
        });
      } catch {
        throw new StreetViewApiError(
          0,
          'NETWORK_ERROR',
          'Unable to connect to the Street View server to start a session.',
        );
      }

      const payload = (await response.json().catch(() => ({}))) as Partial<StreetViewSessionInfo> & {
        error?: { code?: string; message?: string; isQuotaError?: boolean; isAuthError?: boolean };
      };

      if (!response.ok) {
        const code = payload.error?.code || 'SESSION_ERROR';
        const isQuota = Boolean(payload.error?.isQuotaError) || response.status === 429;
        if (isQuota) {
          notifyQuotaExceededIfApplicable(response.status, code);
        }
        throw new StreetViewApiError(
          response.status,
          code,
          payload.error?.message || `Failed to create Street View session (${response.status}).`,
          {
            isQuotaError: isQuota,
            isAuthError:
              Boolean(payload.error?.isAuthError) ||
              response.status === 401 ||
              response.status === 403 ||
              response.status === 503,
          },
        );
      }

      const session: StreetViewSessionInfo = {
        active: true,
        expiryMs: payload.expiryMs || Date.now() + 3600_000,
        tileWidth: payload.tileWidth || 512,
        tileHeight: payload.tileHeight || 512,
        imageFormat: payload.imageFormat || 'jpeg',
        language: payload.language || 'en-US',
        region: payload.region || 'US',
      };

      this.sessionInfo = session;
      return session;
    })().finally(() => {
      this.inflightSession = null;
    });

    this.inflightSession = promise;
    return promise;
  }

  public getTileUrl(panoId: string, z: number, x: number, y: number): string {
    return `${this.apiBase}/tiles/${z}/${x}/${y}?panoId=${encodeURIComponent(panoId)}`;
  }

  public async fetchTileBlob(
    panoId: string,
    z: number,
    x: number,
    y: number,
    signal?: AbortSignal,
  ): Promise<Blob> {
    const key = `${panoId}:${z}:${x}:${y}`;
    const existing = this.inflightTileBlobs.get(key);
    if (existing) {
      return existing;
    }

    const promise = (async () => {
      const response = await this.fetchImpl(this.getTileUrl(panoId, z, x, y), {
        method: 'GET',
        signal,
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { code?: string; message?: string; isQuotaError?: boolean };
        } | null;
        if (response.status === 429 || payload?.error?.isQuotaError) {
          notifyQuotaExceededIfApplicable(response.status, payload?.error?.code);
        }
        throw new StreetViewApiError(
          response.status,
          payload?.error?.code || 'TILE_ERROR',
          payload?.error?.message || `Tile (${z}/${x}/${y}) failed with HTTP ${response.status}.`,
          { isQuotaError: response.status === 429 },
        );
      }

      return response.blob();
    })().finally(() => {
      this.inflightTileBlobs.delete(key);
    });

    this.inflightTileBlobs.set(key, promise);
    return promise;
  }

  private async decodeBlobToDrawable(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(blob);
    }

    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('Failed to decode Street View tile image.'));
      };
      img.src = objectUrl;
    });
  }

  public getCachedPanoramaCanvas(panoId: string, zoom: number): HTMLCanvasElement | undefined {
    return this.canvasCache.get(`${panoId}:z${zoom}`);
  }

  private storeCanvasInCache(key: string, canvas: HTMLCanvasElement): void {
    if (this.canvasCache.has(key)) {
      this.canvasCache.delete(key);
    }
    this.canvasCache.set(key, canvas);
    if (this.canvasCache.size > MAX_CANVAS_CACHE_ENTRIES) {
      const oldestKey = this.canvasCache.keys().next().value;
      if (oldestKey) {
        this.canvasCache.delete(oldestKey);
      }
    }
  }

  /**
   * Progressively downloads and stitches real Street View tiles onto an equirectangular
   * canvas cropped to the exact panorama bounds for the selected zoom level.
   */
  public async loadPanoramaCanvas(
    metadata: PanoramaMetadata,
    options: ProgressivePanoramaOptions & { isConstrainedDevice?: boolean },
  ): Promise<{ canvas: HTMLCanvasElement; grid: TileGridSpec; failedTiles: number }> {
    await this.ensureSession();

    const targetZoom = getTargetZoomForQuality(
      options.quality,
      Boolean(options.isConstrainedDevice),
    );
    const cacheKey = `${metadata.panoId}:z${targetZoom}`;
    const cachedCanvas = this.canvasCache.get(cacheKey);
    const targetGrid = computeTileGridSpec(
      metadata.imageWidth,
      metadata.imageHeight,
      metadata.tileWidth,
      metadata.tileHeight,
      targetZoom,
    );

    if (cachedCanvas) {
      const total = targetGrid.tilesX * targetGrid.tilesY;
      options.onProgress?.({
        zoom: targetGrid.zoom,
        loaded: total,
        total,
        failed: 0,
        canvas: cachedCanvas,
        complete: true,
      });
      return { canvas: cachedCanvas, grid: targetGrid, failedTiles: 0 };
    }

    const maxTexW = options.maxTextureWidth ?? 4096;
    const scaleFactor =
      targetGrid.levelWidth > maxTexW ? maxTexW / targetGrid.levelWidth : 1;
    const canvasWidth = Math.max(256, Math.round(targetGrid.levelWidth * scaleFactor));
    const canvasHeight = Math.max(128, Math.round(targetGrid.levelHeight * scaleFactor));

    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new StreetViewApiError(
        0,
        'CANVAS_UNAVAILABLE',
        'Unable to acquire 2D canvas context to assemble panorama tiles.',
      );
    }

    ctx.fillStyle = '#0B0E14';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    // Stage 1: Quick single-tile preview at z=0 when loading higher resolution so user sees imagery immediately
    if (targetGrid.zoom > 0) {
      const previewGrid = computeTileGridSpec(
        metadata.imageWidth,
        metadata.imageHeight,
        metadata.tileWidth,
        metadata.tileHeight,
        0,
      );
      try {
        const previewBlob = await this.fetchTileBlob(
          metadata.panoId,
          0,
          0,
          0,
          options.signal,
        );
        if (options.signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        const previewImg = await this.decodeBlobToDrawable(previewBlob);
        ctx.drawImage(
          previewImg,
          0,
          0,
          Math.min(previewGrid.levelWidth, previewGrid.tileWidth),
          Math.min(previewGrid.levelHeight, previewGrid.tileHeight),
          0,
          0,
          canvasWidth,
          canvasHeight,
        );
        if ('close' in previewImg && typeof previewImg.close === 'function') {
          previewImg.close();
        }
        options.onProgress?.({
          zoom: 0,
          loaded: 1,
          total: targetGrid.tilesX * targetGrid.tilesY + 1,
          failed: 0,
          canvas,
          complete: false,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw err;
        }
        // Non-fatal: continue loading target zoom tiles
      }
    }

    // Stage 2: Load target zoom tiles with controlled concurrency
    const coords: Array<{ x: number; y: number }> = [];
    for (let y = 0; y < targetGrid.tilesY; y += 1) {
      for (let x = 0; x < targetGrid.tilesX; x += 1) {
        coords.push({ x, y });
      }
    }

    const totalTiles = coords.length;
    let loadedTiles = 0;
    let failedTiles = 0;
    let cursor = 0;
    let fatalError: StreetViewApiError | null = null;

    const worker = async () => {
      while (cursor < coords.length) {
        if (options.signal?.aborted || fatalError) {
          return;
        }
        const idx = cursor;
        cursor += 1;
        const { x, y } = coords[idx];

        try {
          const blob = await this.fetchTileBlob(
            metadata.panoId,
            targetGrid.zoom,
            x,
            y,
            options.signal,
          );
          if (options.signal?.aborted) return;

          const drawable = await this.decodeBlobToDrawable(blob);
          const srcX = x * targetGrid.tileWidth;
          const srcY = y * targetGrid.tileHeight;
          const validSrcW = Math.min(targetGrid.tileWidth, targetGrid.levelWidth - srcX);
          const validSrcH = Math.min(targetGrid.tileHeight, targetGrid.levelHeight - srcY);

          if (validSrcW > 0 && validSrcH > 0) {
            ctx.drawImage(
              drawable,
              0,
              0,
              validSrcW,
              validSrcH,
              srcX * scaleFactor,
              srcY * scaleFactor,
              validSrcW * scaleFactor,
              validSrcH * scaleFactor,
            );
          }

          if ('close' in drawable && typeof drawable.close === 'function') {
            drawable.close();
          }
          loadedTiles += 1;
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            return;
          }
          if (err instanceof StreetViewApiError && (err.isQuotaError || err.isAuthError)) {
            fatalError = err;
            return;
          }
          failedTiles += 1;
        }

        options.onProgress?.({
          zoom: targetGrid.zoom,
          loaded: loadedTiles,
          total: totalTiles,
          failed: failedTiles,
          canvas,
          complete: loadedTiles + failedTiles >= totalTiles,
        });
      }
    };

    const workerCount = Math.min(MAX_TILE_CONCURRENCY, totalTiles);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    if (options.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    if (fatalError) {
      throw fatalError;
    }

    if (loadedTiles === 0) {
      throw new StreetViewApiError(
        502,
        'TILES_FAILED',
        'Unable to load any Street View panorama tiles for this location.',
      );
    }

    if (failedTiles === 0) {
      this.storeCanvasInCache(cacheKey, canvas);
    }

    return { canvas, grid: targetGrid, failedTiles };
  }

  public clearSessionCaches(): void {
    this.canvasCache.clear();
    this.metadataService.clearCache();
  }
}
