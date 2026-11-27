/// <reference types="google.maps" />
import { formatCoordinates, offsetCoordinates } from '../../utils/geo';
import { calculateAngularDifference, normalizeHeading } from '../navigation/DirectionCalculator';
import { LoadingMonitor } from '../performance/LoadingMonitor';
import type {
  BufferMonitorSnapshot,
  BufferSlotId,
  GearMode,
  PanoramaMetadata,
  StreetViewLink,
} from '../types';
import {
  computeGlideFrame,
  CONTINUOUS_GLIDE_SPEC,
  smootherstep,
  type GlideFrameState,
} from './ContinuousGlide';

export interface MapsJsDoubleBufferCallbacks {
  onPanoramaLoaded: (metadata: PanoramaMetadata, alignHeading: boolean) => void;
  onPovChanged: (heading: number, pitch: number) => void;
  onUserNavigatedPano: (metadata: PanoramaMetadata) => void;
  onMonitorUpdate?: (snapshot: BufferMonitorSnapshot) => void;
}

export function normalizeGoogleStreetViewData(
  data: google.maps.StreetViewPanoramaData,
): PanoramaMetadata | null {
  const panoId = data.location?.pano;
  const latLng = data.location?.latLng;
  if (!panoId || !latLng) return null;

  const lat = latLng.lat();
  const lng = latLng.lng();
  const shortDesc = (data.location?.shortDescription || '').trim();
  const fullDesc = (data.location?.description || '').trim();
  const streetName = shortDesc || fullDesc || formatCoordinates(lat, lng);
  const formattedLocation = fullDesc || streetName;

  const seen = new Set<string>();
  const links: StreetViewLink[] = [];
  for (const item of data.links || []) {
    if (!item?.pano || item.pano === panoId || seen.has(item.pano)) continue;
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

interface DomBufferSlot {
  id: BufferSlotId;
  el: HTMLDivElement;
  panorama: google.maps.StreetViewPanorama;
  loadedPanoId: string | null;
  targetPanoId: string | null;
  panoChangedAtMs: number;
  firstTileSeenAtMs: number;
  highResBatchSeenAtMs: number;
  lastSyncedHeading: number;
  lastSyncedPitch: number;
  lastAppliedScale: number;
  cachedCanvas: HTMLCanvasElement | null;
}

/**
 * Dual-Buffer C-Infinity Continuous Optical-Flow Street View Renderer (Buffer A + Buffer B).
 *
 * Applies sub-pixel GPU-composited `scale3d` ONLY to the WebGL `<canvas>` inside each
 * StreetViewPanorama (keeping Google's logo and copyright bar 100% unscaled and pinned at
 * the bottom corners!) so every single frame at 60 FPS smoothly advances the street toward
 * the viewer with exact exponential optical-flow continuity:
 *  - Forward: Buffer A glides 1.26 -> 1.588 while dissolving 1.0 -> 0.0 (C2 smootherstep)
 *             Buffer B glides 1.00 -> 1.26 underneath at the exact same log-velocity
 *  - Handoff: At t = 1.0, Buffer A is 0% opacity and Buffer B is ALREADY at scale = 1.26 —
 *             promoting Buffer B changes ZERO pixels and preserves exact forward velocity!
 */
export class MapsJsDoubleBufferRenderer {
  private readonly container: HTMLElement;
  private readonly streetViewLib: google.maps.StreetViewLibrary;
  private readonly service: google.maps.StreetViewService;
  private readonly callbacks: MapsJsDoubleBufferCallbacks;
  private readonly monitor = new LoadingMonitor();
  private readonly listeners: google.maps.MapsEventListener[] = [];
  private readonly buffers: Record<BufferSlotId, DomBufferSlot>;

  private displayedId: BufferSlotId = 'A';
  private currentPanoId: string | null = null;
  private transitionSeq = 0;
  private manualGlideActive = false;
  private disposed = false;

  constructor(
    container: HTMLElement,
    streetViewLib: google.maps.StreetViewLibrary,
    callbacks: MapsJsDoubleBufferCallbacks,
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
        performance.setResourceTimingBufferSize(1200);
      } catch {
        // Ignore if unsupported
      }
    }

    this.buffers = {
      A: this.createSlot('A', true),
      B: this.createSlot('B', false),
    };
  }

  private createSlot(id: BufferSlotId, isInitiallyDisplayed: boolean): DomBufferSlot {
    const el = document.createElement('div');
    el.dataset.bufferSlot = id;
    el.style.position = 'absolute';
    el.style.inset = '0';
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.overflow = 'hidden';
    el.style.transition = 'none';
    el.style.transform = 'none';
    el.style.opacity = '1';
    el.style.willChange = 'opacity';
    el.style.zIndex = isInitiallyDisplayed ? '2' : '1';
    el.style.pointerEvents = isInitiallyDisplayed ? 'auto' : 'none';
    this.container.appendChild(el);

    const panorama = new this.streetViewLib.StreetViewPanorama(el, {
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
      scrollwheel: false,
      zoom: CONTINUOUS_GLIDE_SPEC.baseZoom,
    });

    const slot: DomBufferSlot = {
      id,
      el,
      panorama,
      loadedPanoId: null,
      targetPanoId: null,
      panoChangedAtMs: 0,
      firstTileSeenAtMs: 0,
      highResBatchSeenAtMs: 0,
      lastSyncedHeading: -999,
      lastSyncedPitch: -999,
      lastAppliedScale: -1,
      cachedCanvas: null,
    };

    this.listeners.push(
      panorama.addListener('pov_changed', () => {
        if (this.disposed || this.displayedId !== id) return;
        const pov = panorama.getPov();
        if (pov && Number.isFinite(pov.heading)) {
          const heading = normalizeHeading(pov.heading);
          const pitch = Number.isFinite(pov.pitch) ? pov.pitch : 0;
          this.syncSlotPov(this.getStaging(), heading, pitch);
          this.callbacks.onPovChanged(heading, pitch);
        }
      }),
    );

    this.listeners.push(
      panorama.addListener('pano_changed', () => {
        if (this.disposed) return;
        const nextPano = panorama.getPano();
        if (!nextPano) return;

        if (nextPano === slot.targetPanoId) {
          slot.loadedPanoId = nextPano;
          slot.panoChangedAtMs = performance.now();
          slot.firstTileSeenAtMs = 0;
          slot.highResBatchSeenAtMs = 0;
          slot.targetPanoId = null;
          return;
        }

        if (this.displayedId !== id || nextPano === this.currentPanoId) return;

        slot.loadedPanoId = nextPano;
        slot.panoChangedAtMs = performance.now();
        slot.firstTileSeenAtMs = 0;
        slot.highResBatchSeenAtMs = 0;
        this.currentPanoId = nextPano;
        this.resetVisualStateToNeutral();
        this.monitor.markInitialDisplay(id, nextPano);
        this.emitMonitor();

        void this.fetchMetadataByPanoId(nextPano)
          .then((meta) => {
            if (!this.disposed && meta && this.currentPanoId === meta.panoId) {
              this.callbacks.onUserNavigatedPano(meta);
            }
          })
          .catch(() => {
            // Non-fatal
          });
      }),
    );

    return slot;
  }

  private getDisplayed(): DomBufferSlot {
    return this.buffers[this.displayedId];
  }

  private getStaging(): DomBufferSlot {
    return this.buffers[this.displayedId === 'A' ? 'B' : 'A'];
  }

  private emitMonitor(): void {
    this.callbacks.onMonitorUpdate?.(this.monitor.getSnapshot());
  }

  public getMonitorSnapshot(): BufferMonitorSnapshot {
    return this.monitor.getSnapshot();
  }

  /**
   * Locates the rendered WebGL `<canvas>` inside a StreetViewPanorama container so GPU
   * optical-flow scaling transforms ONLY the 360° street imagery — never Google's logo or
   * copyright bar!
   */
  private getSlotCanvas(slot: DomBufferSlot): HTMLCanvasElement | null {
    if (slot.cachedCanvas && slot.el.contains(slot.cachedCanvas)) {
      return slot.cachedCanvas;
    }
    const canvas = slot.el.querySelector('canvas');
    if (canvas) {
      canvas.style.willChange = 'transform';
      canvas.style.transition = 'none';
      slot.cachedCanvas = canvas;
    }
    return canvas;
  }

  private applyCanvasScale(
    slot: DomBufferSlot,
    scale: number,
    originXPercent = 50,
    originYPercent = 48,
  ): void {
    const canvas = this.getSlotCanvas(slot);
    if (!canvas) return;
    const clampedScale = Math.max(1, Math.min(2.1, scale));
    canvas.style.transformOrigin = `${originXPercent.toFixed(1)}% ${originYPercent.toFixed(1)}%`;
    canvas.style.transform = `scale3d(${clampedScale.toFixed(5)}, ${clampedScale.toFixed(5)}, 1)`;
    slot.lastAppliedScale = clampedScale;
    slot.el.dataset.glideScale = clampedScale.toFixed(4);
  }

  private syncSlotPov(slot: DomBufferSlot, heading: number, pitch: number): void {
    const normHeading = normalizeHeading(heading);
    const clampedPitch = Math.max(-75, Math.min(75, pitch));
    if (
      Math.abs(calculateAngularDifference(slot.lastSyncedHeading, normHeading)) > 0.12 ||
      Math.abs(slot.lastSyncedPitch - clampedPitch) > 0.12
    ) {
      slot.lastSyncedHeading = normHeading;
      slot.lastSyncedPitch = clampedPitch;
      slot.panorama.setPov({ heading: normHeading, pitch: clampedPitch });
    }
  }

  private resetVisualStateToNeutral(gear: GearMode = 'D'): void {
    const displayed = this.getDisplayed();
    const staging = this.getStaging();
    const frame = computeGlideFrame({ progress: 0, gear, isBufferBReady: true });

    displayed.el.style.zIndex = '2';
    displayed.el.style.pointerEvents = 'auto';
    displayed.el.style.opacity = '1';
    this.applyCanvasScale(displayed, frame.displayedScale);

    staging.el.style.zIndex = '1';
    staging.el.style.pointerEvents = 'none';
    staging.el.style.opacity = '1';
    this.applyCanvasScale(staging, frame.stagingScale);
  }

  private countTileResourcesLoaded(panoId: string, sinceMs: number): number {
    if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') {
      return 0;
    }
    const entries = performance.getEntriesByType('resource');
    const encoded = encodeURIComponent(panoId);
    const startIdx = Math.max(0, entries.length - 220);
    let count = 0;
    for (let i = entries.length - 1; i >= startIdx; i -= 1) {
      const entry = entries[i];
      if (entry.startTime + entry.duration < sinceMs - 2000) continue;
      const name = entry.name;
      if (
        (name.includes(panoId) || name.includes(encoded)) &&
        (name.includes('streetviewpixels') ||
          name.includes('tile') ||
          name.includes('cbk') ||
          name.includes('ggpht') ||
          name.includes('khms'))
      ) {
        count += 1;
      }
    }
    return count;
  }

  private isSlotPaintedFor(slot: DomBufferSlot, panoId: string): boolean {
    if (slot.loadedPanoId !== panoId || slot.panoChangedAtMs <= 0) {
      return false;
    }
    const now = performance.now();
    const tileCount = this.countTileResourcesLoaded(panoId, slot.panoChangedAtMs);

    if (tileCount >= 1 && slot.firstTileSeenAtMs === 0) {
      slot.firstTileSeenAtMs = now;
    }
    if (tileCount >= 5 && slot.highResBatchSeenAtMs === 0) {
      slot.highResBatchSeenAtMs = now;
    }

    if (slot.highResBatchSeenAtMs > 0 && now >= slot.highResBatchSeenAtMs + 140) {
      this.monitor.markReady(slot.id, panoId);
      return true;
    }
    if (slot.firstTileSeenAtMs > 0 && now >= slot.firstTileSeenAtMs + 420) {
      this.monitor.markReady(slot.id, panoId);
      return true;
    }
    if (now >= slot.panoChangedAtMs + 820) {
      this.monitor.markReady(slot.id, panoId);
      return true;
    }
    return false;
  }

  public prepareNextInStaging(panoId: string, headingDeg: number, gear: GearMode = 'D'): void {
    if (this.disposed || !panoId || panoId === this.currentPanoId) return;
    const displayed = this.getDisplayed();
    const staging = this.getStaging();
    const activePov = displayed.panorama.getPov();
    const heading =
      activePov && Number.isFinite(activePov.heading)
        ? normalizeHeading(activePov.heading)
        : normalizeHeading(headingDeg);
    const pitch = Number.isFinite(activePov?.pitch) ? activePov.pitch : 0;

    if (staging.loadedPanoId === panoId || staging.targetPanoId === panoId) {
      this.syncSlotPov(staging, heading, pitch);
      return;
    }

    const startFrame = computeGlideFrame({ progress: 0, gear, isBufferBReady: true });
    staging.targetPanoId = panoId;
    staging.loadedPanoId = null;
    staging.panoChangedAtMs = 0;
    staging.firstTileSeenAtMs = 0;
    staging.highResBatchSeenAtMs = 0;
    staging.el.style.zIndex = '1';
    staging.el.style.pointerEvents = 'none';
    staging.el.style.opacity = '1';
    staging.panorama.setPano(panoId);
    staging.panorama.setZoom(CONTINUOUS_GLIDE_SPEC.baseZoom);
    this.syncSlotPov(staging, heading, pitch);
    this.applyCanvasScale(staging, startFrame.stagingScale);

    this.monitor.markPreparing(staging.id, panoId);
    this.emitMonitor();
  }

  public isStagingReadyFor(panoId: string | null | undefined): boolean {
    if (!panoId || this.disposed) return false;
    if (panoId === this.currentPanoId) return true;
    return this.isSlotPaintedFor(this.getStaging(), panoId);
  }

  /**
   * Called on EVERY 60fps animation frame.
   * Advances BOTH WebGL canvases forward at the exact same exponential optical-flow rate
   * anchored to the live road vanishing point while smoothly cross-morphing A -> B.
   */
  public updateGlideFrame(
    progress: number,
    gear: GearMode,
    targetPanoId: string | null,
    targetHeadingDeg?: number,
  ): GlideFrameState {
    const ready = targetPanoId ? this.isStagingReadyFor(targetPanoId) : false;
    const frame = computeGlideFrame({
      progress,
      gear,
      isBufferBReady: ready,
    });

    if (this.disposed || this.manualGlideActive) {
      return frame;
    }

    const displayed = this.getDisplayed();
    const staging = this.getStaging();
    const activePov = displayed.panorama.getPov();
    const heading = normalizeHeading(activePov?.heading ?? 0);
    const pitch = Number.isFinite(activePov?.pitch) ? activePov.pitch : 0;

    // Align optical expansion origin to the real road vanishing point
    const roadAngleOffset =
      targetHeadingDeg !== undefined
        ? calculateAngularDifference(heading, targetHeadingDeg)
        : 0;
    const originX = Math.max(25, Math.min(75, 50 + (roadAngleOffset / 55) * 28));
    const originY = Math.max(30, Math.min(70, 48 + (pitch / 45) * 20));

    this.applyCanvasScale(displayed, frame.displayedScale, originX, originY);
    displayed.el.style.opacity = frame.displayedOpacity.toFixed(4);

    if (
      targetPanoId &&
      (staging.loadedPanoId === targetPanoId || staging.targetPanoId === targetPanoId)
    ) {
      this.syncSlotPov(staging, heading, pitch);
      this.applyCanvasScale(staging, frame.stagingScale, originX, originY);
      staging.el.style.opacity = '1';
    }

    return frame;
  }

  /**
   * Silent C-infinity continuous handoff at t = 1.0:
   * Outgoing Buffer A is already 0% opacity and incoming Buffer B is already at scale = 1.26,
   * opacity = 1.0 — promoting Buffer B changes ZERO pixels and preserves exact forward velocity!
   */
  public async commitContinuousGlideHandoff(
    panoId: string,
    gear: GearMode = 'D',
  ): Promise<PanoramaMetadata | null> {
    if (this.disposed) return null;
    const seq = ++this.transitionSeq;

    const displayed = this.getDisplayed();
    const staging = this.getStaging();
    const activePov = displayed.panorama.getPov();
    const heading = normalizeHeading(activePov?.heading ?? 0);
    const pitch = Number.isFinite(activePov?.pitch) ? activePov.pitch : 0;

    this.prepareNextInStaging(panoId, heading, gear);
    const metaPromise = this.fetchMetadataByPanoId(panoId);

    const deadline = performance.now() + 2000;
    while (
      !this.disposed &&
      seq === this.transitionSeq &&
      !this.isSlotPaintedFor(staging, panoId) &&
      performance.now() < deadline
    ) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
    }

    if (this.disposed || seq !== this.transitionSeq) return null;

    const latestPov = displayed.panorama.getPov();
    const finalHeading = normalizeHeading(latestPov?.heading ?? heading);
    const finalPitch = Number.isFinite(latestPov?.pitch) ? latestPov.pitch : pitch;

    this.syncSlotPov(staging, finalHeading, finalPitch);
    this.applyCanvasScale(staging, CONTINUOUS_GLIDE_SPEC.scaleRatio);

    staging.el.style.opacity = '1';
    staging.el.style.zIndex = '2';
    staging.el.style.pointerEvents = 'auto';

    displayed.el.style.zIndex = '1';
    displayed.el.style.pointerEvents = 'none';
    displayed.el.style.opacity = '1';

    this.displayedId = staging.id;
    this.currentPanoId = panoId;
    this.monitor.markSwapped(staging.id, panoId, displayed.id);
    this.emitMonitor();

    const metadata = await metaPromise;
    if (!metadata || this.disposed || this.currentPanoId !== metadata.panoId) {
      return metadata;
    }

    this.callbacks.onPanoramaLoaded(metadata, false);
    return metadata;
  }

  /**
   * Smooth, unhurried 1.5-second continuous glide when clicking a turn button
   * (Left / Right / Forward / Reverse) — never a sudden cut!
   */
  public async animateGlideToPanoId(
    panoId: string,
    targetHeading?: number,
    durationMs = 1500,
    gear: GearMode = 'D',
  ): Promise<PanoramaMetadata | null> {
    if (this.disposed) return null;
    const seq = ++this.transitionSeq;
    this.manualGlideActive = true;

    try {
      const displayed = this.getDisplayed();
      const staging = this.getStaging();
      const startPov = displayed.panorama.getPov();
      const startHeading = normalizeHeading(startPov?.heading ?? 0);
      const startPitch = Number.isFinite(startPov?.pitch) ? startPov.pitch : 0;
      const endHeading =
        targetHeading !== undefined ? normalizeHeading(targetHeading) : startHeading;
      const headingDelta = calculateAngularDifference(startHeading, endHeading);

      this.prepareNextInStaging(panoId, endHeading, gear);
      const metaPromise = this.fetchMetadataByPanoId(panoId);

      const readyDeadline = performance.now() + 2000;
      while (
        !this.disposed &&
        seq === this.transitionSeq &&
        !this.isSlotPaintedFor(staging, panoId) &&
        performance.now() < readyDeadline
      ) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
      }

      if (this.disposed || seq !== this.transitionSeq) return null;

      const startTime = performance.now();
      await new Promise<void>((resolve) => {
        const tick = () => {
          if (this.disposed || seq !== this.transitionSeq) {
            resolve();
            return;
          }
          const rawT = Math.min(1, (performance.now() - startTime) / Math.max(300, durationMs));
          const easedT = smootherstep(0, 1, rawT);
          const curHeading = normalizeHeading(startHeading + headingDelta * easedT);
          const curPitch = startPitch * (1 - easedT * 0.4);

          const frame = computeGlideFrame({
            progress: easedT,
            gear,
            isBufferBReady: true,
          });

          this.syncSlotPov(displayed, curHeading, curPitch);
          this.applyCanvasScale(displayed, frame.displayedScale);
          displayed.el.style.opacity = frame.displayedOpacity.toFixed(4);

          this.syncSlotPov(staging, curHeading, curPitch);
          this.applyCanvasScale(staging, frame.stagingScale);
          staging.el.style.opacity = '1';

          if (rawT < 1) {
            requestAnimationFrame(tick);
          } else {
            resolve();
          }
        };
        requestAnimationFrame(tick);
      });

      if (this.disposed || seq !== this.transitionSeq) return null;

      this.syncSlotPov(staging, endHeading, startPitch * 0.6);
      this.applyCanvasScale(staging, CONTINUOUS_GLIDE_SPEC.scaleRatio);
      staging.el.style.opacity = '1';
      staging.el.style.zIndex = '2';
      staging.el.style.pointerEvents = 'auto';

      displayed.el.style.zIndex = '1';
      displayed.el.style.pointerEvents = 'none';
      displayed.el.style.opacity = '1';

      this.displayedId = staging.id;
      this.currentPanoId = panoId;
      this.monitor.markSwapped(staging.id, panoId, displayed.id);
      this.emitMonitor();

      const metadata = await metaPromise;
      if (!metadata || this.disposed || this.currentPanoId !== metadata.panoId) {
        return metadata;
      }

      this.callbacks.onPanoramaLoaded(metadata, false);
      return metadata;
    } finally {
      if (seq === this.transitionSeq) {
        this.manualGlideActive = false;
      }
    }
  }

  public async fetchMetadataByPanoId(panoId: string): Promise<PanoramaMetadata | null> {
    const response = await this.service.getPanorama({ pano: panoId });
    return normalizeGoogleStreetViewData(response.data);
  }

  public async fetchMetadataByLocation(
    lat: number,
    lng: number,
    radius = 60,
    preferOutdoor = true,
    preferBest = false,
  ): Promise<PanoramaMetadata | null> {
    const response = await this.service.getPanorama({
      location: { lat, lng },
      radius,
      preference: preferBest
        ? this.streetViewLib.StreetViewPreference.BEST
        : this.streetViewLib.StreetViewPreference.NEAREST,
      source: preferOutdoor
        ? this.streetViewLib.StreetViewSource.OUTDOOR
        : this.streetViewLib.StreetViewSource.DEFAULT,
    });
    return normalizeGoogleStreetViewData(response.data);
  }

  public async loadByLocation(
    lat: number,
    lng: number,
    radius = 60,
  ): Promise<{ metadata: PanoramaMetadata; snappedToRoad: boolean } | null> {
    this.transitionSeq += 1;
    this.manualGlideActive = false;

    let meta: PanoramaMetadata | null = null;
    try {
      meta = await this.fetchMetadataByLocation(lat, lng, radius, true, false);
    } catch {
      try {
        meta = await this.fetchMetadataByLocation(lat, lng, Math.max(radius, 160), true, false);
      } catch {
        meta = null;
      }
    }

    if (!meta || this.disposed) return null;
    return this.activateLoadedMetadata(meta, lat, lng, false);
  }

  public async activateLoadedMetadata(
    initialMeta: PanoramaMetadata,
    originLat: number,
    originLng: number,
    alreadySnapped = false,
  ): Promise<{ metadata: PanoramaMetadata; snappedToRoad: boolean } | null> {
    if (this.disposed) return null;
    let meta = initialMeta;
    let snappedToRoad = alreadySnapped;
    const isIndoorOrThirdParty =
      meta.panoId.startsWith('CAo') || !meta.copyright.toLowerCase().includes('google');

    if (meta.links.length === 0 || isIndoorOrThirdParty) {
      const probes = [
        ...[0, 60, 120, 180, 240, 300].map((b) => offsetCoordinates(originLat, originLng, 90, b)),
        ...[30, 150, 270].map((b) => offsetCoordinates(originLat, originLng, 180, b)),
        ...[0, 90, 180, 270].map((b) => offsetCoordinates(meta.lat, meta.lng, 260, b)),
      ];
      for (const pt of probes) {
        if (this.disposed) return null;
        try {
          const candidate = await this.fetchMetadataByLocation(pt.lat, pt.lng, 120, true, false);
          if (
            candidate &&
            candidate.links.length > 0 &&
            !candidate.panoId.startsWith('CAo')
          ) {
            meta = candidate;
            snappedToRoad = true;
            break;
          }
        } catch {
          // Continue checking nearby streets
        }
      }
    }

    if (this.disposed) return null;

    const initialHeading = normalizeHeading(meta.links[0]?.heading ?? meta.heading);
    const displayed = this.getDisplayed();
    displayed.targetPanoId = meta.panoId;
    displayed.loadedPanoId = meta.panoId;
    displayed.panoChangedAtMs = performance.now();
    displayed.firstTileSeenAtMs = 0;
    displayed.highResBatchSeenAtMs = 0;

    this.currentPanoId = meta.panoId;
    displayed.panorama.setPano(meta.panoId);
    displayed.panorama.setZoom(CONTINUOUS_GLIDE_SPEC.baseZoom);
    this.syncSlotPov(displayed, initialHeading, 0);
    this.resetVisualStateToNeutral('D');

    this.monitor.markInitialDisplay(displayed.id, meta.panoId);
    this.emitMonitor();
    this.callbacks.onPanoramaLoaded(meta, true);
    return { metadata: meta, snappedToRoad };
  }

  public async findNearbyCoveredLocation(
    lat: number,
    lng: number,
  ): Promise<PanoramaMetadata | null> {
    // 1. Prefer outdoor connected roads across progressive radii up to 50 km
    for (const radius of [200, 500, 1500, 5000, 15000, 50000]) {
      if (this.disposed) return null;
      try {
        const found = await this.fetchMetadataByLocation(lat, lng, radius, true, false);
        if (found) return found;
      } catch {
        // Keep searching wider radius
      }
    }
    // 2. Fallback to any available Street View source if outdoor-only search found nothing
    for (const radius of [500, 2500, 15000, 50000]) {
      if (this.disposed) return null;
      try {
        const found = await this.fetchMetadataByLocation(lat, lng, radius, false, false);
        if (found) return found;
      } catch {
        // Keep searching wider radius
      }
    }
    return null;
  }

  public getHeading(): number {
    const pov = this.getDisplayed().panorama.getPov();
    return normalizeHeading(pov?.heading ?? 0);
  }

  public setHeading(heading: number): void {
    if (this.disposed || this.manualGlideActive) return;
    const active = this.getDisplayed();
    const pov = active.panorama.getPov();
    const pitch = Number.isFinite(pov?.pitch) ? pov.pitch : 0;
    this.syncSlotPov(active, heading, pitch);
    this.syncSlotPov(this.getStaging(), heading, pitch);
  }

  public recenter(heading?: number): void {
    if (this.disposed) return;
    const targetHeading = heading !== undefined ? normalizeHeading(heading) : this.getHeading();
    this.syncSlotPov(this.getDisplayed(), targetHeading, 0);
    this.syncSlotPov(this.getStaging(), targetHeading, 0);
    this.resetVisualStateToNeutral('D');
  }

  public dispose(): void {
    this.disposed = true;
    for (const listener of this.listeners) {
      listener.remove();
    }
    this.listeners.length = 0;
    for (const id of ['A', 'B'] as const) {
      const el = this.buffers[id].el;
      if (el.parentNode === this.container) {
        this.container.removeChild(el);
      }
    }
  }
}
