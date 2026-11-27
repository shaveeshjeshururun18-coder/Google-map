import type {
  DirectionalChoice,
  JunctionSummary,
  NavigationHistoryEntry,
  PanoramaMetadata,
  ValidatedLink,
} from '../types';
import { normalizeHeading } from './DirectionCalculator';
import { analyzeJunction } from './JunctionDetector';
import { extractValidLinks } from './PanoramaLinks';

const MAX_HISTORY_ENTRIES = 200;
const MAX_KNOWN_METADATA = 250;

export type NavigationAction = 'forward' | 'left' | 'right' | 'reverse';

/**
 * Maintains active panorama state, validated neighbour links, junction intelligence,
 * and ordered navigation history (previous/next viewpoints).
 * Stores only lightweight panorama IDs & structural metadata — never caches imagery.
 */
export class RouteController {
  private readonly metadataByPanoId = new Map<string, PanoramaMetadata>();
  private readonly linksByPanoId = new Map<string, ValidatedLink[]>();
  private history: NavigationHistoryEntry[] = [];
  private currentIndex = -1;
  private activePanoId: string | null = null;

  public setCurrentPanorama(metadata: PanoramaMetadata, headingDeg: number): ValidatedLink[] {
    this.registerMetadata(metadata);
    this.activePanoId = metadata.panoId;

    const links = extractValidLinks(metadata, this.metadataByPanoId);
    this.linksByPanoId.set(metadata.panoId, links);
    this.recordHistory(metadata, headingDeg);
    return links;
  }

  public registerMetadata(metadata: PanoramaMetadata): void {
    if (this.metadataByPanoId.has(metadata.panoId)) {
      this.metadataByPanoId.delete(metadata.panoId);
    }
    this.metadataByPanoId.set(metadata.panoId, metadata);

    // Bounded lightweight metadata index
    if (this.metadataByPanoId.size > MAX_KNOWN_METADATA) {
      const oldest = this.metadataByPanoId.keys().next().value;
      if (oldest && oldest !== this.activePanoId) {
        this.metadataByPanoId.delete(oldest);
        this.linksByPanoId.delete(oldest);
      }
    }

    // Refresh links of active panorama if this metadata was one of its neighbours (updates measured Haversine distance)
    if (this.activePanoId) {
      const activeMeta = this.metadataByPanoId.get(this.activePanoId);
      if (activeMeta) {
        this.linksByPanoId.set(
          this.activePanoId,
          extractValidLinks(activeMeta, this.metadataByPanoId),
        );
      }
    }
  }

  public getActiveMetadata(): PanoramaMetadata | null {
    return this.activePanoId ? this.metadataByPanoId.get(this.activePanoId) ?? null : null;
  }

  public getLinksForPano(panoId: string): ValidatedLink[] {
    return this.linksByPanoId.get(panoId) ?? [];
  }

  public getKnownMetadataList(): PanoramaMetadata[] {
    return Array.from(this.metadataByPanoId.values());
  }

  public getAllLinks(): ValidatedLink[] {
    const out: ValidatedLink[] = [];
    for (const list of this.linksByPanoId.values()) {
      out.push(...list);
    }
    return out;
  }

  public getJunction(headingDeg: number, panoId = this.activePanoId): JunctionSummary {
    const links = panoId ? this.getLinksForPano(panoId) : [];
    const prevId = this.getPreviousHistoryEntry()?.panoId ?? null;
    return analyzeJunction(links, headingDeg, prevId);
  }

  public resolveDirection(
    action: NavigationAction,
    headingDeg: number,
    panoId = this.activePanoId,
  ): DirectionalChoice | null {
    const junction = this.getJunction(headingDeg, panoId);
    switch (action) {
      case 'forward':
        return junction.forward;
      case 'left':
        return junction.left;
      case 'right':
        return junction.right;
      case 'reverse':
        return junction.reverse;
    }
  }

  private recordHistory(metadata: PanoramaMetadata, headingDeg: number): void {
    const current = this.getCurrentHistoryEntry();
    if (current && current.panoId === metadata.panoId) {
      current.heading = normalizeHeading(headingDeg);
      return;
    }

    if (this.currentIndex >= 0 && this.currentIndex < this.history.length - 1) {
      this.history = this.history.slice(0, this.currentIndex + 1);
    }

    this.history.push({
      panoId: metadata.panoId,
      lat: metadata.lat,
      lng: metadata.lng,
      streetName: metadata.streetName,
      enteredAt: Date.now(),
      heading: normalizeHeading(headingDeg),
    });

    if (this.history.length > MAX_HISTORY_ENTRIES) {
      this.history.shift();
    }
    this.currentIndex = this.history.length - 1;
  }

  public getCurrentHistoryEntry(): NavigationHistoryEntry | null {
    if (this.currentIndex < 0 || this.currentIndex >= this.history.length) return null;
    return this.history[this.currentIndex];
  }

  public getPreviousHistoryEntry(): NavigationHistoryEntry | null {
    if (this.currentIndex <= 0) return null;
    return this.history[this.currentIndex - 1];
  }

  public getHistory(): NavigationHistoryEntry[] {
    return [...this.history];
  }

  public reset(): void {
    this.metadataByPanoId.clear();
    this.linksByPanoId.clear();
    this.history = [];
    this.currentIndex = -1;
    this.activePanoId = null;
  }
}
