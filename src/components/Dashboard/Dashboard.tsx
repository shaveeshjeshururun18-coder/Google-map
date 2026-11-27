import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Bike,
  Car,
  ChevronDown,
  ChevronUp,
  Compass,
  Eye,
  Globe,
  Map as MapIcon,
  Maximize2,
  Minimize2,
  Navigation,
  RefreshCw,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import type {
  DeadEndStatus,
  DriveMode,
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
} from '../../types/streetview';
import { formatCoordinates } from '../../utils/geo';
import { DrivingControls } from '../DrivingControls/DrivingControls';
import { LoadingIndicator } from '../LoadingIndicator/LoadingIndicator';
import { LocationSearch } from '../LocationSearch/LocationSearch';
import { MiniMap } from '../MiniMap/MiniMap';
import { Speedometer } from '../Speedometer/Speedometer';

interface DashboardProps {
  driveMode: DriveMode;
  world3dAvailable: boolean;
  world3dLabel: string;
  world3dCoords: { lat: number; lng: number };
  renderBackend?: 'tiles' | 'maps-js';
  vehicleType: VehicleType;
  soundMuted: boolean;
  currentMetadata: PanoramaMetadata | null;
  telemetry: DrivingTelemetry;
  transition: TransitionState;
  rankedNeighbours: RankedNeighbour[];
  deadEndStatus: DeadEndStatus;
  history: NavigationHistoryEntry[];
  graphNodes: PanoramaNode[];
  graphEdges: PanoramaEdge[];
  quality: QualityPreset;
  isInitializing: boolean;
  error: SimulatorError | null;
  coverageNotice: string | null;
  quotaExceeded: boolean;
  onChangeDriveMode: (mode: DriveMode) => void;
  onInputChange: <K extends keyof DrivingInputState>(key: K, active: boolean) => void;
  onChangeVehicleType: (type: VehicleType) => void;
  onToggleCruise: () => void;
  onToggleSound: () => void;
  onSetGear: (gear: GearMode) => void;
  onStepDirection: (direction: 'forward' | 'left' | 'right' | 'reverse') => void;
  onSelectEdge: (edge: PanoramaEdge) => void;
  onLoadLocation: (lat: number, lng: number, label?: string) => Promise<void>;
  onAutocomplete: (query: string, signal?: AbortSignal) => Promise<PlaceSuggestion[]>;
  onSearchText: (query: string, signal?: AbortSignal) => Promise<PlaceResult[]>;
  onSelectSuggestion: (suggestion: PlaceSuggestion) => Promise<void>;
  onSelectPlace: (place: PlaceResult) => Promise<void>;
  onLocateDevice: () => void;
  onRecenter: () => void;
  onTogglePointerLock: () => void;
  onChangeQuality: (quality: QualityPreset) => void;
  onRetry: () => void;
  onDismissError: () => void;
  onDismissNotice: () => void;
}

export const Dashboard: React.FC<DashboardProps> = ({
  driveMode,
  world3dAvailable,
  world3dLabel,
  world3dCoords,
  renderBackend = 'tiles',
  vehicleType,
  soundMuted,
  currentMetadata,
  telemetry,
  transition,
  rankedNeighbours,
  deadEndStatus,
  history,
  graphNodes,
  graphEdges,
  quality,
  isInitializing,
  error,
  coverageNotice,
  quotaExceeded,
  onChangeDriveMode,
  onInputChange,
  onChangeVehicleType,
  onToggleCruise,
  onToggleSound,
  onSetGear,
  onStepDirection,
  onSelectEdge,
  onLoadLocation,
  onAutocomplete,
  onSearchText,
  onSelectSuggestion,
  onSelectPlace,
  onLocateDevice,
  onRecenter,
  onTogglePointerLock,
  onChangeQuality,
  onRetry,
  onDismissError,
  onDismissNotice,
}) => {
  const [hudCollapsed, setHudCollapsed] = useState(false);
  const [miniMapOpen, setMiniMapOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // Keyboard shortcuts H (toggle HUD) and M (toggle MiniMap)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLElement &&
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)
      ) {
        return;
      }
      if (event.code === 'KeyH') {
        setHudCollapsed((prev) => !prev);
      } else if (event.code === 'KeyM') {
        setMiniMapOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      // Fullscreen may be restricted in iframe environments
    }
  };

  const is3DWorld = driveMode === '3d-world';
  const hasLoadedPanorama = is3DWorld ? !isInitializing : Boolean(currentMetadata);
  const showBlockingError = Boolean(error) && !hasLoadedPanorama;

  return (
    <div className="pointer-events-none fixed inset-0 z-10 flex flex-col justify-between">
      {/* Mandatory Demo Key Quota Banner (Google Maps Platform Section 8 Case A) */}
      {quotaExceeded && (
        <div className="pointer-events-auto bg-amber-50 border-b border-amber-200 text-amber-900 px-4 py-2.5 text-xs md:text-sm text-center sticky top-0 z-50 shadow-sm">
          <span>
            Google Maps Platform quota reached. If you are the app owner, visit{' '}
            <a
              href="https://developers.google.com/maps/ai/ai-studio?utm_campaign=gmp_mcp_codeassist_v1_aistudio#quota_exceeded_errors"
              target="_blank"
              rel="noopener noreferrer"
              className="underline font-semibold text-amber-950 hover:text-amber-800"
            >
              maps developer site
            </a>{' '}
            for instructions to update your account.
          </span>
        </div>
      )}

      {/* Top Cockpit Bar: Brand + Location Search + Utility Actions */}
      <header className="pointer-events-auto w-full px-3 sm:px-5 pt-2.5 sm:pt-3 pb-3 flex flex-wrap sm:flex-nowrap items-center justify-between gap-2 sm:gap-3 bg-gradient-to-b from-[#0B0E14]/95 via-[#0B0E14]/72 to-transparent">
        {/* Left: Brand & Live Street Label */}
        <div className="min-w-0 flex flex-col order-1">
          <h1 className="font-instrument text-sm sm:text-base font-bold tracking-tight text-slate-50 whitespace-nowrap">
            Real Street View Drive
          </h1>
          {is3DWorld ? (
            <div
              className="flex items-center gap-1.5 text-xs text-slate-200 truncate max-w-[200px] sm:max-w-[340px]"
              data-testid="current-location-label"
            >
              <span className="font-semibold text-cyan-300 truncate">{world3dLabel}</span>
              <span className="text-slate-400 hidden lg:inline" aria-hidden="true">·</span>
              <span className="font-telemetry text-[11px] text-slate-200 hidden lg:inline whitespace-nowrap">
                {formatCoordinates(world3dCoords.lat, world3dCoords.lng)}
              </span>
            </div>
          ) : currentMetadata ? (
            <div
              className="flex items-center gap-1.5 text-xs text-slate-200 truncate max-w-[200px] sm:max-w-[340px]"
              data-testid="current-location-label"
            >
              <span className="font-semibold text-amber-300 truncate">
                {currentMetadata.streetName}
              </span>
              {currentMetadata.date && (
                <>
                  <span className="text-slate-400 hidden sm:inline" aria-hidden="true">·</span>
                  <span className="text-slate-200 hidden sm:inline whitespace-nowrap">
                    {currentMetadata.date}
                  </span>
                </>
              )}
              <span className="text-slate-400 hidden lg:inline" aria-hidden="true">·</span>
              <span className="font-telemetry text-[11px] text-slate-200 hidden lg:inline whitespace-nowrap">
                {formatCoordinates(currentMetadata.lat, currentMetadata.lng)}
              </span>
            </div>
          ) : (
            <span className="text-xs text-slate-300 whitespace-nowrap">
              {isInitializing ? 'Loading real world...' : 'Ready to connect'}
            </span>
          )}
        </div>

        {/* Center: Official Places Location Search */}
        <div className="order-3 sm:order-2 w-full sm:w-auto sm:flex-1 flex justify-center sm:max-w-md">
          <LocationSearch
            onAutocomplete={onAutocomplete}
            onSearchText={onSearchText}
            onSelectSuggestion={onSelectSuggestion}
            onSelectPlace={onSelectPlace}
            onLocateDevice={onLocateDevice}
            disabled={error?.code === 'MISSING_API_KEY' || error?.code === 'WEBGL_UNAVAILABLE'}
          />
        </div>

        {/* Right: Concise Utility Actions */}
        <div className="flex items-center gap-1.5 shrink-0 order-2 sm:order-3">
          {/* Drive Mode Switcher: Continuous 3D World vs Street View */}
          {world3dAvailable && (
            <div
              className="flex items-center h-9 p-0.5 rounded-lg bg-[#0B0E14]/90 border border-white/12 shrink-0"
              role="group"
              aria-label="Driving world mode selector"
              data-testid="drive-mode-switcher"
            >
              <button
                type="button"
                onClick={() => onChangeDriveMode('3d-world')}
                aria-pressed={driveMode === '3d-world'}
                aria-label="Continuous 3D World Mode (G)"
                title="Continuous 3D World — Zero transitions, 320 km/h (G)"
                className={`h-full px-2 rounded-md text-xs font-medium flex items-center gap-1 transition-colors whitespace-nowrap ${
                  driveMode === '3d-world'
                    ? 'bg-cyan-400 text-slate-950 font-semibold'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                <Globe className="w-3.5 h-3.5" aria-hidden="true" />
                <span className="hidden md:inline">3D World</span>
                <span className="md:hidden">3D</span>
              </button>
              <button
                type="button"
                onClick={() => onChangeDriveMode('street-view')}
                aria-pressed={driveMode === 'street-view'}
                aria-label="Street View Panorama Mode (G)"
                title="Street View 360° Mode (G)"
                className={`h-full px-2 rounded-md text-xs font-medium flex items-center gap-1 transition-colors whitespace-nowrap ${
                  driveMode === 'street-view'
                    ? 'bg-amber-500 text-slate-950 font-semibold'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                <span className="hidden md:inline">Street View</span>
                <span className="md:hidden">SV</span>
              </button>
            </div>
          )}
          {/* 3D Vehicle Switcher: Sports Car / Sport Bike */}
          <div
            className="flex items-center h-9 p-0.5 rounded-lg bg-[#0B0E14]/90 border border-white/12 shrink-0"
            role="group"
            aria-label="3D vehicle selector"
            data-testid="vehicle-switcher"
          >
            <button
              type="button"
              onClick={() => onChangeVehicleType('car')}
              aria-pressed={vehicleType === 'car'}
              aria-label="Drive 3D Car (V)"
              title="3D Car (V)"
              className={`h-full px-2 rounded-md text-xs font-medium flex items-center gap-1 transition-colors whitespace-nowrap ${
                vehicleType === 'car'
                  ? 'bg-amber-500 text-slate-950 font-semibold'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              <Car className="w-3.5 h-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Car</span>
            </button>
            <button
              type="button"
              onClick={() => onChangeVehicleType('bike')}
              aria-pressed={vehicleType === 'bike'}
              aria-label="Ride 3D Bike (V)"
              title="3D Bike (V)"
              className={`h-full px-2 rounded-md text-xs font-medium flex items-center gap-1 transition-colors whitespace-nowrap ${
                vehicleType === 'bike'
                  ? 'bg-amber-500 text-slate-950 font-semibold'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              <Bike className="w-3.5 h-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Bike</span>
            </button>
          </div>

          <button
            type="button"
            onClick={onToggleSound}
            aria-label={soundMuted ? 'Unmute engine audio' : 'Mute engine audio'}
            aria-pressed={!soundMuted}
            title={soundMuted ? 'Unmute Engine Sound' : 'Mute Engine Sound'}
            className={`h-9 w-9 rounded-lg border flex items-center justify-center transition-colors shrink-0 ${
              soundMuted
                ? 'bg-[#0B0E14]/90 border-white/12 text-slate-400 hover:text-white'
                : 'bg-[#0B0E14]/90 border-amber-400/35 text-amber-300 hover:bg-white/10'
            }`}
          >
            {soundMuted ? (
              <VolumeX className="w-4 h-4" aria-hidden="true" />
            ) : (
              <Volume2 className="w-4 h-4" aria-hidden="true" />
            )}
          </button>

          {!is3DWorld && renderBackend === 'tiles' && (
            <>
              <label htmlFor="tile-quality-select" className="sr-only">
                Panorama tile resolution quality
              </label>
              <select
                id="tile-quality-select"
                value={quality}
                onChange={(e) => onChangeQuality(e.target.value as QualityPreset)}
                aria-label="Panorama resolution quality"
                className="hidden md:block h-9 px-2.5 rounded-lg bg-[#0B0E14]/90 border border-white/12 text-xs text-slate-200 focus:border-amber-400"
              >
                <option value="fast">Fast (z1)</option>
                <option value="balanced">Balanced (z2)</option>
                <option value="high">High (z3)</option>
              </select>
            </>
          )}

          <button
            type="button"
            onClick={() => setMiniMapOpen((prev) => !prev)}
            aria-label={miniMapOpen ? 'Hide Mini-Map' : 'Show Mini-Map'}
            aria-expanded={miniMapOpen}
            title="Toggle Mini-Map (M)"
            className={`h-9 px-2.5 rounded-lg border text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
              miniMapOpen
                ? 'bg-amber-500/20 border-amber-400/70 text-amber-200'
                : 'bg-[#0B0E14]/90 border-white/12 text-slate-200 hover:bg-white/10'
            }`}
          >
            <MapIcon className="w-4 h-4" aria-hidden="true" />
            <span className="hidden sm:inline">Map</span>
          </button>

          <button
            type="button"
            onClick={onRecenter}
            aria-label="Recenter camera view on road"
            title="Recenter view on road"
            className="hidden sm:flex h-9 w-9 rounded-lg bg-[#0B0E14]/90 border border-white/12 text-slate-200 hover:bg-white/10 items-center justify-center transition-colors shrink-0"
          >
            <Compass className="w-4 h-4" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={onTogglePointerLock}
            aria-label="Toggle free-look pointer lock"
            title="Free-look pointer lock"
            className="hidden lg:flex h-9 w-9 rounded-lg bg-[#0B0E14]/90 border border-white/12 text-slate-200 hover:bg-white/10 items-center justify-center transition-colors shrink-0"
          >
            <Eye className="w-4 h-4" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={() => void toggleFullscreen()}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            title="Toggle Fullscreen"
            className="h-9 w-9 rounded-lg bg-[#0B0E14]/90 border border-white/12 text-slate-200 hover:bg-white/10 flex items-center justify-center transition-colors shrink-0"
          >
            {isFullscreen ? (
              <Minimize2 className="w-4 h-4" aria-hidden="true" />
            ) : (
              <Maximize2 className="w-4 h-4" aria-hidden="true" />
            )}
          </button>
        </div>
      </header>

      {/* Middle Area: Unobstructed 360° Viewport + Contextual Banners / MiniMap / Blocking Error */}
      <div className="relative flex-1 flex flex-col items-center justify-start px-4 pt-2 pointer-events-none">
        {/* Loading indicator (only shown on startup or location teleport — never during driving) */}
        <LoadingIndicator
          transition={transition}
          isInitializing={isInitializing}
          hasLoadedPanorama={hasLoadedPanorama}
        />

        {/* Coverage Warning / Dead End Notice */}
        {(coverageNotice || (!is3DWorld && hasLoadedPanorama && deadEndStatus.isDeadEnd)) && (
          <div
            role="status"
            data-testid="coverage-warning"
            className="pointer-events-auto mt-2 flex items-center gap-2.5 bg-[#0B0E14]/92 border border-amber-400/40 rounded-lg px-3.5 py-2 text-xs text-amber-200 max-w-lg shadow-lg"
          >
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
            <span className="leading-snug">
              {coverageNotice ||
                'Street coverage ends in this direction. Turn around or pick an available linked street.'}
            </span>
            {coverageNotice && (
              <button
                type="button"
                onClick={onDismissNotice}
                aria-label="Dismiss coverage notice"
                className="p-1 text-amber-300/80 hover:text-amber-100 shrink-0"
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        )}

        {/* Non-blocking error toast when panorama is already active */}
        {error && hasLoadedPanorama && (
          <div
            role="alert"
            data-testid="error-banner"
            className="pointer-events-auto mt-2 flex items-start gap-3 bg-[#0B0E14]/95 border border-rose-500/40 rounded-lg px-4 py-3 text-xs text-slate-100 max-w-lg shadow-xl"
          >
            <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" aria-hidden="true" />
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-rose-200">{error.title}</div>
              <p className="text-slate-300 mt-0.5 leading-relaxed">{error.message}</p>
              {error.suggestedLocation && (
                <button
                  type="button"
                  onClick={() =>
                    void onLoadLocation(
                      error.suggestedLocation!.lat,
                      error.suggestedLocation!.lng,
                      error.suggestedLocation!.label,
                    )
                  }
                  className="mt-2 px-3 py-1.5 rounded-md bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold transition-colors whitespace-nowrap"
                >
                  Drive to nearest covered street ({error.suggestedLocation.label})
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={onDismissError}
              aria-label="Dismiss error message"
              className="p-1 text-slate-400 hover:text-white shrink-0"
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
        )}

        {/* Blocking Configuration / Startup Error Screen (never fakes imagery!) */}
        {showBlockingError && error && (
          <div
            role="alert"
            data-testid="blocking-error-screen"
            className="pointer-events-auto my-auto w-full max-w-lg bg-[#0E131C] border border-white/14 rounded-xl p-6 shadow-2xl"
          >
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400 mt-0.5 shrink-0" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <h2 className="font-instrument text-lg font-bold text-slate-50">
                  {error.title}
                </h2>
                <p className="text-sm text-slate-300 mt-2 leading-relaxed">
                  {error.message}
                </p>

                {error.code === 'MISSING_API_KEY' && (
                  <div className="mt-4 pt-4 border-t border-white/10 text-xs text-slate-400 space-y-1.5">
                    <p className="text-slate-200 font-medium">Required Google Maps Platform setup:</p>
                    <p>1. Enable Map Tiles API (Street View Tiles) and Places API (New) in Google Cloud Console.</p>
                    <p>2. Configure GOOGLE_MAPS_API_KEY in your environment secrets and restart the server.</p>
                    <p>3. Real Street View Drive never substitutes fake scenery when real imagery is unavailable.</p>
                  </div>
                )}

                <div className="mt-5 flex items-center gap-2.5 flex-wrap">
                  {error.suggestedLocation && (
                    <button
                      type="button"
                      onClick={() =>
                        void onLoadLocation(
                          error.suggestedLocation!.lat,
                          error.suggestedLocation!.lng,
                          error.suggestedLocation!.label,
                        )
                      }
                      className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold transition-colors flex items-center gap-1.5 whitespace-nowrap"
                    >
                      <Navigation className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Go to {error.suggestedLocation.label}</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={onRetry}
                    className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/18 border border-white/12 text-slate-100 text-xs font-semibold transition-colors flex items-center gap-1.5 whitespace-nowrap"
                  >
                    <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Retry Connection</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Right-aligned collapsible Mini-Map drawer */}
        {miniMapOpen && hasLoadedPanorama && (
          <div className="absolute right-3 sm:right-5 top-2 z-20">
            <MiniMap
              currentMetadata={
                is3DWorld
                  ? {
                      panoId: 'world-3d-live',
                      lat: world3dCoords.lat,
                      lng: world3dCoords.lng,
                      originalLat: world3dCoords.lat,
                      originalLng: world3dCoords.lng,
                      heading: telemetry.heading,
                      tilt: 0,
                      roll: 0,
                      imageWidth: 0,
                      imageHeight: 0,
                      tileWidth: 0,
                      tileHeight: 0,
                      copyright: 'Google Maps 3D',
                      reportProblemLink: '',
                      date: '',
                      imageryType: 'outdoor',
                      streetName: world3dLabel,
                      formattedLocation: world3dLabel,
                      links: [],
                    }
                  : currentMetadata
              }
              heading={telemetry.heading}
              nodes={graphNodes}
              edges={graphEdges}
              history={history}
              onSelectLocation={(lat, lng, label) => void onLoadLocation(lat, lng, label)}
              onClose={() => setMiniMapOpen(false)}
            />
          </div>
        )}
      </div>

      {/* Bottom Area: Collapsible Cockpit Dock + Mandatory Google Attribution */}
      <footer
        className={`w-full px-3 sm:px-5 flex flex-col items-center gap-2 pointer-events-none ${
          is3DWorld || renderBackend === 'maps-js' ? 'pb-7' : 'pb-3'
        }`}
      >
        {/* Collapse / Expand HUD toggle */}
        <button
          type="button"
          onClick={() => setHudCollapsed((prev) => !prev)}
          aria-expanded={!hudCollapsed}
          aria-label={hudCollapsed ? 'Show driving dashboard' : 'Hide driving dashboard'}
          className="pointer-events-auto px-3 py-1 rounded-t-lg bg-[#0B0E14]/90 border border-white/12 text-[11px] font-medium text-slate-300 hover:text-white flex items-center gap-1.5 transition-colors"
        >
          {hudCollapsed ? (
            <>
              <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Show Cockpit</span>
            </>
          ) : (
            <>
              <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Hide Cockpit</span>
            </>
          )}
        </button>

        {/* Unified Bottom Cockpit Dock (Zero Side-Flank Viewport Occlusion) */}
        {!hudCollapsed && (
          <section
            aria-label="Driving Simulator Dashboard"
            data-testid="cockpit-dock"
            className="pointer-events-auto w-full max-w-[980px] bg-[#0B0E14]/92 border border-white/12 rounded-xl px-4 py-3 shadow-2xl flex flex-col md:flex-row items-stretch md:items-center gap-4"
          >
            <div className="md:border-r md:border-white/10 md:pr-4 shrink-0">
              <Speedometer telemetry={telemetry} driveMode={driveMode} />
            </div>

            <div className="flex-1 min-w-0">
              <DrivingControls
                driveMode={driveMode}
                telemetry={telemetry}
                rankedNeighbours={rankedNeighbours}
                onInputChange={onInputChange}
                onSetGear={onSetGear}
                onToggleCruise={onToggleCruise}
                onStepDirection={onStepDirection}
                onSelectEdge={onSelectEdge}
                onSwitchToStreetView={() => onChangeDriveMode('street-view')}
                disabled={!hasLoadedPanorama}
              />
            </div>
          </section>
        )}

        {/* Bottom Legal & Keyboard Hint Row */}
        <div className="w-full max-w-[1400px] flex items-center justify-center gap-4 text-[11px] text-slate-200 px-1">
          <div className="hidden sm:flex items-center gap-2 pointer-events-none bg-[#0B0E14]/80 px-2.5 py-1 rounded border border-white/10 text-slate-200">
            <span>W/S Drive &amp; Brake</span>
            <span className="text-slate-500" aria-hidden="true">·</span>
            <span className="text-cyan-300 font-medium">Shift Turbo</span>
            <span className="text-slate-500" aria-hidden="true">·</span>
            <span>A/D Steer</span>
            <span className="text-slate-500" aria-hidden="true">·</span>
            <span>Q/E Swerve</span>
            <span className="text-slate-500" aria-hidden="true">·</span>
            <span>V Car/Bike</span>
            {world3dAvailable && (
              <>
                <span className="text-slate-500" aria-hidden="true">·</span>
                <span>G 3D/Street</span>
              </>
            )}
          </div>

          {!is3DWorld && renderBackend === 'tiles' && (
            <div
              className="pointer-events-auto ml-auto flex items-center gap-2 bg-[#0B0E14]/82 px-2.5 py-1 rounded border border-white/10 text-slate-300"
              data-testid="streetview-attribution"
            >
              <span>{currentMetadata?.copyright || 'Google Street View'}</span>
              {currentMetadata?.reportProblemLink && (
                <>
                  <span className="text-slate-500" aria-hidden="true">·</span>
                  <a
                    href={currentMetadata.reportProblemLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-slate-200 underline hover:text-amber-300 transition-colors whitespace-nowrap"
                  >
                    Report a problem with this image
                  </a>
                </>
              )}
            </div>
          )}
        </div>
      </footer>
    </div>
  );
};
