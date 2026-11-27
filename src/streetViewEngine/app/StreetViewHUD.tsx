import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Compass,
  CornerUpLeft,
  CornerUpRight,
  Crosshair,
  Loader2,
  Map as MapIcon,
  Maximize2,
  Minimize2,
  OctagonX,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  X,
} from 'lucide-react';
import { LocationSearch } from '../../components/LocationSearch/LocationSearch';
import { MiniMap } from '../../components/MiniMap/MiniMap';
import type { PanoramaEdge, PanoramaNode } from '../../types/streetview';
import { formatCoordinates } from '../../utils/geo';
import { createTouchHoldProps } from '../driving/MobileControls';
import { formatHeading } from '../navigation/DirectionCalculator';
import type { NavigationAction } from '../navigation/RouteController';
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
import type { RenderBackend } from './useStreetViewEngine';

interface StreetViewHUDProps {
  renderBackend: RenderBackend;
  currentMetadata: PanoramaMetadata | null;
  telemetry: CarTelemetry;
  junction: JunctionSummary;
  bufferMonitor: BufferMonitorSnapshot;
  history: NavigationHistoryEntry[];
  knownMetadata: PanoramaMetadata[];
  allLinks: ValidatedLink[];
  quality: QualityPreset;
  isInitializing: boolean;
  isLocating?: boolean;
  error: SimulatorError | null;
  coverageNotice: string | null;
  quotaExceeded: boolean;
  onSetInput: <K extends keyof CarInputState>(key: K, active: boolean) => void;
  onSetGear: (gear: GearMode) => void;
  onSetPace: (pace: GlidePacePreset) => void;
  onToggleReverse: () => void;
  onToggleCruise: () => void;
  onNavigateDirection: (action: NavigationAction) => void;
  onNavigateToLink: (link: ValidatedLink) => void;
  onSelectLocation: (lat: number, lng: number, label?: string) => void;
  onAutocomplete: (query: string, signal?: AbortSignal) => Promise<PlaceSuggestion[]>;
  onSearchText: (query: string, signal?: AbortSignal) => Promise<PlaceResult[]>;
  onSelectSuggestion: (suggestion: PlaceSuggestion) => Promise<void>;
  onSelectPlace: (place: PlaceResult) => Promise<void>;
  onLocateDevice: () => void;
  onRecenter: () => void;
  onChangeQuality: (quality: QualityPreset) => void;
  onRetry: () => void;
  onDismissError: () => void;
  onDismissNotice: () => void;
}

const SPEED_ARC_RADIUS = 38;
const SPEED_ARC_CIRCUMFERENCE = Math.PI * SPEED_ARC_RADIUS;

const PACE_OPTIONS: ReadonlyArray<{ id: GlidePacePreset; label: string }> = [
  { id: 'walk', label: 'Walk' },
  { id: 'slow', label: 'Slow' },
  { id: 'cruise', label: 'Cruise' },
];

function formatDistance(meters: number, estimated: boolean): string {
  const rounded = Math.max(1, Math.round(meters));
  return estimated ? `~${rounded} m` : `${rounded} m`;
}

export const StreetViewHUD: React.FC<StreetViewHUDProps> = ({
  renderBackend,
  currentMetadata,
  telemetry,
  junction,
  history,
  knownMetadata,
  allLinks,
  quality,
  isInitializing,
  isLocating = false,
  error,
  coverageNotice,
  quotaExceeded,
  onSetInput,
  onSetGear,
  onSetPace,
  onToggleCruise,
  onNavigateToLink,
  onSelectLocation,
  onAutocomplete,
  onSearchText,
  onSelectSuggestion,
  onSelectPlace,
  onLocateDevice,
  onRecenter,
  onChangeQuality,
  onRetry,
  onDismissError,
  onDismissNotice,
}) => {
  const [showMiniMap, setShowMiniMap] = useState(false);
  const [cockpitExpanded, setCockpitExpanded] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const controlsDisabled = isInitializing || !currentMetadata;

  const miniMapNodes = useMemo<PanoramaNode[]>(
    () =>
      knownMetadata.map((meta) => ({
        panoId: meta.panoId,
        metadata: meta,
        discoveredAt: Date.now(),
        visitedCount: 1,
      })),
    [knownMetadata],
  );

  const miniMapEdges = useMemo<PanoramaEdge[]>(
    () =>
      allLinks.map((link) => ({
        sourcePanoId: link.sourcePanoId,
        destinationPanoId: link.destinationPanoId,
        heading: link.heading,
        text: link.text,
        distanceMeters: link.distanceMeters,
        distanceEstimated: link.distanceEstimated,
      })),
    [allLinks],
  );

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      void document.documentElement.requestFullscreen?.().then(() => setIsFullscreen(true));
    } else {
      void document.exitFullscreen?.().then(() => setIsFullscreen(false));
    }
  };

  const speedDisplay = Math.round(telemetry.speedKmh);
  const arcOffset =
    SPEED_ARC_CIRCUMFERENCE * (1 - Math.max(0, Math.min(1, telemetry.speedRatio)));
  const progressPct = Math.round(telemetry.progressToNext * 100);
  const distanceKm = (telemetry.totalDistanceMeters / 1000).toFixed(2);
  const headingText = formatHeading(telemetry.heading);

  const steerLeftProps = createTouchHoldProps('steerLeft', controlsDisabled, onSetInput);
  const steerRightProps = createTouchHoldProps('steerRight', controlsDisabled, onSetInput);
  const brakeProps = createTouchHoldProps('brake', controlsDisabled, onSetInput);
  const stopProps = createTouchHoldProps('handbrake', controlsDisabled, onSetInput);
  const driveProps = createTouchHoldProps('accelerate', controlsDisabled, onSetInput);

  return (
    <div className="pointer-events-none fixed inset-0 z-20 flex flex-col justify-between p-2.5 sm:p-4 select-none">
      {/* === TOP NAVIGATION BAR === */}
      <header className="pointer-events-auto flex flex-wrap items-center justify-between gap-2 sm:gap-3">
        {/* Left: App Title & Live Street Location */}
        <div className="flex items-center gap-2.5 bg-[#0B0E14]/92 border border-white/12 rounded-xl px-3 py-2 shadow-xl max-w-full sm:max-w-[300px] min-w-0">
          <div className="min-w-0">
            <h1 className="text-xs font-semibold tracking-wide text-amber-400 uppercase leading-tight truncate">
              Real Street View Drive
            </h1>
            {currentMetadata ? (
              <div className="mt-0.5 min-w-0">
                <p
                  data-testid="street-name"
                  className="text-sm font-medium text-slate-100 truncate leading-snug"
                  title={currentMetadata.formattedLocation}
                >
                  {currentMetadata.streetName}
                </p>
                <p className="text-[11px] font-telemetry text-slate-400 truncate">
                  {formatCoordinates(currentMetadata.lat, currentMetadata.lng)}
                  {currentMetadata.date ? ` · ${currentMetadata.date}` : ''}
                </p>
              </div>
            ) : (
              <p className="text-xs text-slate-400 mt-0.5">Connecting to Street View...</p>
            )}
          </div>
        </div>

        {/* Center: Real-World Location Search */}
        <div className="order-3 sm:order-2 w-full sm:w-auto sm:flex-1 flex justify-center min-w-0">
          <LocationSearch
            onAutocomplete={onAutocomplete}
            onSearchText={onSearchText}
            onSelectSuggestion={onSelectSuggestion}
            onSelectPlace={onSelectPlace}
            onLocateDevice={onLocateDevice}
            isLocating={isLocating}
            disabled={isInitializing}
          />
        </div>

        {/* Right: Utility Controls */}
        <div className="order-2 sm:order-3 flex items-center gap-1.5 bg-[#0B0E14]/92 border border-white/12 rounded-xl p-1 shadow-xl shrink-0">
          {renderBackend === 'tiles' && (
            <select
              aria-label="Panorama resolution quality"
              value={quality}
              onChange={(e) => onChangeQuality(e.target.value as QualityPreset)}
              className="bg-transparent text-xs font-medium text-slate-200 px-2 py-1.5 rounded-lg hover:bg-white/8 focus:outline-none cursor-pointer"
            >
              <option value="fast" className="bg-[#0B0E14]">
                Fast
              </option>
              <option value="balanced" className="bg-[#0B0E14]">
                Balanced
              </option>
              <option value="high" className="bg-[#0B0E14]">
                High
              </option>
            </select>
          )}

          <button
            type="button"
            onClick={() => setShowMiniMap((v) => !v)}
            aria-pressed={showMiniMap}
            aria-label="Toggle Road Mini-Map"
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
              showMiniMap
                ? 'bg-amber-500 text-slate-950'
                : 'text-slate-200 hover:bg-white/10'
            }`}
          >
            <MapIcon className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="hidden md:inline">Map</span>
          </button>

          <button
            type="button"
            onClick={onRecenter}
            disabled={controlsDisabled}
            aria-label="Recenter camera view"
            title="Recenter horizon"
            className="p-2 text-slate-200 hover:bg-white/10 rounded-lg transition-colors disabled:opacity-40"
          >
            <Crosshair className="w-3.5 h-3.5" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            className="p-2 text-slate-200 hover:bg-white/10 rounded-lg transition-colors"
          >
            {isFullscreen ? (
              <Minimize2 className="w-3.5 h-3.5" aria-hidden="true" />
            ) : (
              <Maximize2 className="w-3.5 h-3.5" aria-hidden="true" />
            )}
          </button>
        </div>
      </header>

      {/* === MIDDLE AREA: NOTICES, ERRORS & OPTIONAL MINI-MAP === */}
      <div className="relative flex-1 flex flex-col items-center justify-center my-2 min-h-0">
        {quotaExceeded && (
          <div
            role="alert"
            className="pointer-events-auto mb-2 px-3.5 py-2 rounded-lg bg-amber-950/95 border border-amber-500/40 text-xs text-amber-200 flex items-center gap-2 shadow-xl max-w-md"
          >
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
            <span>Google Maps API rate limit reached. Movement may pause briefly.</span>
          </div>
        )}

        {coverageNotice && !error && (
          <div
            role="status"
            data-testid="coverage-notice"
            className="pointer-events-auto absolute top-1 left-1/2 -translate-x-1/2 px-3.5 py-2 rounded-lg bg-[#0B0E14]/94 border border-amber-400/35 text-xs text-slate-200 flex items-center gap-2.5 shadow-xl max-w-md"
          >
            <Compass className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
            <span className="leading-snug">{coverageNotice}</span>
            <button
              type="button"
              onClick={onDismissNotice}
              aria-label="Dismiss notice"
              className="p-1 text-slate-400 hover:text-white shrink-0"
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
        )}

        {showMiniMap && currentMetadata && (
          <div className="absolute top-1 right-0 z-30">
            <MiniMap
              currentMetadata={currentMetadata}
              heading={telemetry.heading}
              nodes={miniMapNodes}
              edges={miniMapEdges}
              history={history}
              onSelectLocation={onSelectLocation}
              onClose={() => setShowMiniMap(false)}
            />
          </div>
        )}

        {isInitializing && !error && (
          <div
            role="status"
            aria-live="polite"
            className="pointer-events-auto bg-[#0B0E14]/94 border border-white/14 rounded-2xl px-5 py-4 shadow-2xl flex items-center gap-3"
          >
            <Loader2 className="w-5 h-5 text-amber-400 animate-spin shrink-0" aria-hidden="true" />
            <div>
              <p className="text-sm font-medium text-slate-100">Loading Real Street View</p>
              <p className="text-xs text-slate-400">Connecting to Google panoramic road network...</p>
            </div>
          </div>
        )}

        {error && (
          <div
            role="alert"
            data-testid="simulator-error"
            className="pointer-events-auto max-w-md w-full bg-[#0B0E14]/96 border border-rose-500/40 rounded-2xl p-5 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
                <div>
                  <h2 className="text-base font-semibold text-white">{error.title}</h2>
                  <p className="mt-1.5 text-sm text-slate-300 leading-relaxed">{error.message}</p>
                </div>
              </div>
              {error.recoverable && currentMetadata && (
                <button
                  type="button"
                  onClick={onDismissError}
                  aria-label="Close error dialog"
                  className="p-1 text-slate-400 hover:text-white rounded"
                >
                  <X className="w-4 h-4" aria-hidden="true" />
                </button>
              )}
            </div>

            {error.recoverable && (
              <div className="mt-4 flex items-center gap-2">
                <button
                  type="button"
                  onClick={onRetry}
                  className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-white/10 hover:bg-white/16 border border-white/14 text-sm font-medium text-white transition-colors"
                >
                  <RefreshCw className="w-4 h-4" aria-hidden="true" />
                  Retry Connection
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* === BOTTOM DRIVING COCKPIT === */}
      <footer
        className={`pointer-events-none flex flex-col items-center gap-1.5 ${
          renderBackend === 'maps-js' ? 'pb-7 sm:pb-6' : 'pb-0.5'
        }`}
      >
        <button
          type="button"
          onClick={() => setCockpitExpanded((v) => !v)}
          aria-expanded={cockpitExpanded}
          className="pointer-events-auto inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-[#0B0E14]/90 border border-white/12 text-[11px] font-medium text-slate-300 hover:text-white transition-colors shadow-lg"
        >
          {cockpitExpanded ? (
            <>
              <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
              Hide Cockpit
            </>
          ) : (
            <>
              <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
              Show Cockpit
            </>
          )}
        </button>

        {cockpitExpanded && (
          <section
            aria-label="Driving Dashboard and Controls"
            data-testid="driving-cockpit"
            className="pointer-events-auto w-full max-w-5xl bg-[#0B0E14]/93 border border-white/14 rounded-2xl px-3 py-2.5 sm:px-4 sm:py-3 shadow-2xl"
          >
            <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3">
              {/* 1. Calm Pace Speedometer + Segment Glide Bar + Pace Selector */}
              <div className="flex items-center gap-3 shrink-0">
                <div className="relative w-[86px] h-[54px] shrink-0" aria-label={`Speed ${speedDisplay} km/h`}>
                  <svg viewBox="0 0 100 60" className="w-full h-full overflow-visible">
                    <path
                      d="M 12 50 A 38 38 0 0 1 88 50"
                      fill="none"
                      stroke="rgba(255,255,255,0.12)"
                      strokeWidth="7"
                      strokeLinecap="round"
                    />
                    <path
                      d="M 12 50 A 38 38 0 0 1 88 50"
                      fill="none"
                      stroke={telemetry.gear === 'R' ? '#38BDF8' : '#F59E0B'}
                      strokeWidth="7"
                      strokeLinecap="round"
                      strokeDasharray={SPEED_ARC_CIRCUMFERENCE}
                      strokeDashoffset={arcOffset}
                    />
                  </svg>
                  <div className="absolute inset-x-0 bottom-0 text-center leading-none">
                    <span
                      data-testid="speed-readout"
                      className="font-telemetry text-xl font-bold text-white"
                    >
                      {speedDisplay}
                    </span>
                    <span className="block text-[10px] text-slate-400 mt-0.5">km/h</span>
                  </div>
                </div>

                <div className="min-w-[152px]">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span
                      data-testid="gear-readout"
                      className={`font-semibold ${
                        telemetry.gear === 'R' ? 'text-sky-400' : 'text-amber-400'
                      }`}
                    >
                      {telemetry.gear === 'R' ? 'Reverse' : 'Drive'}
                    </span>
                    <span className="font-telemetry text-slate-300">{distanceKm} km</span>
                  </div>

                  {/* Pace Selector: Walk (8) · Slow (14) · Cruise (24) */}
                  <div
                    role="group"
                    aria-label="Movement pace"
                    className="mt-1.5 grid grid-cols-3 gap-0.5 p-0.5 rounded-lg bg-white/6 border border-white/10"
                  >
                    {PACE_OPTIONS.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => onSetPace(opt.id)}
                        aria-pressed={telemetry.pace === opt.id}
                        data-testid={`pace-${opt.id}`}
                        className={`px-1.5 py-0.5 rounded-md text-[11px] font-medium transition-colors whitespace-nowrap ${
                          telemetry.pace === opt.id
                            ? 'bg-amber-500 text-slate-950 font-semibold'
                            : 'text-slate-300 hover:text-white'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>

                  <div className="mt-1.5 flex items-center justify-between text-[10px] text-slate-400">
                    <span>Glide</span>
                    <span className="font-telemetry text-slate-300">
                      {telemetry.targetLink
                        ? formatDistance(
                            telemetry.segmentDistanceMeters,
                            telemetry.segmentDistanceEstimated,
                          )
                        : 'Blocked'}
                    </span>
                  </div>
                  <div className="mt-0.5 h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
                    <div
                      className="h-full bg-amber-400"
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                </div>
              </div>

              {/* 2. Intelligent Junction Navigation Row */}
              <div className="flex-1 min-w-0 flex flex-col gap-1.5 border-y lg:border-y-0 lg:border-x border-white/10 py-2 lg:py-0 lg:px-3">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-1.5 text-slate-200 font-telemetry">
                    <Compass className="w-3.5 h-3.5 text-amber-400 shrink-0" aria-hidden="true" />
                    <span data-testid="heading-readout">{headingText}</span>
                  </div>
                  <span
                    data-testid="junction-label"
                    className={`text-[11px] font-medium truncate ${
                      junction.isDeadEnd ? 'text-rose-300' : 'text-slate-300'
                    }`}
                  >
                    {junction.label}
                  </span>
                </div>

                <div
                  className="flex flex-wrap items-center gap-1.5"
                  role="group"
                  aria-label="Available connected street directions"
                >
                  {junction.left && (
                    <button
                      type="button"
                      disabled={controlsDisabled}
                      onClick={() => onNavigateToLink(junction.left!.link)}
                      data-testid="dir-left-btn"
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/8 hover:bg-white/16 border border-white/10 text-xs text-slate-100 transition-colors max-w-[155px]"
                      title={`Glide Left onto ${junction.left.link.text || 'connected street'}`}
                    >
                      <CornerUpLeft className="w-3.5 h-3.5 text-amber-400 shrink-0" aria-hidden="true" />
                      <span className="truncate">{junction.left.link.text || 'Left'}</span>
                    </button>
                  )}

                  {junction.forward && (
                    <button
                      type="button"
                      disabled={controlsDisabled}
                      onClick={() => onNavigateToLink(junction.forward!.link)}
                      data-testid="dir-forward-btn"
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/32 border border-amber-400/45 text-xs font-medium text-amber-100 transition-colors max-w-[175px]"
                      title={`Glide ahead on ${junction.forward.link.text || 'road'}`}
                    >
                      <ArrowUp className="w-3.5 h-3.5 text-amber-400 shrink-0" aria-hidden="true" />
                      <span className="truncate">{junction.forward.link.text || 'Forward'}</span>
                    </button>
                  )}

                  {junction.right && (
                    <button
                      type="button"
                      disabled={controlsDisabled}
                      onClick={() => onNavigateToLink(junction.right!.link)}
                      data-testid="dir-right-btn"
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/8 hover:bg-white/16 border border-white/10 text-xs text-slate-100 transition-colors max-w-[155px]"
                      title={`Glide Right onto ${junction.right.link.text || 'connected street'}`}
                    >
                      <CornerUpRight className="w-3.5 h-3.5 text-amber-400 shrink-0" aria-hidden="true" />
                      <span className="truncate">{junction.right.link.text || 'Right'}</span>
                    </button>
                  )}

                  {junction.reverse && (
                    <button
                      type="button"
                      disabled={controlsDisabled}
                      onClick={() => onNavigateToLink(junction.reverse!.link)}
                      data-testid="dir-reverse-btn"
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/6 hover:bg-white/14 border border-white/10 text-xs text-slate-300 transition-colors max-w-[140px]"
                      title={`Turn around toward ${junction.reverse.link.text || 'previous road'}`}
                    >
                      <ArrowDown className="w-3.5 h-3.5 text-sky-400 shrink-0" aria-hidden="true" />
                      <span className="truncate">Reverse</span>
                    </button>
                  )}

                  {!junction.left && !junction.forward && !junction.right && !junction.reverse && (
                    <span className="text-xs text-slate-400">
                      No connected links at this viewpoint.
                    </span>
                  )}
                </div>
              </div>

              {/* 3. Desktop & Touch Driving Controls */}
              <div className="flex flex-wrap items-center justify-between lg:justify-end gap-1.5 shrink-0">
                {/* Steer L / R */}
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={controlsDisabled}
                    {...steerLeftProps}
                    aria-label="Steer left"
                    title="Steer Left (A)"
                    className="min-w-[44px] min-h-[44px] px-2.5 rounded-xl bg-white/8 hover:bg-white/16 active:bg-amber-500 active:text-slate-950 border border-white/10 text-slate-100 flex items-center justify-center transition-colors disabled:opacity-40"
                  >
                    <ArrowLeft className="w-4 h-4" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    disabled={controlsDisabled}
                    {...steerRightProps}
                    aria-label="Steer right"
                    title="Steer Right (D)"
                    className="min-w-[44px] min-h-[44px] px-2.5 rounded-xl bg-white/8 hover:bg-white/16 active:bg-amber-500 active:text-slate-950 border border-white/10 text-slate-100 flex items-center justify-center transition-colors disabled:opacity-40"
                  >
                    <ArrowRight className="w-4 h-4" aria-hidden="true" />
                  </button>
                </div>

                {/* Gear + Auto-Drive */}
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={controlsDisabled}
                    onClick={() => onSetGear(telemetry.gear === 'R' ? 'D' : 'R')}
                    aria-pressed={telemetry.gear === 'R'}
                    aria-label="Toggle Reverse Gear"
                    title="Toggle Drive / Reverse (R)"
                    className={`min-h-[44px] px-2.5 rounded-xl border text-xs font-semibold flex items-center gap-1 transition-colors whitespace-nowrap disabled:opacity-40 ${
                      telemetry.gear === 'R'
                        ? 'bg-sky-500 text-slate-950 border-sky-400'
                        : 'bg-white/8 hover:bg-white/14 border-white/10 text-slate-200'
                    }`}
                  >
                    <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>{telemetry.gear === 'R' ? 'Rev' : 'D'}</span>
                  </button>

                  <button
                    type="button"
                    disabled={controlsDisabled}
                    onClick={onToggleCruise}
                    aria-pressed={telemetry.cruiseEnabled}
                    aria-label="Toggle Auto-Drive Slow Glide"
                    title="Auto-Drive Continuous Slow Glide (C)"
                    data-testid="auto-drive-btn"
                    className={`min-h-[44px] px-2.5 rounded-xl border text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap disabled:opacity-40 ${
                      telemetry.cruiseEnabled
                        ? 'bg-emerald-500 text-slate-950 border-emerald-400'
                        : 'bg-white/8 hover:bg-white/14 border-white/10 text-slate-200'
                    }`}
                  >
                    {telemetry.cruiseEnabled ? (
                      <Square className="w-3 h-3 fill-current" aria-hidden="true" />
                    ) : (
                      <Play className="w-3 h-3 fill-current" aria-hidden="true" />
                    )}
                    <span className="hidden sm:inline">
                      {telemetry.cruiseEnabled ? 'Stop Auto' : 'Auto'}
                    </span>
                  </button>
                </div>

                {/* Stop / Brake / Hold-to-Drive */}
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={controlsDisabled}
                    {...stopProps}
                    aria-label="Stop"
                    title="Stop (Space)"
                    className="min-w-[44px] min-h-[44px] px-2.5 rounded-xl bg-white/8 hover:bg-rose-500/30 active:bg-rose-500 border border-white/10 text-slate-100 flex items-center justify-center transition-colors disabled:opacity-40"
                  >
                    <OctagonX className="w-4 h-4" aria-hidden="true" />
                  </button>

                  <button
                    type="button"
                    disabled={controlsDisabled}
                    {...brakeProps}
                    aria-label="Slow down / Brake"
                    title="Brake (S)"
                    className="min-h-[44px] px-3 rounded-xl bg-white/10 hover:bg-white/18 active:bg-rose-500/80 border border-white/12 text-xs font-semibold text-slate-100 transition-colors whitespace-nowrap disabled:opacity-40"
                  >
                    Brake
                  </button>

                  <button
                    type="button"
                    disabled={controlsDisabled}
                    {...driveProps}
                    aria-label="Hold to glide forward slowly"
                    title="Hold Drive or W to move forward slowly"
                    data-testid="drive-btn"
                    className="min-h-[44px] px-4 rounded-xl bg-amber-500 hover:bg-amber-400 active:bg-amber-300 text-slate-950 text-xs font-bold tracking-wide transition-colors whitespace-nowrap disabled:opacity-40"
                  >
                    Hold Drive
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}

        <p className="hidden sm:block text-[11px] text-slate-300/90 bg-[#0B0E14]/75 px-3 py-0.5 rounded-md border border-white/8">
          Hold W / Drive to Move Slowly · C Auto-Glide · A/D Steer · Q/E Turn · R Reverse · Space Stop · Drag to Look 360°
        </p>
      </footer>
    </div>
  );
};
