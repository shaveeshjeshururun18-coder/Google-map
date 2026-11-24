/// <reference types="google.maps" />
import {
  calculateAngularDifference,
  normalizeHeading,
} from '../navigation/DirectionCalculator';
import type { PanoramaMetadata, StreetViewLink } from '../types/streetview';
import { formatCoordinates, offsetCoordinates } from '../utils/geo';

export interface MapsJsStreetViewCallbacks {
  onPanoramaLoaded: (metadata: PanoramaMetadata, alignHeading: boolean) => void;
  onPovChanged: (heading: number, pitch: number) => void;
  onUserNavigatedPano: (metadata: PanoramaMetadata) => void;
}

export function normalizeMapsJsPanoramaData(
  data: google.maps.StreetViewPanoramaData,
): PanoramaMetadata | null {
  const panoId = data.location?.pano;
  const latLng = data.location?.latLng;
  if (!panoId || !latLng) {
    return null;
  }

  const lat = latLng.lat();
  const lng = latLng.lng();
  const shortDesc = (data.location?.shortDescription || '').trim();
  const fullDesc = (data.location?.description || '').trim();
  const streetName = shortDesc || fullDesc || formatCoordinates(lat, lng);
  const formattedLocation = fullDesc || streetName;

  const seen = new Set<string>();
  const links: StreetViewLink[] = [];
  for (const item of data.links || []) {
    if (!item?.pano || item.pano === panoId || seen.has(item.pano)) {
      continue;
    }
    seen.add(item.pano);
    links.push({
      panoId: item.pano,
      heading:
        typeof item.heading === 'number' && Number.isFinite(item.heading)
          ? normalizeHeading(item.heading)
          : 0,
      text: item.description || undefined,
    });
  }

  return {
    panoId,
    lat,
    lng,
    imageHeight: data.tiles?.worldSize?.height || 6656,
    imageWidth: data.tiles?.worldSize?.width || 13312,
    tileHeight: data.tiles?.tileSize?.height || 512,
    tileWidth: data.tiles?.tileSize?.width || 512,
    heading:
      typeof data.tiles?.centerHeading === 'number' && Number.isFinite(data.tiles.centerHeading)
        ? normalizeHeading(data.tiles.centerHeading)
        : 0,
    imageryType: 'outdoor',
    date: data.imageDate || undefined,
    copyright: data.copyright || '© Google',
    reportProblemLink: `https://cbks0.googleapis.com/cbk?output=report&panoid=${encodeURIComponent(panoId)}`,
    addressComponents: [],
    links,
    streetName,
    formattedLocation,
  };
}

interface PanoramaBuffer {
  el: HTMLDivElement;
  panorama: google.maps.StreetViewPanorama;
  loadedPanoId: string | null;
  readyAtMs: number;
  programmaticTarget: string | null;
}

/**
 * Double-Buffered Official Google Maps JavaScript API Street View renderer & service bridge.
 *
 * Uses two stacked real StreetViewPanorama layers (active + pre-rendered standby) so the next
 * road panorama is pre-painted on GPU BEFORE swapping — eliminating black frames and tile flashes
 * during rapid high-speed driving while keeping 100% authentic Google Street View imagery.
 */
export class MapsJsStreetViewBridge {
  private readonly container: HTMLElement;
  private readonly service: google.maps.StreetViewService;
  private readonly streetViewLib: google.maps.StreetViewLibrary;
  private readonly callbacks: MapsJsStreetViewCallbacks;
  private readonly listeners: google.maps.MapsEventListener[] = [];
  private readonly metadataCache = new Map<string, PanoramaMetadata>();
  private readonly inFlightMetadata = new Map<string, Promise<PanoramaMetadata | null>>();
  private readonly buffers: [PanoramaBuffer, PanoramaBuffer];

  private activeIndex: 0 | 1 = 0;
  private currentPanoId: string | null = null;
  private transitionSeq = 0;
  private disposed = false;

  constructor(
    container: HTMLElement,
    streetViewLib: google.maps.StreetViewLibrary,
    callbacks: MapsJsStreetViewCallbacks,
  ) {
    this.container = container;
    this.streetViewLib = streetViewLib;
    this.callbacks = callbacks;
    this.service = new streetViewLib.StreetViewService();

    const makeBuffer = (index: 0 | 1): PanoramaBuffer => {
      const el = document.createElement('div');
      el.style.position = 'absolute';
      el.style.inset = '0';
      el.style.width = '100%';
      el.style.height = '100%';
      el.style.transition = 'opacity 75ms ease-out';
      el.style.willChange = 'opacity';
      el.style.zIndex = index === 0 ? '2' : '1';
      el.style.opacity = '1';
      el.style.pointerEvents = index === 0 ? 'auto' : 'none';
      this.container.appendChild(el);

      const panorama = new streetViewLib.StreetViewPanorama(el, {
        visible: true,
        addressControl: false,
        panControl: false,
        zoomControl: false,
        fullscreenControl: false,
        enableCloseButton: false,
        linksControl: true,
        clickToGo: true,
        motionTracking: false,
        motionTrackingControl: false,
        showRoadLabels: true,
        scrollwheel: true,
      });

      const buffer: PanoramaBuffer = {
        el,
        panorama,
        loadedPanoId: null,
        readyAtMs: 0,
        programmaticTarget: null,
      };

      this.listeners.push(
        panorama.addListener('pov_changed', () => {
          if (this.disposed || this.activeIndex !== index) return;
          const pov = panorama.getPov();
          if (pov && Number.isFinite(pov.heading)) {
            this.callbacks.onPovChanged(
              normalizeHeading(pov.heading),
              Number.isFinite(pov.pitch) ? pov.pitch : 0,
            );
          }
        }),
      );

      this.listeners.push(
        panorama.addListener('pano_changed', () => {
          if (this.disposed) return;
          const nextPano = panorama.getPano();
          if (!nextPano) return;

          if (nextPano === buffer.programmaticTarget) {
            buffer.loadedPanoId = nextPano;
            buffer.programmaticTarget = null;
            return;
          }

          // Only forward interactive clicks/arrow jumps originating on the visible active buffer
          if (this.activeIndex !== index || nextPano === this.currentPanoId) {
            return;
          }

          buffer.loadedPanoId = nextPano;
          this.currentPanoId = nextPano;
          void this.fetchMetadataByPanoId(nextPano)
            .then((meta) => {
              if (!this.disposed && meta && this.currentPanoId === meta.panoId) {
                this.callbacks.onUserNavigatedPano(meta);
                const heading = this.getHeading();
                void this.prefetchAhead(meta, heading, 3);
                this.warmStandbyBuffer(meta, heading);
              }
            })
            .catch(() => {
              // Non-fatal
            });
        }),
      );

      return buffer;
    };

    this.buffers = [makeBuffer(0), makeBuffer(1)];
  }

  private getActiveBuffer(): PanoramaBuffer {
    return this.buffers[this.activeIndex];
  }

  private getStandbyBuffer(): PanoramaBuffer {
    return this.buffers[this.activeIndex === 0 ? 1 : 0];
  }

  private swapBuffers(): void {
    const prevActive = this.getActiveBuffer();
    const nextActive = this.getStandbyBuffer();
    this.activeIndex = this.activeIndex === 0 ? 1 : 0;

    // Reveal the already-rendered nextActive cleanly on top while keeping prevActive underneath
    nextActive.el.style.opacity = '0';
    nextActive.el.style.zIndex = '2';
    nextActive.el.style.pointerEvents = 'auto';

    prevActive.el.style.zIndex = '1';
    prevActive.el.style.pointerEvents = 'none';
    prevActive.el.style.opacity = '1';

    // Force layout flush so the 75ms crossfade animates smoothly with zero black frame
    void nextActive.el.offsetWidth;
    nextActive.el.style.opacity = '1';
  }

  private pickForwardLink(
    meta: PanoramaMetadata,
    preferredHeading: number,
  ): StreetViewLink | null {
    let bestLink: StreetViewLink | null = null;
    let bestAbsAngle = Infinity;
    for (const link of meta.links) {
      const absAngle = Math.abs(calculateAngularDifference(preferredHeading, link.heading));
      if (absAngle < 65 && absAngle < bestAbsAngle) {
        bestAbsAngle = absAngle;
        bestLink = link;
      }
    }
    return bestLink;
  }

  /**
   * Pre-renders the next forward panorama onto the hidden standby StreetViewPanorama buffer
   * so Google fetches and paints its tiles BEFORE the car reaches the transition point.
   */
  private warmStandbyBuffer(meta: PanoramaMetadata, preferredHeading: number): void {
    if (this.disposed) return;
    const forward = this.pickForwardLink(meta, preferredHeading);
    if (!forward) return;

    const standby = this.getStandbyBuffer();
    if (standby.loadedPanoId === forward.panoId || standby.programmaticTarget === forward.panoId) {
      return;
    }

    const activePov = this.getActiveBuffer().panorama.getPov();
    const pitch = Number.isFinite(activePov?.pitch) ? activePov.pitch : 0;

    standby.programmaticTarget = forward.panoId;
    standby.loadedPanoId = forward.panoId;
    standby.readyAtMs = performance.now() + 420;
    standby.panorama.setPano(forward.panoId);
    standby.panorama.setPov({ heading: normalizeHeading(preferredHeading), pitch });
    standby.panorama.setZoom(1);
  }

  public async fetchMetadataByPanoId(panoId: string): Promise<PanoramaMetadata | null> {
    const cached = this.metadataCache.get(panoId);
    if (cached) return cached;

    const existing = this.inFlightMetadata.get(panoId);
    if (existing) return existing;

    const promise = this.service
      .getPanorama({ pano: panoId })
      .then((response) => {
        const meta = normalizeMapsJsPanoramaData(response.data);
        if (meta) {
          this.metadataCache.set(meta.panoId, meta);
          if (this.metadataCache.size > 180) {
            const oldestKey = this.metadataCache.keys().next().value;
            if (oldestKey) this.metadataCache.delete(oldestKey);
          }
        }
        return meta;
      })
      .finally(() => {
        this.inFlightMetadata.delete(panoId);
      });

    this.inFlightMetadata.set(panoId, promise);
    return promise;
  }

  public async prefetchAhead(
    meta: PanoramaMetadata,
    preferredHeading: number,
    depth = 3,
  ): Promise<void> {
    if (this.disposed || depth <= 0 || meta.links.length === 0) return;

    const bestLink = this.pickForwardLink(meta, preferredHeading);
    if (!bestLink) return;

    try {
      const nextMeta = await this.fetchMetadataByPanoId(bestLink.panoId);
      if (nextMeta && !this.disposed && depth > 1) {
        void this.prefetchAhead(nextMeta, bestLink.heading, depth - 1);
      }
    } catch {
      // Prefetch errors are non-fatal
    }
  }

  public async fetchMetadataByLocation(
    lat: number,
    lng: number,
    radius = 60,
    preferOutdoor = true,
    preferBest = false,
  ): Promise<PanoramaMetadata | null> {
    const request: google.maps.StreetViewLocationRequest = {
      location: { lat, lng },
      radius,
      preference: preferBest
        ? this.streetViewLib.StreetViewPreference.BEST
        : this.streetViewLib.StreetViewPreference.NEAREST,
      source: preferOutdoor
        ? this.streetViewLib.StreetViewSource.OUTDOOR
        : this.streetViewLib.StreetViewSource.DEFAULT,
    };

    const response = await this.service.getPanorama(request);
    const meta = normalizeMapsJsPanoramaData(response.data);
    if (meta) {
      this.metadataCache.set(meta.panoId, meta);
    }
    return meta;
  }

  public async loadByLocation(
    lat: number,
    lng: number,
    radius = 60,
  ): Promise<{ metadata: PanoramaMetadata; snappedToRoad: boolean } | null> {
    let meta: PanoramaMetadata | null = null;
    try {
      meta = await this.fetchMetadataByLocation(lat, lng, radius, true, false);
    } catch {
      try {
        meta = await this.fetchMetadataByLocation(lat, lng, Math.max(radius, 120), true, true);
      } catch {
        meta = await this.fetchMetadataByLocation(lat, lng, radius, false, false);
      }
    }

    if (!meta || this.disposed) {
      return null;
    }

    let snappedToRoad = false;
    if (meta.links.length === 0) {
      try {
        const bestCandidate = await this.fetchMetadataByLocation(lat, lng, 120, true, true);
        if (bestCandidate && bestCandidate.links.length > 0) {
          meta = bestCandidate;
          snappedToRoad = true;
        }
      } catch {
        // Fall through to offset ring probes
      }
    }

    if (meta.links.length === 0) {
      const probes = [
        ...[0, 60, 120, 180, 240, 300].map((b) => offsetCoordinates(lat, lng, 75, b)),
        ...[30, 150, 270].map((b) => offsetCoordinates(lat, lng, 130, b)),
      ];
      for (const pt of probes) {
        if (this.disposed) return null;
        try {
          const candidate = await this.fetchMetadataByLocation(pt.lat, pt.lng, 50, true, true);
          if (candidate && candidate.links.length > 0) {
            meta = candidate;
            snappedToRoad = true;
            break;
          }
        } catch {
          // Continue probing next offset
        }
      }
    }

    const initialHeading = meta.links[0]?.heading ?? meta.heading;
    const active = this.getActiveBuffer();
    active.programmaticTarget = meta.panoId;
    active.loadedPanoId = meta.panoId;
    this.currentPanoId = meta.panoId;

    active.panorama.setPano(meta.panoId);
    active.panorama.setPov({ heading: normalizeHeading(initialHeading), pitch: 0 });
    active.panorama.setZoom(1);

    this.callbacks.onPanoramaLoaded(meta, true);
    void this.prefetchAhead(meta, initialHeading, 3);
    this.warmStandbyBuffer(meta, initialHeading);
    return { metadata: meta, snappedToRoad };
  }

  public async loadByPanoId(
    panoId: string,
    targetHeading?: number,
  ): Promise<PanoramaMetadata | null> {
    if (this.disposed) return null;
    const seq = ++this.transitionSeq;

    const active = this.getActiveBuffer();
    const standby = this.getStandbyBuffer();
    const currentPov = active.panorama.getPov();
    const heading =
      targetHeading !== undefined
        ? normalizeHeading(targetHeading)
        : normalizeHeading(currentPov?.heading ?? 0);
    const pitch = Number.isFinite(currentPov?.pitch) ? currentPov.pitch : 0;

    // Kick off metadata fetch immediately (returns synchronously if already prefetched)
    const metaPromise = this.fetchMetadataByPanoId(panoId);

    // Ensure the standby buffer has this panorama loaded & aligned to exact camera POV
    const alreadyWarmed = standby.loadedPanoId === panoId;
    if (!alreadyWarmed) {
      standby.programmaticTarget = panoId;
      standby.loadedPanoId = panoId;
      standby.readyAtMs = performance.now() + 420;
      standby.panorama.setPano(panoId);
      standby.panorama.setZoom(1);
    }
    standby.panorama.setPov({ heading, pitch });

    // Wait just long enough for standby tiles to paint so we NEVER reveal a black screen!
    const remainingWait = standby.readyAtMs - performance.now();
    if (remainingWait > 0) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, remainingWait));
    }

    if (this.disposed || seq !== this.transitionSeq) {
      return null;
    }

    // Re-sync exact camera POV right at the swap instant (in case driver steered during brief wait)
    const latestPov = active.panorama.getPov();
    const finalHeading =
      targetHeading !== undefined
        ? normalizeHeading(targetHeading)
        : normalizeHeading(latestPov?.heading ?? heading);
    const finalPitch = Number.isFinite(latestPov?.pitch) ? latestPov.pitch : pitch;
    standby.panorama.setPov({ heading: finalHeading, pitch: finalPitch });

    // Instant double-buffered swap: zero black screen!
    this.currentPanoId = panoId;
    this.swapBuffers();

    const meta = this.metadataCache.get(panoId) ?? (await metaPromise);
    if (!meta || this.disposed) {
      return null;
    }

    if (this.currentPanoId === meta.panoId) {
      this.callbacks.onPanoramaLoaded(meta, false);
      void this.prefetchAhead(meta, finalHeading, 3);
      // After 80ms crossfade settles, immediately start pre-rendering the NEXT road step onto the freed buffer!
      window.setTimeout(() => {
        if (!this.disposed && this.currentPanoId === meta.panoId) {
          this.warmStandbyBuffer(meta, this.getHeading());
        }
      }, 85);
    }
    return meta;
  }

  public async findNearbyCoveredLocation(
    lat: number,
    lng: number,
  ): Promise<PanoramaMetadata | null> {
    for (const radius of [150, 500, 1500]) {
      try {
        const found = await this.fetchMetadataByLocation(lat, lng, radius, true);
        if (found) return found;
      } catch {
        // Continue probing wider radius
      }
    }
    return null;
  }

  public getHeading(): number {
    const pov = this.getActiveBuffer().panorama.getPov();
    return normalizeHeading(pov?.heading ?? 0);
  }

  public setHeading(heading: number): void {
    if (this.disposed) return;
    const active = this.getActiveBuffer();
    const pov = active.panorama.getPov();
    const normalized = normalizeHeading(heading);
    const pitch = Number.isFinite(pov?.pitch) ? pov.pitch : 0;
    active.panorama.setPov({ heading: normalized, pitch });
  }

  public recenter(heading?: number): void {
    if (this.disposed) return;
    const active = this.getActiveBuffer();
    const targetHeading = heading !== undefined ? normalizeHeading(heading) : this.getHeading();
    active.panorama.setPov({ heading: targetHeading, pitch: 0 });
    active.panorama.setZoom(1);
  }

  public dispose(): void {
    this.disposed = true;
    for (const listener of this.listeners) {
      listener.remove();
    }
    this.listeners.length = 0;
    this.metadataCache.clear();
    this.inFlightMetadata.clear();
    for (const buf of this.buffers) {
      if (buf.el.parentNode === this.container) {
        this.container.removeChild(buf.el);
      }
    }
  }
}
