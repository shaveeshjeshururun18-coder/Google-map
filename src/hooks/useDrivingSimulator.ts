import { useCallback, useEffect, useRef, useState } from 'react';
import { CameraController } from '../engine/CameraController';
import { DrivingController } from '../engine/DrivingController';
import { MapsJsStreetViewBridge } from '../engine/MapsJsStreetViewBridge';
import {
  isWebGLAvailable,
  PanoramaRenderer,
} from '../engine/PanoramaRenderer';
import {
  PanoramaTransitionManager,
  type PanoramaAsset,
} from '../engine/PanoramaTransitionManager';
import { VehicleOverlayRenderer } from '../engine/VehicleOverlayRenderer';
import { NavigationManager } from '../navigation/NavigationManager';
import { LocationSearchService } from '../services/LocationSearchService';
import { StreetViewApiError } from '../services/PanoramaMetadataService';
import { StreetViewService } from '../services/StreetViewService';
import type {
  DeadEndStatus,
  DrivingInputState,
  DrivingTelemetry,
  GearMode,
  NavigationHistoryEntry,
  PanoramaEdge,
  PanoramaMetadata,
  PanoramaNode,
  PlaceResult,
  PlaceSuggestion,
  QualityPreset,
  RankedNeighbour,
  SimulatorError,
  TransitionState,
  VehicleType,
} from '../types/streetview';

// Default starting coordinates (Mountain View, CA road corridor with reliable outdoor Street View)
// All road names, addresses, and metadata are loaded live from Google Street View Metadata API.
const DEFAULT_START_COORDS = {
  lat: 37.420864,
  lng: -122.084465,
};

const HAS_MAPS_JS_KEY = Boolean((import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '').trim());

export type StreetViewRenderBackend = 'tiles' | 'maps-js';

function shouldFallbackToMapsJs(err: unknown): boolean {
  if (!HAS_MAPS_JS_KEY) return false;
  if (err instanceof StreetViewApiError) {
    return (
      err.status === 401 ||
      err.status === 403 ||
      err.status === 429 ||
      err.status === 503 ||
      err.isAuthError ||
      err.isQuotaError ||
      err.code === 'ACCESS_DENIED' ||
      err.code === 'PERMISSION_DENIED' ||
      err.code === 'SESSION_ERROR' ||
      err.code === 'API_NOT_ENABLED' ||
      err.code === 'MISSING_API_KEY'
    );
  }
  return false;
}

const INITIAL_TELEMETRY: DrivingTelemetry = {
  speedKmh: 0,
  speedMs: 0,
  maxSpeedKmh: 120,
  speedRatio: 0,
  gear: 'D',
  heading: 0,
  steeringAngle: 0,
  lateralOffset: 0,
  lateralVelocity: 0,
  progressToNext: 0,
  segmentDistanceMeters: 12,
  segmentDistanceEstimated: true,
  totalDistanceMeters: 0,
  isMoving: false,
  isBraking: false,
  targetEdge: null,
};

const INITIAL_TRANSITION: TransitionState = {
  isTransitioning: false,
  fromPanoId: null,
  toPanoId: null,
  blendProgress: 0,
  tilesLoaded: 0,
  tilesTotal: 0,
  phase: 'idle',
  message: '',
};

const INITIAL_DEAD_END: DeadEndStatus = {
  isDeadEnd: false,
  isForwardBlocked: false,
  isIntersection: false,
  availableCount: 0,
};

function mapErrorToSimulatorError(err: unknown): SimulatorError {
  if (err instanceof StreetViewApiError) {
    switch (err.code) {
      case 'MISSING_API_KEY':
        return {
          code: err.code,
          title: 'Google Maps Platform API Key Required',
          message: err.message,
          recoverable: false,
          isAuthError: true,
        };
      case 'INVALID_API_KEY':
      case 'API_NOT_ENABLED':
      case 'BILLING_ERROR':
      case 'PERMISSION_DENIED':
      case 'ACCESS_DENIED':
        return {
          code: err.code,
          title: 'Google Maps API Access Issue',
          message: err.message,
          recoverable: true,
          isAuthError: true,
        };
      case 'RESOURCE_EXHAUSTED':
      case 'RATE_LIMITED':
        return {
          code: err.code,
          title: 'API Quota Reached',
          message: err.message,
          recoverable: true,
          isQuotaError: true,
        };
      case 'NO_COVERAGE':
        return {
          code: err.code,
          title: 'No Street View Coverage',
          message: err.message,
          recoverable: true,
        };
      default:
        return {
          code: err.code,
          title: 'Street View Request Failed',
          message: err.message,
          recoverable: true,
        };
    }
  }

  return {
    code: 'UNKNOWN_ERROR',
    title: 'Simulator Error',
    message: err instanceof Error ? err.message : 'An unexpected error occurred.',
    recoverable: true,
  };
}

export function useDrivingSimulator() {
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const mapsJsContainerRef = useRef<HTMLDivElement | null>(null);
  const vehicleContainerRef = useRef<HTMLDivElement | null>(null);
  const viewportMotionRef = useRef<HTMLDivElement | null>(null);

  // Persistent engine instances decoupled from React re-renders
  const streetViewServiceRef = useRef<StreetViewService | null>(null);
  const searchServiceRef = useRef<LocationSearchService | null>(null);
  const navigationRef = useRef<NavigationManager | null>(null);
  const cameraRef = useRef<CameraController | null>(null);
  const drivingRef = useRef<DrivingController | null>(null);
  const transitionRef = useRef<PanoramaTransitionManager | null>(null);
  const rendererRef = useRef<PanoramaRenderer | null>(null);
  const vehicleOverlayRef = useRef<VehicleOverlayRenderer | null>(null);
  const mapsJsBridgeRef = useRef<MapsJsStreetViewBridge | null>(null);
  const pendingMapsJsLocationRef = useRef<{ lat: number; lng: number; label?: string } | null>(null);

  if (!streetViewServiceRef.current) {
    streetViewServiceRef.current = new StreetViewService();
  }
  if (!searchServiceRef.current) {
    searchServiceRef.current = new LocationSearchService();
  }
  if (!navigationRef.current) {
    navigationRef.current = new NavigationManager();
  }
  if (!cameraRef.current) {
    cameraRef.current = new CameraController();
  }

  const [renderBackend, setRenderBackend] = useState<StreetViewRenderBackend>('tiles');
  const renderBackendRef = useRef<StreetViewRenderBackend>('tiles');
  renderBackendRef.current = renderBackend;

  const [apiConfigured, setApiConfigured] = useState<boolean | null>(null);
  const [webglSupported, setWebglSupported] = useState<boolean>(true);
  const [isInitializing, setIsInitializing] = useState<boolean>(true);
  const [currentMetadata, setCurrentMetadata] = useState<PanoramaMetadata | null>(null);
  const [telemetry, setTelemetry] = useState<DrivingTelemetry>(INITIAL_TELEMETRY);
  const [transition, setTransition] = useState<TransitionState>(INITIAL_TRANSITION);
  const [rankedNeighbours, setRankedNeighbours] = useState<RankedNeighbour[]>([]);
  const [deadEndStatus, setDeadEndStatus] = useState<DeadEndStatus>(INITIAL_DEAD_END);
  const [history, setHistory] = useState<NavigationHistoryEntry[]>([]);
  const [graphNodes, setGraphNodes] = useState<PanoramaNode[]>([]);
  const [graphEdges, setGraphEdges] = useState<PanoramaEdge[]>([]);
  const [quality, setQuality] = useState<QualityPreset>('balanced');
  const [vehicleType, setVehicleTypeState] = useState<VehicleType>('car');
  const [error, setError] = useState<SimulatorError | null>(null);
  const [coverageNotice, setCoverageNotice] = useState<string | null>(null);
  const [quotaExceeded, setQuotaExceeded] = useState<boolean>(false);

  const applyMotionEffects = useCallback((nextTelemetry: DrivingTelemetry) => {
    vehicleOverlayRef.current?.updateTelemetry(nextTelemetry);

    const motionEl = viewportMotionRef.current;
    if (!motionEl) return;

    const absLat = Math.abs(nextTelemetry.lateralOffset);
    if (nextTelemetry.speedRatio > 0.008 || absLat > 0.004) {
      const forwardBoost =
        nextTelemetry.gear === 'R'
          ? 0
          : nextTelemetry.progressToNext * nextTelemetry.speedRatio * 0.055 +
            nextTelemetry.speedRatio * 0.022;
      const scale = 1 + absLat * 0.024 + forwardBoost;
      const shiftPx = -nextTelemetry.lateralOffset * 18;
      motionEl.style.transform = `translate3d(${shiftPx.toFixed(1)}px, 0, 0) scale(${scale.toFixed(4)})`;
    } else if (motionEl.style.transform) {
      motionEl.style.transform = '';
    }
  }, []);

  const qualityRef = useRef<QualityPreset>(quality);
  qualityRef.current = quality;

  const currentMetadataRef = useRef<PanoramaMetadata | null>(currentMetadata);
  currentMetadataRef.current = currentMetadata;

  const lastHudSyncMsRef = useRef<number>(0);
  const lastMarkerKeyRef = useRef<string>('');

  const syncGraphAndNeighbours = useCallback((metadata: PanoramaMetadata, heading: number) => {
    const nav = navigationRef.current!;
    const ranked = nav.getRankedNeighbours(metadata.panoId, heading);
    const deadEnd = nav.detectDeadEnds(metadata.panoId, heading);
    const edges = nav.graph.getEdges(metadata.panoId);

    setRankedNeighbours(ranked);
    setDeadEndStatus(deadEnd);
    setHistory(nav.getHistory());
    setGraphNodes(nav.graph.getAllNodes());
    setGraphEdges(nav.graph.getAllEdges());

    const activeTargetId = drivingRef.current?.getTelemetry().targetEdge?.destinationPanoId ?? null;
    rendererRef.current?.setRoadMarkers(edges, activeTargetId);
    lastMarkerKeyRef.current = `${metadata.panoId}:${activeTargetId || ''}`;
  }, []);

  const handleMetadataLoaded = useCallback(
    (metadata: PanoramaMetadata, alignHeadingToRoad: boolean) => {
      const nav = navigationRef.current!;
      const cam = cameraRef.current!;
      const drv = drivingRef.current!;

      nav.discoverNeighbours(metadata);

      let nextHeading =
        renderBackendRef.current === 'maps-js' && mapsJsBridgeRef.current
          ? mapsJsBridgeRef.current.getHeading()
          : cam.getHeading();
      if (alignHeadingToRoad) {
        const preferredLink = metadata.links[0];
        nextHeading = preferredLink ? preferredLink.heading : metadata.heading;
        cam.setHeadingImmediate(nextHeading);
        cam.setPitchImmediate(0);
      }

      drv.setCurrentPanorama(metadata.panoId, nextHeading);
      nav.maintainNavigationHistory(metadata, nextHeading);

      setCurrentMetadata(metadata);
      setError(null);
      setIsInitializing(false);
      setTransition(INITIAL_TRANSITION);
      syncGraphAndNeighbours(metadata, nextHeading);

      // Update telemetry immediately after entering node
      setTelemetry(drv.getTelemetry());
    },
    [syncGraphAndNeighbours],
  );

  const handleAssetLoaded = useCallback(
    (asset: PanoramaAsset, alignHeadingToRoad: boolean) => {
      handleMetadataLoaded(asset.metadata, alignHeadingToRoad);
    },
    [handleMetadataLoaded],
  );

  const loadLocationViaMapsJs = useCallback(
    async (lat: number, lng: number, label?: string) => {
      const bridge = mapsJsBridgeRef.current;
      const drv = drivingRef.current;
      if (!bridge || !drv) {
        pendingMapsJsLocationRef.current = { lat, lng, label };
        return;
      }

      drv.emergencyStop();
      setError(null);
      setCoverageNotice(null);
      setTransition({
        isTransitioning: true,
        fromPanoId: currentMetadataRef.current?.panoId ?? null,
        toPanoId: null,
        blendProgress: 0,
        tilesLoaded: 0,
        tilesTotal: 1,
        phase: 'fetching-metadata',
        message: 'Loading real Google Street View panorama...',
      });

      try {
        const result = await bridge.loadByLocation(lat, lng, 60);
        if (!result) {
          throw new StreetViewApiError(
            404,
            'NO_COVERAGE',
            'No Google Street View panorama is available at this location.',
          );
        }
        if (result.snappedToRoad) {
          setCoverageNotice(
            `Snapped from plaza photosphere to nearest drivable street (${result.metadata.streetName}).`,
          );
        }
      } catch (err) {
        setTransition(INITIAL_TRANSITION);
        try {
          const nearby = await bridge.findNearbyCoveredLocation(lat, lng);
          if (nearby) {
            setError({
              code: 'NO_COVERAGE',
              title: `No Street View at ${label || 'this location'}`,
              message: `Google Street View does not have imagery at these exact coordinates. Nearest verified road coverage is on ${nearby.streetName}.`,
              recoverable: true,
              suggestedLocation: {
                lat: nearby.lat,
                lng: nearby.lng,
                label: nearby.formattedLocation,
              },
            });
            setIsInitializing(false);
            return;
          }
        } catch {
          // Fall through to standard error
        }

        const mapped = mapErrorToSimulatorError(err);
        if (mapped.isQuotaError) setQuotaExceeded(true);
        setError(mapped);
        setIsInitializing(false);
      }
    },
    [],
  );

  const activateMapsJsFallback = useCallback((lat: number, lng: number, label?: string) => {
    pendingMapsJsLocationRef.current = { lat, lng, label };
    renderBackendRef.current = 'maps-js';
    setRenderBackend('maps-js');
    setError(null);
    setApiConfigured(true);
    setIsInitializing(true);
    rendererRef.current?.stop();
  }, []);

  const attachMapsJsBridge = useCallback(
    (bridge: MapsJsStreetViewBridge | null) => {
      mapsJsBridgeRef.current = bridge;
      if (bridge && pendingMapsJsLocationRef.current) {
        const pending = pendingMapsJsLocationRef.current;
        pendingMapsJsLocationRef.current = null;
        void loadLocationViaMapsJs(pending.lat, pending.lng, pending.label);
      }
    },
    [loadLocationViaMapsJs],
  );

  const handleMapsJsPovChanged = useCallback((heading: number, pitch: number) => {
    const cam = cameraRef.current;
    const drv = drivingRef.current;
    if (cam) {
      cam.setHeadingImmediate(heading);
      cam.setPitchImmediate(pitch);
    }
    if (drv && !drv.getInputState().steerLeft && !drv.getInputState().steerRight) {
      drv.syncHeadingFromCamera(heading);
    }
  }, []);

  const handleMapsJsUserNavigated = useCallback(
    (metadata: PanoramaMetadata) => {
      handleMetadataLoaded(metadata, false);
    },
    [handleMetadataLoaded],
  );

  const driveToEdge = useCallback(
    async (edge: PanoramaEdge, preserveCameraHeading = true) => {
      const drv = drivingRef.current;
      const cam = cameraRef.current;
      if (!drv || !cam) return;

      if (renderBackendRef.current === 'maps-js') {
        const bridge = mapsJsBridgeRef.current;
        if (!bridge) return;
        setCoverageNotice(null);
        drv.setTransitionLocked(true);
        try {
          const targetHeading = preserveCameraHeading ? undefined : edge.heading;
          const loaded = await bridge.loadByPanoId(edge.destinationPanoId, targetHeading);
          if (!loaded) {
            drv.setTransitionLocked(false);
          }
        } catch (err) {
          drv.setTransitionLocked(false);
          drv.emergencyStop();
          const mapped = mapErrorToSimulatorError(err);
          setCoverageNotice(mapped.message);
        }
        return;
      }

      const tm = transitionRef.current;
      if (!tm) return;

      if (!preserveCameraHeading) {
        cam.setTargetHeading(edge.heading);
        drv.syncHeadingFromCamera(edge.heading);
      }

      setCoverageNotice(null);
      drv.setTransitionLocked(true);

      try {
        const asset = await tm.transitionToPanoId(edge.destinationPanoId, qualityRef.current);
        if (asset) {
          handleAssetLoaded(asset, false);
        } else {
          drv.setTransitionLocked(false);
        }
      } catch (err) {
        drv.setTransitionLocked(false);
        drv.emergencyStop();
        const mapped = mapErrorToSimulatorError(err);
        if (mapped.isQuotaError) setQuotaExceeded(true);
        setCoverageNotice(mapped.message);
      }
    },
    [handleAssetLoaded],
  );

  const loadLocation = useCallback(
    async (lat: number, lng: number, label?: string) => {
      if (renderBackendRef.current === 'maps-js') {
        await loadLocationViaMapsJs(lat, lng, label);
        return;
      }

      const tm = transitionRef.current;
      const drv = drivingRef.current;
      const sv = streetViewServiceRef.current;
      if (!tm || !drv || !sv) return;

      drv.emergencyStop();
      setError(null);
      setCoverageNotice(null);

      try {
        await sv.ensureSession();
        setApiConfigured(true);
        let asset = await tm.transitionToLocation(lat, lng, qualityRef.current, 60);
        if (asset && asset.metadata.links.length === 0) {
          const drivable = await sv.metadataService.findNearbyDrivableLocation(
            lat,
            lng,
            asset.metadata.panoId,
          );
          if (drivable) {
            const connectedAsset = await tm.transitionToPanoId(
              drivable.panoId,
              qualityRef.current,
            );
            if (connectedAsset) {
              asset = connectedAsset;
              setCoverageNotice(
                `Snapped from plaza photosphere to nearest drivable street (${drivable.streetName}).`,
              );
            }
          }
        }
        if (asset) {
          handleAssetLoaded(asset, true);
        }
      } catch (err) {
        if (shouldFallbackToMapsJs(err)) {
          activateMapsJsFallback(lat, lng, label);
          return;
        }

        const mapped = mapErrorToSimulatorError(err);
        if (mapped.isQuotaError) {
          setQuotaExceeded(true);
        }

        // If no coverage at exact spot, try to find a real nearby covered street to suggest
        if (mapped.code === 'NO_COVERAGE') {
          try {
            const nearby = await sv.metadataService.findNearbyCoveredLocation(lat, lng);
            if (nearby) {
              setError({
                ...mapped,
                title: `No Street View at ${label || 'this location'}`,
                message: `Google Street View does not have imagery at these exact coordinates. Nearest verified road coverage is on ${nearby.streetName}.`,
                suggestedLocation: {
                  lat: nearby.lat,
                  lng: nearby.lng,
                  label: nearby.formattedLocation,
                },
              });
              setIsInitializing(false);
              return;
            }
          } catch {
            // Fall through to standard error below
          }
        }

        setError(mapped);
        setIsInitializing(false);
      }
    },
    [activateMapsJsFallback, handleAssetLoaded, loadLocationViaMapsJs],
  );

  // Store latest callbacks in refs so the Three.js lifecycle never re-mounts on HUD updates
  const driveToEdgeRef = useRef(driveToEdge);
  driveToEdgeRef.current = driveToEdge;

  const loadLocationRef = useRef(loadLocation);
  loadLocationRef.current = loadLocation;

  const syncGraphRef = useRef(syncGraphAndNeighbours);
  syncGraphRef.current = syncGraphAndNeighbours;

  // Listen for global Google Maps Platform quota events (Section 8 Case A)
  useEffect(() => {
    const handleQuota = () => setQuotaExceeded(true);
    window.addEventListener('gmp-quota-exceeded', handleQuota);
    return () => window.removeEventListener('gmp-quota-exceeded', handleQuota);
  }, []);

  // Mount transparent Three.js 3D Car / 3D Bike overlay cleanly above Street View
  useEffect(() => {
    const container = vehicleContainerRef.current;
    if (!container || !isWebGLAvailable()) return;

    let overlay: VehicleOverlayRenderer;
    try {
      overlay = new VehicleOverlayRenderer(container, 'car');
      vehicleOverlayRef.current = overlay;
      overlay.start();
    } catch {
      return;
    }

    return () => {
      overlay.dispose();
      vehicleOverlayRef.current = null;
    };
  }, []);

  // Initialize Three.js renderer, simulation loop, and initial real Street View session ONCE
  useEffect(() => {
    const container = canvasContainerRef.current;
    if (!container) return;

    if (!isWebGLAvailable()) {
      setWebglSupported(false);
      setIsInitializing(false);
      setError({
        code: 'WEBGL_UNAVAILABLE',
        title: 'WebGL Is Unavailable',
        message:
          'Your browser or device does not support WebGL, which is required for 360-degree spherical Street View rendering.',
        recoverable: false,
      });
      return;
    }

    const sv = streetViewServiceRef.current!;
    const nav = navigationRef.current!;
    const cam = cameraRef.current!;

    const driving = new DrivingController(nav, {
      onHeadingSteer: (newHeading) => {
        if (renderBackendRef.current === 'maps-js') {
          mapsJsBridgeRef.current?.setHeading(newHeading);
        }
        cam.setTargetHeading(newHeading);
      },
      onPreloadEdge: (edge) => {
        if (renderBackendRef.current === 'maps-js') {
          void mapsJsBridgeRef.current?.fetchMetadataByPanoId(edge.destinationPanoId);
          return;
        }
        void transitionRef.current?.preloadByPanoId(
          edge.destinationPanoId,
          qualityRef.current,
        );
      },
      onAdvanceToEdge: (edge) => {
        void driveToEdgeRef.current(edge, true);
      },
      onDeadEndReached: (gear) => {
        setCoverageNotice(
          gear === 'R'
            ? 'No connected Street View panorama behind your current heading.'
            : 'No connected Street View road directly ahead. Steer left or right, or select an available direction.',
        );
      },
    });
    drivingRef.current = driving;

    let renderer: PanoramaRenderer;
    try {
      renderer = new PanoramaRenderer(container, cam, {
        onRoadMarkerClick: (edge) => {
          void driveToEdgeRef.current(edge, false);
        },
        onContextLost: () => {
          setCoverageNotice('Graphics context interrupted. Attempting to restore 360° view...');
        },
        onContextRestored: () => {
          setCoverageNotice(null);
        },
        onFrame: (dt) => {
          // Keep driving heading synced when user looks around with mouse/touch
          const input = driving.getInputState();
          if (!input.steerLeft && !input.steerRight) {
            driving.syncHeadingFromCamera(cam.getHeading());
          }

          const nextTelemetry = driving.step(dt);
          cam.setSpeedFovKick(nextTelemetry.speedRatio);
          applyMotionEffects(nextTelemetry);

          // Update 3D road marker highlight whenever active target edge changes
          const activeMeta = currentMetadataRef.current;
          if (activeMeta) {
            const targetId = nextTelemetry.targetEdge?.destinationPanoId || '';
            const markerKey = `${activeMeta.panoId}:${targetId}`;
            if (markerKey !== lastMarkerKeyRef.current) {
              lastMarkerKeyRef.current = markerKey;
              renderer.setRoadMarkers(nav.graph.getEdges(activeMeta.panoId), targetId || null);
            }
          }

          // Throttle React HUD updates to <= 10Hz to keep WebGL loop smooth
          const now = performance.now();
          if (now - lastHudSyncMsRef.current >= 100) {
            lastHudSyncMsRef.current = now;
            setTelemetry(nextTelemetry);
            if (activeMeta) {
              setRankedNeighbours(nav.getRankedNeighbours(activeMeta.panoId, nextTelemetry.heading));
              setDeadEndStatus(nav.detectDeadEnds(activeMeta.panoId, nextTelemetry.heading));
            }
          }
        },
      });
    } catch (err) {
      setWebglSupported(false);
      setIsInitializing(false);
      setError(mapErrorToSimulatorError(err));
      return;
    }

    rendererRef.current = renderer;

    const transitionManager = new PanoramaTransitionManager(
      {
        fetchMetadataByPanoId: (panoId, signal) =>
          sv.metadataService.getMetadataByPanoId(panoId, signal),
        fetchMetadataByLocation: (lat, lng, radius, signal) =>
          sv.metadataService.getMetadataByLocation(lat, lng, radius, signal),
        loadPanoramaCanvas: async (metadata, q, signal, onProgress) => {
          const isConstrained =
            renderer.isSoftwareGl ||
            (typeof navigator !== 'undefined' && /Android|iPhone|iPad/i.test(navigator.userAgent));
          const result = await sv.loadPanoramaCanvas(metadata, {
            quality: q,
            maxTextureWidth: renderer.getMaxTextureSize(),
            isConstrainedDevice: isConstrained,
            signal,
            onProgress: (p) => onProgress(p.loaded, p.total, p.canvas),
          });
          return { canvas: result.canvas, zoom: result.grid.zoom };
        },
      },
      {
        onStateChange: (nextState) => setTransition(nextState),
        onProgressiveUpdate: (metadata, canvas) => {
          renderer.setPrimaryPanorama(metadata, canvas);
        },
        onBlendFrame: (_outgoing, incoming, blendProgress) => {
          renderer.setTransitionBlend(incoming.metadata, incoming.canvas, blendProgress);
        },
        onComplete: (asset) => {
          renderer.setPrimaryPanorama(asset.metadata, asset.canvas);
        },
      },
    );
    transitionRef.current = transitionManager;
    renderer.start();

    // Bootstrap server config check and load initial real Google Street View panorama
    let cancelled = false;
    (async () => {
      const cfg = await sv.checkServerConfig();
      if (cancelled) return;
      setApiConfigured(cfg.apiConfigured || HAS_MAPS_JS_KEY);
      if (!cfg.apiConfigured) {
        if (HAS_MAPS_JS_KEY) {
          activateMapsJsFallback(DEFAULT_START_COORDS.lat, DEFAULT_START_COORDS.lng);
          return;
        }
        setIsInitializing(false);
        setError({
          code: 'MISSING_API_KEY',
          title: 'Google Maps Platform API Key Not Configured',
          message:
            'Set GOOGLE_MAPS_API_KEY in your environment secrets with Map Tiles API and Places API (New) enabled to load real Google Street View panoramas.',
          recoverable: false,
          isAuthError: true,
        });
        return;
      }

      await loadLocationRef.current(DEFAULT_START_COORDS.lat, DEFAULT_START_COORDS.lng);
    })();

    return () => {
      cancelled = true;
      transitionManager.dispose();
      renderer.dispose();
      rendererRef.current = null;
      transitionRef.current = null;
      drivingRef.current = null;
    };
  }, [activateMapsJsFallback]);

  // Dedicated driving simulation rAF loop when operating in official Maps JS Street View mode
  useEffect(() => {
    if (renderBackend !== 'maps-js') return;

    let rafId = 0;
    let lastTime = performance.now();

    const tick = (now: number) => {
      const dt = Math.min(0.1, Math.max(0.001, (now - lastTime) / 1000));
      lastTime = now;

      const drv = drivingRef.current;
      const nav = navigationRef.current;
      const bridge = mapsJsBridgeRef.current;
      if (drv && nav) {
        const input = drv.getInputState();
        if (bridge && !input.steerLeft && !input.steerRight) {
          drv.syncHeadingFromCamera(bridge.getHeading());
        }

        const nextTelemetry = drv.step(dt);
        applyMotionEffects(nextTelemetry);
        const activeMeta = currentMetadataRef.current;

        if (now - lastHudSyncMsRef.current >= 85) {
          lastHudSyncMsRef.current = now;
          setTelemetry(nextTelemetry);
          if (activeMeta) {
            setRankedNeighbours(nav.getRankedNeighbours(activeMeta.panoId, nextTelemetry.heading));
            setDeadEndStatus(nav.detectDeadEnds(activeMeta.panoId, nextTelemetry.heading));
          }
        }
      }

      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [applyMotionEffects, renderBackend]);

  // Global keyboard driving controls (W/A/S/D, Arrow keys, Space, R)
  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      const drv = drivingRef.current;
      if (!drv) return;

      switch (event.code) {
        case 'KeyW':
        case 'ArrowUp':
          event.preventDefault();
          drv.setInput('accelerate', true);
          break;
        case 'KeyS':
        case 'ArrowDown':
          event.preventDefault();
          drv.setInput('brake', true);
          break;
        case 'KeyA':
        case 'ArrowLeft':
          event.preventDefault();
          drv.setInput('steerLeft', true);
          break;
        case 'KeyD':
        case 'ArrowRight':
          event.preventDefault();
          drv.setInput('steerRight', true);
          break;
        case 'Space':
          event.preventDefault();
          drv.setInput('handbrake', true);
          break;
        case 'KeyQ':
          if (!event.repeat) {
            event.preventDefault();
            drv.nudgeLateral(-1);
          }
          break;
        case 'KeyE':
          if (!event.repeat) {
            event.preventDefault();
            drv.nudgeLateral(1);
          }
          break;
        case 'KeyV':
          if (!event.repeat) {
            event.preventDefault();
            setVehicleTypeState((prev) => {
              const next: VehicleType = prev === 'car' ? 'bike' : 'car';
              vehicleOverlayRef.current?.setVehicleType(next);
              return next;
            });
          }
          break;
        case 'KeyR':
          if (!event.repeat) {
            event.preventDefault();
            drv.toggleReverseGear();
            setTelemetry(drv.getTelemetry());
          }
          break;
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      const drv = drivingRef.current;
      if (!drv) return;

      switch (event.code) {
        case 'KeyW':
        case 'ArrowUp':
          drv.setInput('accelerate', false);
          break;
        case 'KeyS':
        case 'ArrowDown':
          drv.setInput('brake', false);
          break;
        case 'KeyA':
        case 'ArrowLeft':
          drv.setInput('steerLeft', false);
          break;
        case 'KeyD':
        case 'ArrowRight':
          drv.setInput('steerRight', false);
          break;
        case 'Space':
          drv.setInput('handbrake', false);
          break;
      }
    };

    const onWindowBlur = () => {
      drivingRef.current?.resetInputs();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, []);

  const setDrivingInput = useCallback(
    <K extends keyof DrivingInputState>(key: K, active: boolean) => {
      drivingRef.current?.setInput(key, active);
    },
    [],
  );

  const shiftLane = useCallback((direction: -1 | 1) => {
    drivingRef.current?.nudgeLateral(direction);
  }, []);

  const setVehicleType = useCallback((next: VehicleType) => {
    setVehicleTypeState(next);
    vehicleOverlayRef.current?.setVehicleType(next);
  }, []);

  const setGear = useCallback((gear: GearMode) => {
    drivingRef.current?.setGear(gear);
    if (drivingRef.current) {
      setTelemetry(drivingRef.current.getTelemetry());
    }
  }, []);

  const toggleReverse = useCallback(() => {
    drivingRef.current?.toggleReverseGear();
    if (drivingRef.current) {
      setTelemetry(drivingRef.current.getTelemetry());
    }
  }, []);

  const stepDirection = useCallback(
    (direction: 'forward' | 'left' | 'right' | 'reverse') => {
      const meta = currentMetadataRef.current;
      const nav = navigationRef.current;
      const cam = cameraRef.current;
      if (!meta || !nav || !cam) return;

      const heading = cam.getHeading();
      let match: RankedNeighbour | null = null;
      if (direction === 'forward') {
        match = nav.findForwardNeighbour(meta.panoId, heading, 75);
      } else if (direction === 'left') {
        match = nav.findLeftNeighbour(meta.panoId, heading);
      } else if (direction === 'right') {
        match = nav.findRightNeighbour(meta.panoId, heading);
      } else {
        match = nav.findReverseNeighbour(meta.panoId, heading);
      }

      if (!match) {
        setCoverageNotice(
          `No official Street View road connection available to the ${direction}.`,
        );
        return;
      }

      const preserveHeading = direction === 'reverse';
      void driveToEdge(match.edge, preserveHeading);
    },
    [driveToEdge],
  );

  const selectConnectedEdge = useCallback(
    (edge: PanoramaEdge) => {
      void driveToEdge(edge, false);
    },
    [driveToEdge],
  );

  const togglePointerLock = useCallback(() => {
    cameraRef.current?.togglePointerLock();
  }, []);

  const recenterHorizon = useCallback(() => {
    const meta = currentMetadataRef.current;
    const preferredHeading = meta?.links[0]?.heading;
    if (renderBackendRef.current === 'maps-js') {
      mapsJsBridgeRef.current?.recenter(preferredHeading);
      return;
    }
    const cam = cameraRef.current;
    if (!cam) return;
    cam.setTargetPitch(0);
    cam.setFov(75);
    if (preferredHeading !== undefined) {
      cam.setTargetHeading(preferredHeading);
    }
  }, []);

  const searchAutocomplete = useCallback(
    async (query: string, signal?: AbortSignal): Promise<PlaceSuggestion[]> => {
      const bias = currentMetadataRef.current
        ? { lat: currentMetadataRef.current.lat, lng: currentMetadataRef.current.lng }
        : undefined;
      return searchServiceRef.current!.autocomplete(query, bias, signal);
    },
    [],
  );

  const searchPlacesText = useCallback(
    async (query: string, signal?: AbortSignal): Promise<PlaceResult[]> => {
      const bias = currentMetadataRef.current
        ? { lat: currentMetadataRef.current.lat, lng: currentMetadataRef.current.lng }
        : undefined;
      return searchServiceRef.current!.searchByText(query, bias, signal);
    },
    [],
  );

  const selectPlaceSuggestion = useCallback(
    async (suggestion: PlaceSuggestion): Promise<void> => {
      try {
        const place = await searchServiceRef.current!.getPlaceDetails(suggestion.placeId);
        await loadLocation(place.lat, place.lng, place.name);
      } catch (err) {
        const mapped = mapErrorToSimulatorError(err);
        if (mapped.isQuotaError) setQuotaExceeded(true);
        setError(mapped);
      }
    },
    [loadLocation],
  );

  const selectPlaceResult = useCallback(
    async (place: PlaceResult): Promise<void> => {
      await loadLocation(place.lat, place.lng, place.name);
    },
    [loadLocation],
  );

  const locateCurrentDevice = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setCoverageNotice('Browser geolocation is unavailable on this device.');
      return;
    }
    setCoverageNotice('Requesting device GPS coordinates...');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoverageNotice(null);
        void loadLocation(pos.coords.latitude, pos.coords.longitude, 'Your Location');
      },
      () => {
        setCoverageNotice('Location permission denied or unavailable.');
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }, [loadLocation]);

  const changeQuality = useCallback(
    (nextQuality: QualityPreset) => {
      setQuality(nextQuality);
      qualityRef.current = nextQuality;
      const meta = currentMetadataRef.current;
      if (meta && transitionRef.current) {
        void transitionRef.current.transitionToPanoId(meta.panoId, nextQuality);
      }
    },
    [],
  );

  const retryConnection = useCallback(() => {
    setError(null);
    setCoverageNotice(null);
    setIsInitializing(true);
    const meta = currentMetadataRef.current;
    if (meta) {
      void loadLocation(meta.lat, meta.lng, meta.streetName);
    } else {
      void loadLocation(DEFAULT_START_COORDS.lat, DEFAULT_START_COORDS.lng);
    }
  }, [loadLocation]);

  const dismissError = useCallback(() => setError(null), []);
  const dismissNotice = useCallback(() => setCoverageNotice(null), []);

  return {
    canvasContainerRef,
    mapsJsContainerRef,
    vehicleContainerRef,
    viewportMotionRef,
    renderBackend,
    vehicleType,
    attachMapsJsBridge,
    handleMetadataLoaded,
    handleMapsJsPovChanged,
    handleMapsJsUserNavigated,
    apiConfigured,
    webglSupported,
    isInitializing,
    currentMetadata,
    telemetry,
    transition,
    rankedNeighbours,
    deadEndStatus,
    history,
    graphNodes,
    graphEdges,
    quality,
    error,
    coverageNotice,
    quotaExceeded,
    setDrivingInput,
    shiftLane,
    setVehicleType,
    setGear,
    toggleReverse,
    stepDirection,
    selectConnectedEdge,
    loadLocation,
    searchAutocomplete,
    searchPlacesText,
    selectPlaceSuggestion,
    selectPlaceResult,
    locateCurrentDevice,
    togglePointerLock,
    recenterHorizon,
    changeQuality,
    retryConnection,
    dismissError,
    dismissNotice,
  };
}
