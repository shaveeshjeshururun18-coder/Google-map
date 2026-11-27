import { PanoramaMetadataService, StreetViewApiError } from '../../services/PanoramaMetadataService';
import { StreetViewService } from '../../services/StreetViewService';
import { TileDecoder } from '../rendering/TileDecoder';
import type {
  DecodedPanoramaFrame,
  PanoramaMetadata,
  PanoramaProvider,
  ProviderPolicy,
  QualityPreset,
} from '../types';

/**
 * Primary Google Street View provider.
 * Uses the official Street View Tiles API via our backend proxy (`/api/streetview/*`,
 * session `mapType: "streetview"`).
 *
 * Policy enforcement:
 * - `allowMultiHopPreload: false` (no bulk prefetching of Street View imagery)
 * - `allowPersistentImageCache: false` (no persistent image caching beyond active Buffer A / B)
 * - `allowSingleNextPrepare: true` (prepares only the active next panorama in Buffer B)
 */
export class GoogleStreetViewProvider implements PanoramaProvider {
  public readonly id = 'google-street-view';
  public readonly name = 'Google Street View';
  public readonly policy: ProviderPolicy = Object.freeze({
    allowMultiHopPreload: false,
    allowPersistentImageCache: false,
    allowSingleNextPrepare: true,
    attributionLabel: 'Google Street View',
  });

  private readonly svService: StreetViewService;
  private readonly metadataService: PanoramaMetadataService;
  private readonly tileDecoder = new TileDecoder(6);

  constructor(svService: StreetViewService = new StreetViewService()) {
    this.svService = svService;
    this.metadataService = svService.metadataService;
  }

  public async checkServerConfig(): Promise<{
    apiConfigured: boolean;
    tilesApiAvailable?: boolean;
  }> {
    return this.svService.checkServerConfig();
  }

  public async ensureSession(): Promise<void> {
    await this.svService.ensureSession();
  }

  public async fetchMetadataByLocation(
    lat: number,
    lng: number,
    radius = 60,
    signal?: AbortSignal,
  ): Promise<PanoramaMetadata> {
    return this.metadataService.getMetadataByLocation(lat, lng, radius, signal);
  }

  public async fetchMetadataById(
    panoId: string,
    signal?: AbortSignal,
  ): Promise<PanoramaMetadata> {
    return this.metadataService.getMetadataByPanoId(panoId, signal);
  }

  public async decodePanoramaFrame(
    metadata: PanoramaMetadata,
    quality: QualityPreset,
    maxTextureWidth: number,
    signal: AbortSignal,
  ): Promise<DecodedPanoramaFrame> {
    const result = await this.tileDecoder.assembleTileGrid(
      metadata,
      quality,
      maxTextureWidth,
      async (z, x, y, tileSignal) => {
        const res = await fetch(
          `/api/streetview/tiles/${z}/${x}/${y}?panoId=${encodeURIComponent(metadata.panoId)}`,
          { signal: tileSignal },
        );
        if (!res.ok) {
          if (res.status === 404) return null;
          throw new StreetViewApiError(
            res.status,
            'TILE_ERROR',
            `Street View tile request failed (HTTP ${res.status}).`,
          );
        }
        return res.blob();
      },
      signal,
    );

    return {
      metadata,
      canvas: result.canvas,
      zoom: result.zoom,
    };
  }

  public async findNearbyCoverage(
    lat: number,
    lng: number,
    signal?: AbortSignal,
  ): Promise<PanoramaMetadata | null> {
    return this.metadataService.findNearbyCoveredLocation(lat, lng, signal);
  }

  public async findNearbyDrivableCoverage(
    lat: number,
    lng: number,
    excludePanoId?: string,
    signal?: AbortSignal,
  ): Promise<PanoramaMetadata | null> {
    return this.metadataService.findNearbyDrivableLocation(lat, lng, excludePanoId, signal);
  }
}
