import { haversineDistanceMeters } from '../../utils/geo';
import { TileDecoder } from '../rendering/TileDecoder';
import type {
  DecodedPanoramaFrame,
  PanoramaMetadata,
  PanoramaProvider,
  ProviderPolicy,
  QualityPreset,
  StreetViewLink,
} from '../types';

export interface LicensedPanoramaEntry {
  panoId: string;
  lat: number;
  lng: number;
  heading: number;
  streetName: string;
  imageUrl: string;
  date?: string;
  copyright: string;
  links: StreetViewLink[];
}

/**
 * Provider-independent adapter for independently licensed equirectangular 360° datasets
 * (e.g., proprietary fleet capture, CC-licensed street imagery, or custom studio tours)
 * where multi-hop preloading and persistent in-memory caching ARE permitted by license.
 */
export class LicensedPanoramaProvider implements PanoramaProvider {
  public readonly id: string;
  public readonly name: string;
  public readonly policy: ProviderPolicy;

  private readonly entries = new Map<string, LicensedPanoramaEntry>();
  private readonly tileDecoder = new TileDecoder(4);

  constructor(
    entries: LicensedPanoramaEntry[],
    options?: {
      id?: string;
      name?: string;
      attributionLabel?: string;
      allowMultiHopPreload?: boolean;
      allowPersistentImageCache?: boolean;
    },
  ) {
    this.id = options?.id || 'licensed-panorama-provider';
    this.name = options?.name || 'Licensed 360° Panorama Dataset';
    this.policy = Object.freeze({
      allowMultiHopPreload: options?.allowMultiHopPreload ?? true,
      allowPersistentImageCache: options?.allowPersistentImageCache ?? true,
      allowSingleNextPrepare: true,
      attributionLabel: options?.attributionLabel || 'Licensed 360° Imagery',
    });

    for (const entry of entries) {
      this.entries.set(entry.panoId, entry);
    }
  }

  private toMetadata(entry: LicensedPanoramaEntry): PanoramaMetadata {
    return {
      panoId: entry.panoId,
      lat: entry.lat,
      lng: entry.lng,
      imageHeight: 2048,
      imageWidth: 4096,
      tileHeight: 512,
      tileWidth: 512,
      heading: entry.heading,
      imageryType: 'outdoor',
      date: entry.date,
      copyright: entry.copyright,
      reportProblemLink: '',
      links: entry.links,
      streetName: entry.streetName,
      formattedLocation: entry.streetName,
    };
  }

  public async fetchMetadataById(panoId: string): Promise<PanoramaMetadata> {
    const entry = this.entries.get(panoId);
    if (!entry) {
      throw new Error(`Panorama '${panoId}' not found in licensed dataset.`);
    }
    return this.toMetadata(entry);
  }

  public async fetchMetadataByLocation(
    lat: number,
    lng: number,
    radius = 120,
  ): Promise<PanoramaMetadata> {
    let best: LicensedPanoramaEntry | null = null;
    let bestDist = Infinity;
    for (const entry of this.entries.values()) {
      const dist = haversineDistanceMeters(lat, lng, entry.lat, entry.lng);
      if (dist <= radius && dist < bestDist) {
        bestDist = dist;
        best = entry;
      }
    }
    if (!best) {
      throw new Error('No licensed panorama available within search radius.');
    }
    return this.toMetadata(best);
  }

  public async decodePanoramaFrame(
    metadata: PanoramaMetadata,
    _quality: QualityPreset,
    maxTextureWidth: number,
    signal: AbortSignal,
  ): Promise<DecodedPanoramaFrame> {
    const entry = this.entries.get(metadata.panoId);
    if (!entry) {
      throw new Error(`Panorama '${metadata.panoId}' not found in licensed dataset.`);
    }
    const decoded = await this.tileDecoder.decodeSingleEquirectangularUrl(
      entry.imageUrl,
      maxTextureWidth,
      signal,
    );
    return {
      metadata,
      canvas: decoded.canvas,
      zoom: decoded.zoom,
    };
  }
}
