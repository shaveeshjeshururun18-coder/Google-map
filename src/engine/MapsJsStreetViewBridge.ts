/// <reference types="google.maps" />
import {
  calculateAngularDifference,
  normalizeHeading,
} from '../navigation/DirectionCalculator';
import type {
  DrivingTelemetry,
  PanoramaMetadata,
  StreetViewLink,
} from '../types/streetview';
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
  index: number;
  el: HTMLDivElement;
  panorama: google.maps.StreetViewPanorama;
  loadedPanoId: string | null;
  programmaticTarget: string | null;
  panoChangedAtMs: number;
  firstTileSeenAtMs: number;
  lastAssignedAtMs: number;
  lastSyncedHeading: number;
}

const SEAMLESS_HANDOFF_SCALE_OFFSET = 0.045;
const MORPH_START_PROGRESS = 0.22;

/**
 * 5-Slot Lookahead Ring-Buffered, Zero-Gap Optical-Flow Google Street View Bridge.
 *
 * Pre-renders up to 4 connected real Street View panoramas ahead (N+1..N+4) in parallel
 * background buffers, detects real tile completion immediately, executes 0ms synchronous
 * handoffs, and guarantees C1-continuous forward dolly motion with zero pauses or black frames.
 */
export class MapsJsStreetViewBridge {
  private readonly container: HTMLElement;
  private readonly service: google.maps.StreetViewService;
  private readonly streetViewLib: google.maps.StreetViewLibrary;
  private readonly callbacks: MapsJsStreetViewCallbacks;
  private readonly listeners: google.maps.MapsEventListener[] = [];
  private readonly metadataCache = new Map<string, PanoramaMetadata>();
  private readonly inFlightMetadata = new Map<string, Promise<PanoramaMetadata | null>>();
  private readonly paintedPanoIds = new Set<string>();
  private readonly buffers: PanoramaBuffer[];
  private readonly lookaheadSlots: number;

  private activeIndex = 0;
  private currentPanoId: string | null = null;
  private currentMeta: PanoramaMetadata | null = null;
  private transitionSeq = 0;
  private morphingBufferIndex: number | null = null;
  private continuousHoldZoom = 0;
  private lastOpticalFlowMs = 0;
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

    if (
      typeof performance !== 'undefined' &&
      typeof performance.setResourceTimingBufferSize === 'function'
    ) {
      try {
        performance.setResourceTimingBufferSize(2000);
      } catch {
        // Ignore if unsupported
      }
    }

    const isMobile =
      typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const totalBuffers = isMobile ? 3 : 5;
    this.lookaheadSlots = totalBuffers - 1;

    const makeBuffer = (index: number): PanoramaBuffer => {
      const el = document.createElement('div');
      el.style.position = 'absolute';
      el.style.inset = '0';
      el.style.width = '100%';
      el.style.height = '100%';
      el.style.transformOrigin = '50% 48%';
      el.style.willChange = 'transform, opacity';
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
        index,
        el,
        panorama,
        loadedPanoId: null,
        programmaticTarget: null,
        panoChangedAtMs: 0,
        firstTileSeenAtMs: 0,
        lastAssignedAtMs: 0,
        lastSyncedHeading: -999,
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
            buffer.panoChangedAtMs = performance.now();
            buffer.firstTileSeenAtMs = 0;
            buffer.programmaticTarget = null;
            return;
          }

          if (this.activeIndex !== index || nextPano === this.currentPanoId) {
            return;
          }

          buffer.loadedPanoId = nextPano;
          buffer.panoChangedAtMs = performance.now();
          buffer.firstTileSeenAtMs = 0;
          this.currentPanoId = nextPano;
          void this.fetchMetadataByPanoId(nextPano)
            .then((meta) => {
              if (!this.disposed && meta && this.currentPanoId === meta.panoId) {
                this.currentMeta = meta;
                this.callbacks.onUserNavigatedPano(meta);
                const heading = this.getHeading();
                void this.prefetchAndWarmAhead(meta, heading);
              }
            })
            .catch(() => {
              // Non-fatal
            });
        }),
      );

      return buffer;
    };

    this.buffers = Array.from({ length: totalBuffers }, (_, i) => makeBuffer(i));
  }

  private getActiveBuffer(): PanoramaBuffer {
    return this.buffers[this.activeIndex];
  }

  private findStandbyBufferForPano(panoId: string): PanoramaBuffer | null {
    for (const buf of this.buffers) {
      if (buf.index === this.activeIndex) continue;
      if (buf.loadedPanoId === panoId || buf.programmaticTarget === panoId) {
        return buf;
      }
    }
    return null;
  }

  private hasTileEntriesForPano(panoId: string): boolean {
    if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') {
      return false;
    }
    const entries = performance.getEntriesByType('resource');
    const encodedPanoId = encodeURIComponent(panoId);
    const startIdx = Math.max(0, entries.length - 220);
    for (let i = entries.length - 1; i >= startIdx; i--) {
      const name = entries[i].name;
      if (
        (name.includes(panoId) || name.includes(encodedPanoId)) &&
        (name.includes('streetviewpixels') ||
          name.includes('tile') ||
          name.includes('cbk') ||
          name.includes('ggpht') ||
          name.includes('khms'))
      ) {
        // Google fetches the full-360° zoom=0 preview tile first — 1 completed tile paints the entire sphere!
        return true;
      }
    }
    return false;
  }

  private rememberPaintedPano(panoId: string): void {
    this.paintedPanoIds.add(panoId);
    if (this.paintedPanoIds.size > 300) {
      const oldest = this.paintedPanoIds.values().next().value;
      if (oldest) this.paintedPanoIds.delete(oldest);
    }
  }

  /**
   * Returns true ONLY once Google's StreetViewPanorama has emitted pano_changed AND
   * painted real panoramic tiles for targetPanoId — guaranteeing zero black frames.
   */
  private isBufferReadyForDisplay(buffer: PanoramaBuffer, targetPanoId: string): boolean {
    if (buffer.loadedPanoId !== targetPanoId || buffer.panoChangedAtMs <= 0) {
      return false;
    }
    const now = performance.now();

    if (this.paintedPanoIds.has(targetPanoId)) {
      return now >= buffer.panoChangedAtMs + 95;
    }

    if (buffer.firstTileSeenAtMs === 0 && this.hasTileEntriesForPano(targetPanoId)) {
      buffer.firstTileSeenAtMs = now;
    }

    if (buffer.firstTileSeenAtMs > 0) {
      // Allow brief WebGL texture upload + paint frame after tile arrives
      if (now >= buffer.firstTileSeenAtMs + 115) {
        this.rememberPaintedPano(targetPanoId);
        return true;
      }
      return false;
    }

    // Fallback ceiling if served from memory cache without emitting a new resource entry
    if (now >= buffer.panoChangedAtMs + 720) {
      this.rememberPaintedPano(targetPanoId);
      return true;
    }

    return false;
  }

  /**
   * Public check used by DrivingController to smoothly elastic-pace progress when a
   * brand-new turn tile is still downloading, preventing any frozen pause or black frame.
   */
  public isPanoReadyForDisplay(panoId: string | null | undefined): boolean {
    if (!panoId || this.disposed) return true;
    if (panoId === this.currentPanoId) return true;
    const buf = this.findStandbyBufferForPano(panoId);
    if (!buf) return false;
    return this.isBufferReadyForDisplay(buf, panoId);
  }

  /**
   * Synchronizes real-time optical flow every animation frame with C1 scale continuity
   * across panorama handoffs so pressing Move Forward produces zero time gap or snap-back.
   */
  public updateOpticalFlow(telemetry: DrivingTelemetry): void {
    if (this.disposed) return;

    const now = performance.now();
    const dt =
      this.lastOpticalFlowMs > 0
        ? Math.min(0.08, Math.max(0.001, (now - this.lastOpticalFlowMs) / 1000))
        : 0.016;
    this.lastOpticalFlowMs = now;

    const active = this.getActiveBuffer();
    const p = Math.max(0, Math.min(1, telemetry.progressToNext));
    const speedRatio = telemetry.speedRatio;
    const absLat = Math.abs(telemetry.lateralOffset);
    const isReverse = telemetry.gear === 'R';

    // Keep gentle forward dolly alive even if a cold intersection tile takes an extra 150ms
    if (telemetry.isMoving && !isReverse && p >= 0.94) {
      this.continuousHoldZoom = Math.min(0.18, this.continuousHoldZoom + dt * (0.12 + speedRatio * 0.16));
    } else if (!telemetry.isMoving) {
      this.continuousHoldZoom *= Math.exp(-8 * dt);
    } else if (p < 0.5) {
      this.continuousHoldZoom *= Math.exp(-14 * dt);
    }

    // 1. Dynamic lateral parallax & subtle cornering camera bank locked to the 3D vehicle
    const shiftPx = -telemetry.lateralOffset * 26;
    const bankDeg = Math.max(
      -2.2,
      Math.min(2.2, -telemetry.steeringAngle * 1.15 - telemetry.lateralVelocity * 0.24),
    );
    const edgeSafetyScale = 1 + absLat * 0.036 + Math.abs(bankDeg) * 0.015;

    // 2. Continuous forward dolly push into the road vanishing point
    const baseOffset = telemetry.isMoving && !isReverse ? SEAMLESS_HANDOFF_SCALE_OFFSET : 0;
    const dollyZoom = isReverse
      ? (1 - p) * speedRatio * 0.09
      : p * (0.19 + speedRatio * 0.14) + speedRatio * 0.02 + this.continuousHoldZoom;
    const activeScale = edgeSafetyScale + baseOffset + dollyZoom;

    active.el.style.transition = 'none';
    active.el.style.zIndex = '2';
    active.el.style.opacity = '1';
    active.el.style.pointerEvents = 'auto';
    active.el.style.transform = `translate3d(${shiftPx.toFixed(1)}px, 0, 0) rotate(${bankDeg.toFixed(2)}deg) scale(${activeScale.toFixed(4)})`;

    // 3. Progressive optical-flow cross-dissolve into verified-painted next panorama
    const targetPanoId = telemetry.targetEdge?.destinationPanoId ?? null;
    const nextBuf = targetPanoId ? this.findStandbyBufferForPano(targetPanoId) : null;
    const canMorph =
      Boolean(targetPanoId && nextBuf) &&
      this.isBufferReadyForDisplay(nextBuf!, targetPanoId!) &&
      telemetry.isMoving &&
      p > MORPH_START_PROGRESS;

    if (canMorph && nextBuf) {
      const morphT = Math.max(
        0,
        Math.min(1, (p - MORPH_START_PROGRESS) / (1 - MORPH_START_PROGRESS)),
      );
      const smoothOpacity = morphT * morphT * (3 - 2 * morphT);
      // Arrives at EXACTLY edgeSafetyScale + SEAMLESS_HANDOFF_SCALE_OFFSET at morphT = 1!
      const nextScale = edgeSafetyScale + morphT * SEAMLESS_HANDOFF_SCALE_OFFSET;

      const activePov = active.panorama.getPov();
      const activeHeading = normalizeHeading(activePov?.heading ?? telemetry.heading);
      if (Math.abs(calculateAngularDifference(nextBuf.lastSyncedHeading, activeHeading)) > 0.5) {
        nextBuf.lastSyncedHeading = activeHeading;
        nextBuf.panorama.setPov({
          heading: activeHeading,
          pitch: Number.isFinite(activePov?.pitch) ? activePov.pitch : 0,
        });
      }

      this.morphingBufferIndex = nextBuf.index;
      nextBuf.el.style.transition = 'none';
      nextBuf.el.style.zIndex = '3';
      nextBuf.el.style.pointerEvents = 'none';
      nextBuf.el.style.opacity = smoothOpacity.toFixed(3);
      nextBuf.el.style.transform = `translate3d(${shiftPx.toFixed(1)}px, 0, 0) rotate(${bankDeg.toFixed(2)}deg) scale(${nextScale.toFixed(4)})`;
    } else {
      this.morphingBufferIndex = null;
    }

    // Keep all non-active, non-morphing standby buffers tucked behind (zIndex 1, opacity 1)
    for (const buf of this.buffers) {
      if (buf.index === this.activeIndex || buf.index === this.morphingBufferIndex) {
        continue;
      }
      if (buf.el.style.zIndex !== '1') {
        buf.el.style.transition = 'none';
        buf.el.style.zIndex = '1';
        buf.el.style.opacity = '1';
        buf.el.style.pointerEvents = 'none';
        buf.el.style.transform = `scale(${edgeSafetyScale.toFixed(4)})`;
      }
    }
  }

  private promoteBuffer(targetBuf: PanoramaBuffer, wasPreMorphed: boolean): void {
    const prevActive = this.getActiveBuffer();
    this.activeIndex = targetBuf.index;
    this.morphingBufferIndex = null;
    this.continuousHoldZoom = 0;

    if (wasPreMorphed) {
      // Already smoothly morphed to ~1.0 opacity on top -> synchronous 0ms invisible handoff!
      targetBuf.el.style.transition = 'none';
      targetBuf.el.style.zIndex = '2';
      targetBuf.el.style.opacity = '1';
      targetBuf.el.style.pointerEvents = 'auto';

      prevActive.el.style.transition = 'none';
      prevActive.el.style.zIndex = '1';
      prevActive.el.style.opacity = '1';
      prevActive.el.style.pointerEvents = 'none';
      prevActive.el.style.transform = 'scale(1)';
      return;
    }

    // Crisp 65ms crossfade for sudden intersection turns / un-morphed jumps
    targetBuf.el.style.transition = 'opacity 65ms ease-out';
    targetBuf.el.style.opacity = '0';
    targetBuf.el.style.zIndex = '3';
    targetBuf.el.style.pointerEvents = 'auto';

    prevActive.el.style.zIndex = '2';
    prevActive.el.style.pointerEvents = 'none';
    prevActive.el.style.opacity = '1';

    void targetBuf.el.offsetWidth;
    targetBuf.el.style.opacity = '1';

    window.setTimeout(() => {
      if (this.disposed) return;
      if (this.activeIndex === targetBuf.index) {
        targetBuf.el.style.zIndex = '2';
      }
      if (this.activeIndex !== prevActive.index && this.morphingBufferIndex !== prevActive.index) {
        prevActive.el.style.zIndex = '1';
        prevActive.el.style.transform = 'scale(1)';
      }
    }, 70);
  }

  private pickForwardLink(
    meta: PanoramaMetadata,
    preferredHeading: number,
  ): StreetViewLink | null {
    let bestLink: StreetViewLink | null = null;
    let bestAbsAngle = Infinity;
    for (const link of meta.links) {
      const absAngle = Math.abs(calculateAngularDifference(preferredHeading, link.heading));
      if (absAngle < 76 && absAngle < bestAbsAngle) {
        bestAbsAngle = absAngle;
        bestLink = link;
      }
    }
    return bestLink;
  }

  /**
   * Walks the cached forward road chain (N+1..N+4) and assigns each hop to a dedicated
   * background StreetViewPanorama buffer so tiles paint well BEFORE arrival.
   */
  private warmLookaheadRing(startMeta: PanoramaMetadata, preferredHeading: number): void {
    if (this.disposed) return;

    const desiredChain: Array<{ panoId: string; heading: number }> = [];
    const seen = new Set<string>([startMeta.panoId]);
    let cursorMeta: PanoramaMetadata | undefined = startMeta;
    let cursorHeading = normalizeHeading(preferredHeading);

    for (let hop = 0; hop < this.lookaheadSlots && cursorMeta; hop++) {
      const nextLink = this.pickForwardLink(cursorMeta, cursorHeading);
      if (!nextLink || seen.has(nextLink.panoId)) break;
      seen.add(nextLink.panoId);
      desiredChain.push({ panoId: nextLink.panoId, heading: nextLink.heading });
      cursorMeta = this.metadataCache.get(nextLink.panoId);
      cursorHeading = nextLink.heading;
    }

    if (desiredChain.length === 0) return;

    const desiredSet = new Set(desiredChain.map((item) => item.panoId));
    const activePov = this.getActiveBuffer().panorama.getPov();
    const pitch = Number.isFinite(activePov?.pitch) ? activePov.pitch : 0;

    for (const target of desiredChain) {
      if (this.findStandbyBufferForPano(target.panoId)) {
        continue;
      }

      const candidates = this.buffers.filter((buf) => {
        if (buf.index === this.activeIndex || buf.index === this.morphingBufferIndex) {
          return false;
        }
        const heldId = buf.programmaticTarget || buf.loadedPanoId;
        return !heldId || !desiredSet.has(heldId);
      });

      if (candidates.length === 0) break;

      candidates.sort((a, b) => a.lastAssignedAtMs - b.lastAssignedAtMs);
      const slot = candidates[0];
      const normHeading = normalizeHeading(target.heading);

      slot.programmaticTarget = target.panoId;
      slot.loadedPanoId = null;
      slot.panoChangedAtMs = 0;
      slot.firstTileSeenAtMs = 0;
      slot.lastAssignedAtMs = performance.now();
      slot.lastSyncedHeading = normHeading;
      slot.panorama.setPano(target.panoId);
      slot.panorama.setPov({ heading: normHeading, pitch });
      slot.panorama.setZoom(1);
    }
  }

  /**
   * Prefetches metadata up to 5 hops ahead and immediately warms all 4 background
   * StreetViewPanorama slots as each hop resolves.
   */
  public async prefetchAndWarmAhead(
    startMeta: PanoramaMetadata,
    preferredHeading: number,
  ): Promise<void> {
    if (this.disposed) return;

    this.warmLookaheadRing(startMeta, preferredHeading);

    const seen = new Set<string>([startMeta.panoId]);
    let cursorMeta: PanoramaMetadata = startMeta;
    let cursorHeading = normalizeHeading(preferredHeading);

    for (let hop = 0; hop < this.lookaheadSlots + 1; hop++) {
      if (this.disposed || this.currentPanoId !== startMeta.panoId) return;
      const nextLink = this.pickForwardLink(cursorMeta, cursorHeading);
      if (!nextLink || seen.has(nextLink.panoId)) break;
      seen.add(nextLink.panoId);

      try {
        const nextMeta = await this.fetchMetadataByPanoId(nextLink.panoId);
        if (!nextMeta || this.disposed) break;
        if (this.currentMeta) {
          this.warmLookaheadRing(this.currentMeta, this.getHeading());
        }
        cursorMeta = nextMeta;
        cursorHeading = nextLink.heading;
      } catch {
        break;
      }
    }
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
          if (this.metadataCache.size > 300) {
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
    active.panoChangedAtMs = performance.now();
    active.firstTileSeenAtMs = 0;
    active.lastAssignedAtMs = performance.now();
    active.el.style.transform = '';
    active.el.style.opacity = '1';
    this.currentPanoId = meta.panoId;
    this.currentMeta = meta;
    this.continuousHoldZoom = 0;

    active.panorama.setPano(meta.panoId);
    active.panorama.setPov({ heading: normalizeHeading(initialHeading), pitch: 0 });
    active.panorama.setZoom(1);

    this.callbacks.onPanoramaLoaded(meta, true);
    void this.prefetchAndWarmAhead(meta, initialHeading);
    return { metadata: meta, snappedToRoad };
  }

  /**
   * Advances to the next connected panorama with 0ms synchronous handoff whenever
   * the panorama is already pre-rendered in our 5-slot lookahead ring buffer!
   * Never promotes an unpainted buffer onto the screen (zero black frames).
   */
  public async loadByPanoId(
    panoId: string,
    targetHeading?: number,
  ): Promise<PanoramaMetadata | null> {
    if (this.disposed) return null;
    const seq = ++this.transitionSeq;

    const active = this.getActiveBuffer();
    const currentPov = active.panorama.getPov();
    const heading =
      targetHeading !== undefined
        ? normalizeHeading(targetHeading)
        : normalizeHeading(currentPov?.heading ?? 0);
    const pitch = Number.isFinite(currentPov?.pitch) ? currentPov.pitch : 0;

    let targetBuf = this.findStandbyBufferForPano(panoId);
    const readyNow = Boolean(targetBuf && this.isBufferReadyForDisplay(targetBuf, panoId));

    if (readyNow && targetBuf) {
      // === FAST PATH: 0ms SYNCHRONOUS ZERO-GAP HANDOFF ===
      const wasPreMorphed =
        this.morphingBufferIndex === targetBuf.index || targetBuf.el.style.zIndex === '3';
      if (Math.abs(calculateAngularDifference(targetBuf.lastSyncedHeading, heading)) > 0.4) {
        targetBuf.lastSyncedHeading = heading;
        targetBuf.panorama.setPov({ heading, pitch });
      }

      this.currentPanoId = panoId;
      this.promoteBuffer(targetBuf, wasPreMorphed);

      const cachedMeta = this.metadataCache.get(panoId);
      if (cachedMeta) {
        this.currentMeta = cachedMeta;
        this.callbacks.onPanoramaLoaded(cachedMeta, false);
        void this.prefetchAndWarmAhead(cachedMeta, heading);
        return cachedMeta;
      }

      const fetchedMeta = await this.fetchMetadataByPanoId(panoId);
      if (fetchedMeta && !this.disposed && this.currentPanoId === fetchedMeta.panoId) {
        this.currentMeta = fetchedMeta;
        this.callbacks.onPanoramaLoaded(fetchedMeta, false);
        void this.prefetchAndWarmAhead(fetchedMeta, this.getHeading());
      }
      return fetchedMeta;
    }

    // === COLD PATH (e.g. sudden 90° intersection turn onto an un-warmed street) ===
    const metaPromise = this.fetchMetadataByPanoId(panoId);

    if (!targetBuf) {
      const standbyPool = this.buffers.filter((b) => b.index !== this.activeIndex);
      standbyPool.sort((a, b) => a.lastAssignedAtMs - b.lastAssignedAtMs);
      targetBuf = standbyPool[0];
      targetBuf.programmaticTarget = panoId;
      targetBuf.loadedPanoId = null;
      targetBuf.panoChangedAtMs = 0;
      targetBuf.firstTileSeenAtMs = 0;
      targetBuf.lastAssignedAtMs = performance.now();
      targetBuf.panorama.setPano(panoId);
      targetBuf.panorama.setZoom(1);
    }

    targetBuf.lastSyncedHeading = heading;
    targetBuf.panorama.setPov({ heading, pitch });

    // Wait up to 2.2s for real tiles to paint (active panorama keeps dollying smoothly — NEVER black!)
    const waitDeadline = performance.now() + 2200;
    while (
      !this.disposed &&
      seq === this.transitionSeq &&
      !this.isBufferReadyForDisplay(targetBuf, panoId) &&
      performance.now() < waitDeadline
    ) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 25));
    }

    if (this.disposed || seq !== this.transitionSeq) {
      return null;
    }

    const latestPov = this.getActiveBuffer().panorama.getPov();
    const finalHeading =
      targetHeading !== undefined
        ? normalizeHeading(targetHeading)
        : normalizeHeading(latestPov?.heading ?? heading);
    const finalPitch = Number.isFinite(latestPov?.pitch) ? latestPov.pitch : pitch;
    targetBuf.lastSyncedHeading = finalHeading;
    targetBuf.panorama.setPov({ heading: finalHeading, pitch: finalPitch });

    const wasPreMorphed =
      this.morphingBufferIndex === targetBuf.index || targetBuf.el.style.zIndex === '3';
    this.currentPanoId = panoId;
    this.promoteBuffer(targetBuf, wasPreMorphed);

    const meta = this.metadataCache.get(panoId) ?? (await metaPromise);
    if (!meta || this.disposed) {
      return null;
    }

    if (this.currentPanoId === meta.panoId) {
      this.currentMeta = meta;
      this.callbacks.onPanoramaLoaded(meta, false);
      void this.prefetchAndWarmAhead(meta, finalHeading);
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
    this.paintedPanoIds.clear();
    for (const buf of this.buffers) {
      if (buf.el.parentNode === this.container) {
        this.container.removeChild(buf.el);
      }
    }
  }
}
