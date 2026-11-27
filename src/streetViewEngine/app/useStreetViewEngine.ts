import { useCallback, useEffect, useRef, useState } from 'react';
import { CameraController } from '../../engine/CameraController';
import { DeviceLocationService } from '../../services/DeviceLocationService';
import { LocationSearchService } from '../../services/LocationSearchService';
import { StreetViewApiError } from '../../services/PanoramaMetadataService';
import { CarController } from '../driving/CarController';
import { attachKeyboardControls } from '../driving/KeyboardControls';
import {
  calculateAngularDifference,
  normalizeHeading,
} from '../navigation/DirectionCalculator';
import { RouteController, type NavigationAction } from '../navigation/RouteController';
import { LoadingMonitor } from '../performance/LoadingMonitor';
import { RequestScheduler } from '../performance/RequestScheduler';
import { GoogleStreetViewProvider } from '../providers/GoogleStreetViewProvider';
import { MapsJsDoubleBufferRenderer } from '../rendering/MapsJsDoubleBufferRenderer';
import { InstantPanoramaRenderer } from '../rendering/PanoramaRenderer';
import type {
  BufferMonitorSnapshot,
  CarInputState,
  CarTelemetry,
  GearMode,
  GlidePacePreset,
  JunctionSummary,
  NavigationHistoryEntry,
  PanoramaMetadata,
  PlaceResult,
  PlaceSuggestion,
  QualityPreset,
  SimulatorError,
  ValidatedLink,
} from '../types';

export type RenderBackend = 'tiles' | 'maps-js';

/** Real outdoor Google Street View road corridor (Mountain View, CA). */
export const DEFAULT_START_COORDS = {
  lat: 37.420864,
  lng: -122.084465,
  label: 'Mountain View, CA',
};

const EMPTY_JUNCTION: JunctionSummary = {
  kind: 'dead-end',
  label: 'No Connected Road',
  isDeadEnd: true,
  isForwardBlocked: true,
  availableCount: 0,
  forward: null,
  left: null,
  right: null,
  reverse: null,
  allChoices: [],
};

const INITIAL_TELEMETRY: CarTelemetry = {
  speedKmh: 0,
  speedMs: 0,
  maxSpeedKmh: 14,
  speedRatio: 0,
  pace: 'slow',
  gear: 'D',
  heading: 0,
  steeringAngle: 0,
  progressToNext: 0,
  segmentDistanceMeters: 10,
  segmentDistanceEstimated: true,
  totalDistanceMeters: 0,
  isMoving: false,
  isAccelerating: false,
  isBraking: false,
  cruiseEnabled: false,
  targetLink: null,
};

const INITIAL_BUFFER_MONITOR: BufferMonitorSnapshot = {
  displayedBuffer: 'A',
  displayedPanoId: null,
  stagingBuffer: 'B',
  stagingPanoId: null,
  stagingStatus: 'empty',
  swapCount: 0,
  lastPrepareMs: 0,
  transitionDurationMs: 0,
};

const MAPS_JS_API_KEY = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '').trim();

function mapErrorToSimulatorError(
  err: unknown,
  fallbackTitle = 'Street View Request Failed',
): SimulatorError {
  if (err instanceof StreetViewApiError) {
    if (err.code === 'MISSING_API_KEY') {
      return {
        code: err.code,
        title: 'Google Maps API Key Required',
        message: 'GOOGLE_MAPS_API_KEY is not configured on the server.',
        recoverable: false,
      };
    }
    if (err.code === 'NO_COVERAGE') {
      return {
        code: err.code,
        title: 'No Street View Coverage',
        message: err.message,
        recoverable: true,
      };
    }
    if (err.isQuotaError || err.status === 429) {
      return {
        code: 'QUOTA_EXCEEDED',
        title: 'API Quota Reached',
        message:
          'Google Maps Platform quota or rate limit has been reached. Wait briefly or check billing quotas.',
        recoverable: true,
        isQuotaError: true,
      };
    }
    if (err.isAuthError || err.status === 401 || err.status === 403) {
      return {
        code: 'AUTH_ERROR',
        title: 'Street View Authorization Error',
        message:
          'The Google Maps API key was rejected for Street View Tiles API. Verify Map Tiles API is enabled and billing is active.',
        recoverable: true,
        isAuthError: true,
      };
    }
    return {
      code: err.code,
      title: fallbackTitle,
      message: err.message,
      recoverable: true,
    };
  }

  return {
    code: 'UNEXPECTED_ERROR',
    title: fallbackTitle,
    message:
      err instanceof Error
        ? err.message
        : 'An unexpected error occurred while communicating with Street View.',
    recoverable: true,
  };
}

export function useStreetViewEngine() {
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const mapsJsContainerRef = useRef<HTMLDivElement | null>(null);

  const providerRef = useRef<GoogleStreetViewProvider | null>(null);
  const searchServiceRef = useRef<LocationSearchService | null>(null);
  const deviceLocationServiceRef = useRef<DeviceLocationService>(new DeviceLocationService());
  const routeRef = useRef<RouteController | null>(null);
  const cameraRef = useRef<CameraController | null>(null);
  const tilesRendererRef = useRef<InstantPanoramaRenderer | null>(null);
  const mapsJsRendererRef = useRef<MapsJsDoubleBufferRenderer | null>(null);
  const carRef = useRef<CarController | null>(null);
  const schedulerRef = useRef<RequestScheduler | null>(null);
  const tilesMonitorRef = useRef<LoadingMonitor>(new LoadingMonitor());

  const renderBackendRef = useRef<RenderBackend>('tiles');
  const qualityRef = useRef<QualityPreset>('high');
  const pendingCoordsRef = useRef<{ lat: number; lng: number; label?: string } | null>(null);
  const navSeqRef = useRef(0);
  const lastUiSyncMsRef = useRef(0);
  const lastHeadingSyncedToMapRef = useRef(-999);
  const mountedRef = useRef(true);

  const [renderBackend, setRenderBackend] = useState<RenderBackend>('tiles');
  const [currentMetadata, setCurrentMetadata] = useState<PanoramaMetadata | null>(null);
  const [telemetry, setTelemetry] = useState<CarTelemetry>(INITIAL_TELEMETRY);
  const [junction, setJunction] = useState<JunctionSummary>(EMPTY_JUNCTION);
  const [bufferMonitor, setBufferMonitor] =
    useState<BufferMonitorSnapshot>(INITIAL_BUFFER_MONITOR);
  const [history, setHistory] = useState<NavigationHistoryEntry[]>([]);
  const [knownMetadata, setKnownMetadata] = useState<PanoramaMetadata[]>([]);
  const [allLinks, setAllLinks] = useState<ValidatedLink[]>([]);
  const [quality, setQuality] = useState<QualityPreset>('high');
  const [isInitializing, setIsInitializing] = useState(true);
  const [isLocating, setIsLocating] = useState(false);
  const [error, setError] = useState<SimulatorError | null>(null);
  const [coverageNotice, setCoverageNotice] = useState<string | null>(null);
  const [quotaExceeded, setQuotaExceeded] = useState(false);

  const syncRouteUiState = useCallback((headingDeg: number) => {
    const route = routeRef.current;
    if (!route) return;
    setCurrentMetadata(route.getActiveMetadata());
    setJunction(route.getJunction(headingDeg));
    setHistory(route.getHistory());
    setKnownMetadata(route.getKnownMetadataList());
    setAllLinks(route.getAllLinks());
  }, []);

  /**
   * Layer 3 (Single-Next Photograph Preparation in Buffer B):
   * Policy-compliant preparation of ONLY the immediate next road viewpoint in standby Buffer B.
   */
  const prepareSingleNextInBufferB = useCallback((link: ValidatedLink, gear: GearMode = 'D') => {
    const backend = renderBackendRef.current;

    if (backend === 'maps-js') {
      const mapsRenderer = mapsJsRendererRef.current;
      if (!mapsRenderer) return;
      mapsRenderer.prepareNextInStaging(link.destinationPanoId, link.heading, gear);
      return;
    }

    const provider = providerRef.current;
    const renderer = tilesRendererRef.current;
    const scheduler = schedulerRef.current;
    const route = routeRef.current;
    if (!provider || !renderer || !scheduler || !route) return;
    if (!scheduler.canPrepareNext()) return;
    if (renderer.isBufferBReadyFor(link.destinationPanoId)) return;

    const taskKey = `prepare:${link.destinationPanoId}:${qualityRef.current}`;
    scheduler.cancelAllExcept(taskKey);

    tilesMonitorRef.current.markPreparing(
      tilesMonitorRef.current.getSnapshot().stagingBuffer,
      link.destinationPanoId,
    );
    setBufferMonitor(tilesMonitorRef.current.getSnapshot());

    void scheduler
      .schedule(taskKey, async (signal) => {
        const meta = await provider.fetchMetadataById(link.destinationPanoId, signal);
        route.registerMetadata(meta);
        const frame = await provider.decodePanoramaFrame(
          meta,
          qualityRef.current,
          renderer.getMaxTextureSize(),
          signal,
        );
        if (!signal.aborted && mountedRef.current) {
          renderer.stagePanoramaInBufferB(meta, frame.canvas);
          tilesMonitorRef.current.markReady(
            tilesMonitorRef.current.getSnapshot().stagingBuffer,
            meta.panoId,
          );
          setBufferMonitor(tilesMonitorRef.current.getSnapshot());
        }
      })
      .catch(() => {
        // Non-fatal: aborted when steering selects another neighbour
      });
  }, []);

  /**
   * Layer 4 (Continuous Optical-Flow Glide Handoff & Smooth Turn Glides):
   * - During continuous driving (`animateManualGlide === false`): Buffer A is already 0% opacity
   *   and Buffer B is already at zoom = 1.00 — silent layer promotion keeps velocity 100% continuous!
   * - When clicking a directional turn button (`animateManualGlide === true`): smoothly glides
   *   heading + zoom + cross-morph over 1.5 seconds instead of jumping!
   */
  const executeGlideTransition = useCallback(
    async (
      link: ValidatedLink,
      options: { alignHeading?: boolean; animateManualGlide?: boolean; gear?: GearMode } = {},
    ) => {
      const car = carRef.current;
      const route = routeRef.current;
      const camera = cameraRef.current;
      if (!car || !route) return;

      const alignHeading = Boolean(options.alignHeading);
      const animateManualGlide = Boolean(options.animateManualGlide);
      const gear: GearMode = options.gear ?? car.getTelemetry().gear;

      const seq = ++navSeqRef.current;
      car.setSwapInFlight(true);
      setError(null);

      try {
        if (renderBackendRef.current === 'maps-js') {
          const mapsRenderer = mapsJsRendererRef.current;
          if (!mapsRenderer) return;

          const meta = animateManualGlide
            ? await mapsRenderer.animateGlideToPanoId(
                link.destinationPanoId,
                alignHeading ? link.heading : undefined,
                1500,
                gear,
              )
            : await mapsRenderer.commitContinuousGlideHandoff(link.destinationPanoId, gear);

          if (!mountedRef.current || seq !== navSeqRef.current) return;
          if (meta) {
            const finalHeading = alignHeading
              ? normalizeHeading(link.heading)
              : mapsRenderer.getHeading();
            route.setCurrentPanorama(meta, finalHeading);
            car.setCurrentPanorama(meta.panoId, finalHeading);
            syncRouteUiState(finalHeading);
            setTelemetry(car.getTelemetry());
            setCoverageNotice(null);

            // Stage the immediate next link in Buffer B so the next segment glides seamlessly
            const nextAction: NavigationAction = gear === 'R' ? 'reverse' : 'forward';
            const nextChoice = route.resolveDirection(nextAction, finalHeading, meta.panoId);
            if (nextChoice) {
              prepareSingleNextInBufferB(nextChoice.link, gear);
            }
          }
          return;
        }

        // Three.js Projective Street-Corridor Shader backend (Map Tiles API / Licensed datasets)
        const provider = providerRef.current;
        const renderer = tilesRendererRef.current;
        const scheduler = schedulerRef.current;
        if (!provider || !renderer || !scheduler || !camera) return;

        if (!renderer.isBufferBReadyFor(link.destinationPanoId)) {
          const taskKey = `prepare:${link.destinationPanoId}:${qualityRef.current}`;
          await scheduler.schedule(taskKey, async (signal) => {
            const meta = await provider.fetchMetadataById(link.destinationPanoId, signal);
            route.registerMetadata(meta);
            const frame = await provider.decodePanoramaFrame(
              meta,
              qualityRef.current,
              renderer.getMaxTextureSize(),
              signal,
            );
            if (!signal.aborted) {
              renderer.stagePanoramaInBufferB(meta, frame.canvas);
              tilesMonitorRef.current.markReady(
                tilesMonitorRef.current.getSnapshot().stagingBuffer,
                meta.panoId,
              );
            }
          });
        }

        if (!mountedRef.current || seq !== navSeqRef.current) return;

        // If user clicked a turn button manually, glide smoothly over 1.2s in the shader before promoting
        if (animateManualGlide) {
          const startHeading = camera.getHeading();
          const endHeading = alignHeading ? normalizeHeading(link.heading) : startHeading;
          const deltaH = calculateAngularDifference(startHeading, endHeading);
          const startMs = performance.now();
          await new Promise<void>((resolve) => {
            const tick = () => {
              if (!mountedRef.current || seq !== navSeqRef.current) {
                resolve();
                return;
              }
              const t = Math.min(1, (performance.now() - startMs) / 1200);
              if (alignHeading) {
                camera.setHeadingImmediate(normalizeHeading(startHeading + deltaH * t));
              }
              renderer.updateGlideState(t, link.heading, gear, true);
              if (t < 1) {
                requestAnimationFrame(tick);
              } else {
                resolve();
              }
            };
            requestAnimationFrame(tick);
          });
        }

        if (!mountedRef.current || seq !== navSeqRef.current) return;

        const swapped = renderer.commitInstantSwap(link.destinationPanoId);
        if (!swapped) return;

        const meta =
          route.getKnownMetadataList().find((m) => m.panoId === link.destinationPanoId) ??
          (await provider.fetchMetadataById(link.destinationPanoId));

        if (!mountedRef.current || seq !== navSeqRef.current) return;

        const prevMonitor = tilesMonitorRef.current.getSnapshot();
        tilesMonitorRef.current.markSwapped(
          prevMonitor.stagingBuffer,
          meta.panoId,
          prevMonitor.displayedBuffer,
        );
        setBufferMonitor(tilesMonitorRef.current.getSnapshot());

        const nextHeading = alignHeading
          ? normalizeHeading(link.heading)
          : camera.getHeading();
        if (alignHeading) {
          camera.setHeadingImmediate(nextHeading);
          camera.setPitchImmediate(0);
        }

        const links = route.setCurrentPanorama(meta, nextHeading);
        car.setCurrentPanorama(meta.panoId, nextHeading);
        const activeTarget = car.getTelemetry().targetLink;
        renderer.setRoadMarkers(links, activeTarget?.destinationPanoId ?? null);

        syncRouteUiState(nextHeading);
        setTelemetry(car.getTelemetry());
        setCoverageNotice(null);

        const nextAction: NavigationAction = gear === 'R' ? 'reverse' : 'forward';
        const nextChoice = route.resolveDirection(nextAction, nextHeading, meta.panoId);
        if (nextChoice) {
          prepareSingleNextInBufferB(nextChoice.link, gear);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (!mountedRef.current || seq !== navSeqRef.current) return;
        setError(mapErrorToSimulatorError(err, 'Unable to Move to Next Panorama'));
      } finally {
        if (seq === navSeqRef.current) {
          car.setSwapInFlight(false);
        }
      }
    },
    [prepareSingleNextInBufferB, syncRouteUiState],
  );

  /**
   * Loads any real-world coordinate in either Tiles API mode or Maps JS Continuous-Glide mode.
   */
  const loadLocation = useCallback(
    async (
      lat: number,
      lng: number,
      label?: string,
      options?: { locationSource?: 'gps' | 'network' },
    ) => {
      const car = carRef.current;
      const route = routeRef.current;
      const camera = cameraRef.current;
      if (!car || !route) return;

      const seq = ++navSeqRef.current;
      car.emergencyStop();
      car.setSwapInFlight(true);
      setError(null);
      setCoverageNotice(null);

      try {
        if (renderBackendRef.current === 'maps-js') {
          const mapsRenderer = mapsJsRendererRef.current;
          if (!mapsRenderer) {
            pendingCoordsRef.current = { lat, lng, label };
            return;
          }

          let loaded = await mapsRenderer.loadByLocation(lat, lng, 60);
          let snappedNearby = false;

          if (!loaded) {
            const nearby = await mapsRenderer.findNearbyCoveredLocation(lat, lng);
            if (!nearby) {
              setError({
                code: 'NO_COVERAGE',
                title: 'No Street View Coverage',
                message: `No Google Street View imagery is available near ${label || `${lat.toFixed(4)}, ${lng.toFixed(4)}`}. Try a nearby road or major city.`,
                recoverable: true,
              });
              setIsInitializing(false);
              return;
            }
            loaded = await mapsRenderer.activateLoadedMetadata(nearby, lat, lng, true);
            snappedNearby = true;
          }

          if (!loaded || !mountedRef.current || seq !== navSeqRef.current) return;

          const { metadata, snappedToRoad } = loaded;
          const initialHeading = normalizeHeading(
            metadata.links[0]?.heading ?? metadata.heading,
          );
          route.setCurrentPanorama(metadata, initialHeading);
          car.setCurrentPanorama(metadata.panoId, initialHeading);
          syncRouteUiState(initialHeading);
          setTelemetry(car.getTelemetry());
          setIsInitializing(false);

          if (options?.locationSource === 'gps') {
            setCoverageNotice(
              `Loaded Street View at ${metadata.streetName} near your current GPS location.`,
            );
          } else if (options?.locationSource === 'network') {
            setCoverageNotice(
              `Loaded nearest Street View road (${metadata.streetName}) near your current location (${label || 'Network Location'}).`,
            );
          } else if (snappedNearby || snappedToRoad) {
            setCoverageNotice(
              `Adjusted to nearest connected Street View road (${metadata.streetName}).`,
            );
          } else if (metadata.links.length === 0) {
            setCoverageNotice(
              'Isolated Street View spot with no adjacent connected road links.',
            );
          }

          const nextForward = route.resolveDirection('forward', initialHeading, metadata.panoId);
          if (nextForward) {
            prepareSingleNextInBufferB(nextForward.link, 'D');
          }
          return;
        }

        // Official Street View Tiles API mode
        const provider = providerRef.current;
        const renderer = tilesRendererRef.current;
        const scheduler = schedulerRef.current;
        if (!provider || !renderer || !scheduler || !camera) return;

        scheduler.cancelAllExcept();
        let metadata: PanoramaMetadata;
        let snappedNearby = false;

        try {
          metadata = await provider.fetchMetadataByLocation(lat, lng, 60);
        } catch (err) {
          if (err instanceof StreetViewApiError && err.code === 'NO_COVERAGE') {
            const nearby = await provider.findNearbyCoverage(lat, lng);
            if (!nearby) {
              throw err;
            }
            metadata = nearby;
            snappedNearby = true;
          } else {
            throw err;
          }
        }

        if (metadata.links.length === 0) {
          const drivable = await provider.findNearbyDrivableCoverage(lat, lng, metadata.panoId);
          if (drivable && drivable.links.length > 0) {
            metadata = drivable;
            snappedNearby = true;
          }
        }

        if (!mountedRef.current || seq !== navSeqRef.current) return;

        const frame = await scheduler.schedule(`init:${metadata.panoId}`, (signal) =>
          provider.decodePanoramaFrame(
            metadata,
            qualityRef.current,
            renderer.getMaxTextureSize(),
            signal,
          ),
        );

        if (!mountedRef.current || seq !== navSeqRef.current) return;

        renderer.displayInitialPanorama(metadata, frame.canvas);
        tilesMonitorRef.current.markInitialDisplay('A', metadata.panoId);
        setBufferMonitor(tilesMonitorRef.current.getSnapshot());

        const initialHeading = normalizeHeading(
          metadata.links[0]?.heading ?? metadata.heading,
        );
        camera.setHeadingImmediate(initialHeading);
        camera.setPitchImmediate(0);

        const links = route.setCurrentPanorama(metadata, initialHeading);
        car.setCurrentPanorama(metadata.panoId, initialHeading);
        renderer.setRoadMarkers(links, car.getTelemetry().targetLink?.destinationPanoId ?? null);

        syncRouteUiState(initialHeading);
        setTelemetry(car.getTelemetry());
        setIsInitializing(false);

        if (options?.locationSource === 'gps') {
          setCoverageNotice(
            `Loaded Street View at ${metadata.streetName} near your current GPS location.`,
          );
        } else if (options?.locationSource === 'network') {
          setCoverageNotice(
            `Loaded nearest Street View road (${metadata.streetName}) near your current location (${label || 'Network Location'}).`,
          );
        } else if (snappedNearby) {
          setCoverageNotice(
            `No Street View right at ${label || 'selected point'}. Loaded nearest road: ${metadata.streetName}.`,
          );
        } else if (metadata.links.length === 0) {
          setCoverageNotice(
            'Isolated Street View spot with no adjacent connected road links.',
          );
        }

        const nextForward = route.resolveDirection('forward', initialHeading, metadata.panoId);
        if (nextForward) {
          prepareSingleNextInBufferB(nextForward.link, 'D');
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (!mountedRef.current || seq !== navSeqRef.current) return;
        setError(mapErrorToSimulatorError(err, 'Unable to Load Location'));
        setIsInitializing(false);
      } finally {
        if (seq === navSeqRef.current) {
          car.setSwapInFlight(false);
        }
      }
    },
    [prepareSingleNextInBufferB, syncRouteUiState],
  );

  // Latest callbacks in refs for engine construction
  const executeGlideRef = useRef(executeGlideTransition);
  executeGlideRef.current = executeGlideTransition;
  const prepareSingleNextRef = useRef(prepareSingleNextInBufferB);
  prepareSingleNextRef.current = prepareSingleNextInBufferB;
  const loadLocationRef = useRef(loadLocation);
  loadLocationRef.current = loadLocation;
  const syncRouteUiStateRef = useRef(syncRouteUiState);
  syncRouteUiStateRef.current = syncRouteUiState;

  const attachMapsJsRenderer = useCallback(
    (streetViewLib: google.maps.StreetViewLibrary | null) => {
      mapsJsRendererRef.current?.dispose();
      mapsJsRendererRef.current = null;

      if (!streetViewLib || !mapsJsContainerRef.current) return;

      const renderer = new MapsJsDoubleBufferRenderer(
        mapsJsContainerRef.current,
        streetViewLib,
        {
          onPanoramaLoaded: (metadata, alignHeading) => {
            if (!mountedRef.current) return;
            const route = routeRef.current;
            const car = carRef.current;
            if (!route || !car) return;
            const heading = alignHeading
              ? normalizeHeading(metadata.links[0]?.heading ?? metadata.heading)
              : renderer.getHeading();
            route.setCurrentPanorama(metadata, heading);
            car.setCurrentPanorama(metadata.panoId, heading);
            syncRouteUiStateRef.current(heading);
            setTelemetry(car.getTelemetry());
            setIsInitializing(false);
            setError(null);
          },
          onPovChanged: (heading) => {
            if (!mountedRef.current) return;
            const car = carRef.current;
            const route = routeRef.current;
            if (!car || !route) return;
            car.syncHeadingFromCamera(heading);
            setJunction(route.getJunction(heading));
            setTelemetry(car.getTelemetry());
          },
          onUserNavigatedPano: (metadata) => {
            if (!mountedRef.current) return;
            const route = routeRef.current;
            const car = carRef.current;
            if (!route || !car) return;
            const heading = renderer.getHeading();
            route.setCurrentPanorama(metadata, heading);
            car.setCurrentPanorama(metadata.panoId, heading);
            syncRouteUiStateRef.current(heading);
            setTelemetry(car.getTelemetry());
            const nextForward = route.resolveDirection('forward', heading, metadata.panoId);
            if (nextForward) {
              prepareSingleNextRef.current(nextForward.link, car.getTelemetry().gear);
            }
          },
          onMonitorUpdate: (snapshot) => {
            if (mountedRef.current) {
              setBufferMonitor(snapshot);
            }
          },
        },
      );

      mapsJsRendererRef.current = renderer;

      const pending = pendingCoordsRef.current;
      pendingCoordsRef.current = null;
      const target = pending ?? DEFAULT_START_COORDS;
      void loadLocationRef.current(target.lat, target.lng, target.label);
    },
    [],
  );

  // Initialize all 5 engine layers on mount
  useEffect(() => {
    mountedRef.current = true;
    const container = canvasContainerRef.current;
    if (!container) return;

    const provider = new GoogleStreetViewProvider();
    const searchService = new LocationSearchService();
    const route = new RouteController();
    const camera = new CameraController();
    const scheduler = new RequestScheduler(provider.policy);

    const car = new CarController(route, {
      onHeadingChanged: (newHeading) => {
        if (renderBackendRef.current === 'maps-js') {
          const mapsRenderer = mapsJsRendererRef.current;
          if (
            mapsRenderer &&
            Math.abs(calculateAngularDifference(lastHeadingSyncedToMapRef.current, newHeading)) >
              0.2
          ) {
            lastHeadingSyncedToMapRef.current = newHeading;
            mapsRenderer.setHeading(newHeading);
          }
        } else {
          camera.setHeadingImmediate(newHeading);
        }
      },
      onPrepareNextLink: (link) => {
        prepareSingleNextRef.current(link, car.getTelemetry().gear);
      },
      onCommitInstantSwap: (link, gear) => {
        void executeGlideRef.current(link, {
          alignHeading: false,
          animateManualGlide: false,
          gear,
        });
      },
      onDeadEndReached: (gear) => {
        setCoverageNotice(
          gear === 'R'
            ? 'No connected Street View road behind you. Steer toward an open direction or switch to Drive.'
            : 'End of connected road ahead. Steer left or right toward an available direction.',
        );
      },
    });

    providerRef.current = provider;
    searchServiceRef.current = searchService;
    routeRef.current = route;
    cameraRef.current = camera;
    schedulerRef.current = scheduler;
    carRef.current = car;

    // Initialize Three.js Projective Street-Corridor Renderer (for Map Tiles API / Licensed datasets)
    let tilesRenderer: InstantPanoramaRenderer | null = null;
    try {
      tilesRenderer = new InstantPanoramaRenderer(container, camera, {
        onFrame: (dtSeconds) => {
          if (renderBackendRef.current !== 'tiles') return;
          const activeTarget = car.getTelemetry().targetLink;
          const activeTargetId = activeTarget?.destinationPanoId ?? null;
          const isReady = activeTargetId
            ? tilesRenderer?.isBufferBReadyFor(activeTargetId) ?? false
            : false;
          const nextTelemetry = car.step(dtSeconds, isReady);

          // Update real-time 3D projective corridor shader every single frame
          tilesRenderer?.updateGlideState(
            nextTelemetry.progressToNext,
            nextTelemetry.targetLink?.heading ?? nextTelemetry.heading,
            nextTelemetry.gear,
            isReady,
          );

          const now = performance.now();
          if (now - lastUiSyncMsRef.current >= 42) {
            lastUiSyncMsRef.current = now;
            setTelemetry(nextTelemetry);
            setJunction(route.getJunction(nextTelemetry.heading));
          }
        },
        onRoadMarkerClick: (link) => {
          void executeGlideRef.current(link, {
            alignHeading: true,
            animateManualGlide: true,
            gear: car.getTelemetry().gear,
          });
        },
        onContextLost: () => {
          setError({
            code: 'WEBGL_CONTEXT_LOST',
            title: '3D Graphics Context Paused',
            message: 'Browser WebGL context was interrupted. Waiting for recovery...',
            recoverable: true,
          });
        },
        onContextRestored: () => {
          setError(null);
        },
      });
      tilesRendererRef.current = tilesRenderer;
      tilesRenderer.start();
    } catch {
      tilesRendererRef.current = null;
    }

    const handleQuotaExceeded = () => {
      if (mountedRef.current) {
        setQuotaExceeded(true);
      }
    };
    window.addEventListener('gmp-quota-exceeded', handleQuotaExceeded);
    const unsubscribeQuota = () => {
      window.removeEventListener('gmp-quota-exceeded', handleQuotaExceeded);
    };

    const detachKeyboard = attachKeyboardControls({
      onInputChange: (key, active) => {
        car.setInput(key, active);
        setTelemetry(car.getTelemetry());
      },
      onResetInputs: () => {
        car.resetInputs();
        setTelemetry(car.getTelemetry());
      },
      onToggleReverse: () => {
        car.toggleReverseGear();
        setTelemetry(car.getTelemetry());
      },
      onToggleCruise: () => {
        car.toggleCruise();
        setTelemetry(car.getTelemetry());
      },
      onSnapTurnLeft: () => {
        const left = route.resolveDirection('left', car.getTelemetry().heading);
        if (left) {
          void executeGlideRef.current(left.link, {
            alignHeading: true,
            animateManualGlide: true,
            gear: 'D',
          });
        }
      },
      onSnapTurnRight: () => {
        const right = route.resolveDirection('right', car.getTelemetry().heading);
        if (right) {
          void executeGlideRef.current(right.link, {
            alignHeading: true,
            animateManualGlide: true,
            gear: 'D',
          });
        }
      },
    });

    const bootstrap = async () => {
      try {
        const health = await provider.checkServerConfig();
        if (!mountedRef.current) return;

        if (!health.apiConfigured) {
          if (MAPS_JS_API_KEY) {
            renderBackendRef.current = 'maps-js';
            setRenderBackend('maps-js');
            tilesRenderer?.stop();
            pendingCoordsRef.current = DEFAULT_START_COORDS;
            return;
          }
          setError({
            code: 'MISSING_API_KEY',
            title: 'Google Maps API Key Required',
            message:
              'Configure GOOGLE_MAPS_API_KEY in the server environment to load Google Street View.',
            recoverable: false,
          });
          setIsInitializing(false);
          return;
        }

        if (!tilesRenderer) {
          if (MAPS_JS_API_KEY) {
            renderBackendRef.current = 'maps-js';
            setRenderBackend('maps-js');
            pendingCoordsRef.current = DEFAULT_START_COORDS;
            return;
          }
          setError({
            code: 'WEBGL_UNAVAILABLE',
            title: 'WebGL Required',
            message: 'WebGL is unavailable in this browser.',
            recoverable: false,
          });
          setIsInitializing(false);
          return;
        }

        if (health.tilesApiAvailable === false && MAPS_JS_API_KEY) {
          renderBackendRef.current = 'maps-js';
          setRenderBackend('maps-js');
          tilesRenderer.stop();
          pendingCoordsRef.current = DEFAULT_START_COORDS;
          return;
        }

        try {
          await provider.ensureSession();
        } catch (sessionErr) {
          const isTilesDenied =
            sessionErr instanceof StreetViewApiError &&
            (sessionErr.status === 403 ||
              sessionErr.status === 401 ||
              sessionErr.isAuthError ||
              sessionErr.code === 'ACCESS_DENIED');

          if (isTilesDenied && MAPS_JS_API_KEY) {
            renderBackendRef.current = 'maps-js';
            setRenderBackend('maps-js');
            tilesRenderer.stop();
            pendingCoordsRef.current = DEFAULT_START_COORDS;
            return;
          }
          throw sessionErr;
        }

        if (!mountedRef.current) return;
        renderBackendRef.current = 'tiles';
        setRenderBackend('tiles');
        await loadLocationRef.current(
          DEFAULT_START_COORDS.lat,
          DEFAULT_START_COORDS.lng,
          DEFAULT_START_COORDS.label,
        );
      } catch (err) {
        if (!mountedRef.current) return;
        setError(mapErrorToSimulatorError(err, 'Unable to Connect to Google Street View'));
        setIsInitializing(false);
      }
    };

    void bootstrap();

    return () => {
      mountedRef.current = false;
      detachKeyboard();
      unsubscribeQuota();
      scheduler.dispose();
      tilesRenderer?.dispose();
      mapsJsRendererRef.current?.dispose();
      mapsJsRendererRef.current = null;
      tilesRendererRef.current = null;
    };
  }, []);

  // Dedicated 60fps Continuous Optical-Flow Glide loop for `maps-js` backend
  useEffect(() => {
    if (renderBackend !== 'maps-js') return;
    let rafId = 0;
    let lastMs = performance.now();

    const frame = () => {
      const now = performance.now();
      const dt = Math.min(0.1, Math.max(0.001, (now - lastMs) / 1000));
      lastMs = now;

      const car = carRef.current;
      const route = routeRef.current;
      const mapsRenderer = mapsJsRendererRef.current;
      if (car && route) {
        const activeTargetId = car.getTelemetry().targetLink?.destinationPanoId ?? null;
        const isBufferBReady = activeTargetId
          ? mapsRenderer?.isStagingReadyFor(activeTargetId) ?? false
          : false;
        const nextTelemetry = car.step(dt, isBufferBReady);

        // Drive synchronized 60fps dual-canvas exponential optical-flow glide & smootherstep cross-morph
        mapsRenderer?.updateGlideFrame(
          nextTelemetry.progressToNext,
          nextTelemetry.gear,
          nextTelemetry.targetLink?.destinationPanoId ?? null,
          nextTelemetry.targetLink?.heading,
        );

        if (now - lastUiSyncMsRef.current >= 42) {
          lastUiSyncMsRef.current = now;
          setTelemetry(nextTelemetry);
          setJunction(route.getJunction(nextTelemetry.heading));
        }
      }

      rafId = requestAnimationFrame(frame);
    };

    rafId = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafId);
  }, [renderBackend]);

  // Public interactive actions
  const setCarInput = useCallback(
    <K extends keyof CarInputState>(key: K, active: boolean) => {
      const car = carRef.current;
      if (!car) return;
      car.setInput(key, active);
      setTelemetry(car.getTelemetry());
    },
    [],
  );

  const setGear = useCallback((gear: GearMode) => {
    const car = carRef.current;
    if (!car) return;
    car.setGear(gear);
    setTelemetry(car.getTelemetry());
  }, []);

  const setPace = useCallback((pace: GlidePacePreset) => {
    const car = carRef.current;
    if (!car) return;
    car.setPace(pace);
    setTelemetry(car.getTelemetry());
  }, []);

  const toggleReverse = useCallback(() => {
    const car = carRef.current;
    if (!car) return;
    car.toggleReverseGear();
    setTelemetry(car.getTelemetry());
  }, []);

  const toggleCruise = useCallback(() => {
    const car = carRef.current;
    if (!car) return;
    car.toggleCruise();
    setTelemetry(car.getTelemetry());
  }, []);

  const navigateDirection = useCallback(
    (action: NavigationAction) => {
      const route = routeRef.current;
      const car = carRef.current;
      if (!route || !car) return;
      const choice = route.resolveDirection(action, car.getTelemetry().heading);
      if (!choice) {
        setCoverageNotice(`No connected Street View road available in the ${action} direction.`);
        return;
      }
      void executeGlideTransition(choice.link, {
        alignHeading: action !== 'reverse',
        animateManualGlide: true,
        gear: action === 'reverse' ? 'R' : 'D',
      });
    },
    [executeGlideTransition],
  );

  const navigateToLink = useCallback(
    (link: ValidatedLink) => {
      void executeGlideTransition(link, {
        alignHeading: true,
        animateManualGlide: true,
        gear: 'D',
      });
    },
    [executeGlideTransition],
  );

  const recenterHorizon = useCallback(() => {
    const heading = carRef.current?.getTelemetry().heading ?? 0;
    if (renderBackendRef.current === 'maps-js') {
      mapsJsRendererRef.current?.recenter(heading);
    } else {
      cameraRef.current?.setHeadingImmediate(heading);
      cameraRef.current?.setPitchImmediate(0);
      cameraRef.current?.setFov(75);
    }
  }, []);

  const changeQuality = useCallback(async (nextQuality: QualityPreset) => {
    qualityRef.current = nextQuality;
    setQuality(nextQuality);

    if (renderBackendRef.current !== 'tiles') return;
    const provider = providerRef.current;
    const renderer = tilesRendererRef.current;
    const scheduler = schedulerRef.current;
    const active = routeRef.current?.getActiveMetadata();
    if (!provider || !renderer || !scheduler || !active) return;

    try {
      const frame = await scheduler.schedule(`quality:${active.panoId}:${nextQuality}`, (signal) =>
        provider.decodePanoramaFrame(active, nextQuality, renderer.getMaxTextureSize(), signal),
      );
      if (mountedRef.current) {
        renderer.displayInitialPanorama(active, frame.canvas);
      }
    } catch {
      // Non-fatal
    }
  }, []);

  const handleAutocomplete = useCallback(async (query: string, signal?: AbortSignal) => {
    const svc = searchServiceRef.current;
    if (!svc) return [];
    const active = routeRef.current?.getActiveMetadata();
    return svc.autocomplete(
      query,
      active ? { lat: active.lat, lng: active.lng } : undefined,
      signal,
    );
  }, []);

  const handleSearchText = useCallback(async (query: string, signal?: AbortSignal) => {
    const svc = searchServiceRef.current;
    if (!svc) return [];
    const active = routeRef.current?.getActiveMetadata();
    return svc.searchByText(
      query,
      active ? { lat: active.lat, lng: active.lng } : undefined,
      signal,
    );
  }, []);

  const handleSelectSuggestion = useCallback(
    async (suggestion: PlaceSuggestion) => {
      const svc = searchServiceRef.current;
      if (!svc) return;
      try {
        const place = await svc.getPlaceDetails(suggestion.placeId);
        await loadLocation(place.lat, place.lng, place.name);
      } catch (err) {
        setError(mapErrorToSimulatorError(err, 'Unable to Open Place'));
      }
    },
    [loadLocation],
  );

  const handleSelectPlace = useCallback(
    async (place: PlaceResult) => {
      await loadLocation(place.lat, place.lng, place.name);
    },
    [loadLocation],
  );

  const locateCurrentDevice = useCallback(async () => {
    if (isLocating) return;
    setIsLocating(true);
    setCoverageNotice('Detecting your current location...');

    try {
      const resolved = await deviceLocationServiceRef.current.resolveDeviceLocation();
      if (!mountedRef.current) return;
      await loadLocation(resolved.lat, resolved.lng, resolved.label, {
        locationSource: resolved.source,
      });
    } catch (err) {
      if (!mountedRef.current) return;
      setCoverageNotice(
        err instanceof Error
          ? err.message
          : 'Unable to determine your current location. Use the search bar instead.',
      );
    } finally {
      if (mountedRef.current) {
        setIsLocating(false);
      }
    }
  }, [isLocating, loadLocation]);

  const retryConnection = useCallback(() => {
    setError(null);
    const active = routeRef.current?.getActiveMetadata();
    if (active) {
      void loadLocation(active.lat, active.lng, active.streetName);
    } else {
      void loadLocation(
        DEFAULT_START_COORDS.lat,
        DEFAULT_START_COORDS.lng,
        DEFAULT_START_COORDS.label,
      );
    }
  }, [loadLocation]);

  const dismissError = useCallback(() => setError(null), []);
  const dismissNotice = useCallback(() => setCoverageNotice(null), []);

  return {
    canvasContainerRef,
    mapsJsContainerRef,
    attachMapsJsRenderer,
    renderBackend,
    providerName: providerRef.current?.name ?? 'Google Street View',
    currentMetadata,
    telemetry,
    junction,
    bufferMonitor,
    history,
    knownMetadata,
    allLinks,
    quality,
    isInitializing,
    isLocating,
    error,
    coverageNotice,
    quotaExceeded,
    setCarInput,
    setGear,
    setPace,
    toggleReverse,
    toggleCruise,
    navigateDirection,
    navigateToLink,
    loadLocation,
    handleAutocomplete,
    handleSearchText,
    handleSelectSuggestion,
    handleSelectPlace,
    locateCurrentDevice,
    recenterHorizon,
    changeQuality,
    retryConnection,
    dismissError,
    dismissNotice,
  };
}
