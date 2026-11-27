import React, { useEffect } from 'react';
import { APIProvider, useMapsLibrary } from '@vis.gl/react-google-maps';
import { StreetViewHUD } from './StreetViewHUD';
import { useStreetViewEngine } from './useStreetViewEngine';

const MAPS_JS_API_KEY = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '').trim();

const MapsJsStreetViewBridge: React.FC<{
  active: boolean;
  onLibraryReady: (lib: google.maps.StreetViewLibrary | null) => void;
}> = ({ active, onLibraryReady }) => {
  const streetViewLib = useMapsLibrary('streetView');

  useEffect(() => {
    if (!active || !streetViewLib) {
      onLibraryReady(null);
      return;
    }
    onLibraryReady(streetViewLib);
    return () => {
      onLibraryReady(null);
    };
  }, [active, streetViewLib, onLibraryReady]);

  return null;
};

const StreetViewEngineShell: React.FC = () => {
  const engine = useStreetViewEngine();

  const simulatorState = engine.error
    ? 'error'
    : engine.isInitializing
      ? 'initializing'
      : 'ready';

  return (
    <main
      className="relative w-screen h-screen overflow-hidden bg-[#0B0E14] text-slate-100"
      data-simulator-state={simulatorState}
      data-engine="street-view-driving-engine"
      data-motion-mode="continuous-optical-glide"
      data-pace={engine.telemetry.pace}
      data-glide-progress={engine.telemetry.progressToNext.toFixed(3)}
      data-render-backend={engine.renderBackend}
      data-pano-id={engine.currentMetadata?.panoId ?? ''}
      data-displayed-buffer={engine.bufferMonitor.displayedBuffer}
      data-swap-count={engine.bufferMonitor.swapCount}
      data-locating={engine.isLocating ? 'true' : 'false'}
    >
      {/* Layer 4A: Three.js 360° Projective Street-Corridor Continuous-Glide Renderer */}
      <div
        ref={engine.canvasContainerRef}
        className={`absolute inset-0 w-full h-full ${
          engine.renderBackend === 'tiles'
            ? 'z-10 opacity-100 pointer-events-auto'
            : 'z-0 opacity-0 pointer-events-none'
        }`}
      />

      {/* Layer 4B: Dual-Buffer C1-Continuous Optical-Flow Street View Renderer */}
      <div
        ref={engine.mapsJsContainerRef}
        data-testid="maps-js-double-buffer"
        className={`absolute inset-0 w-full h-full ${
          engine.renderBackend === 'maps-js'
            ? 'z-10 opacity-100 pointer-events-auto'
            : 'z-0 opacity-0 pointer-events-none'
        }`}
      />

      {MAPS_JS_API_KEY && (
        <MapsJsStreetViewBridge
          active={engine.renderBackend === 'maps-js'}
          onLibraryReady={engine.attachMapsJsRenderer}
        />
      )}

      {/* Layer 5: Virtual Driving HUD & Controls */}
      <StreetViewHUD
        renderBackend={engine.renderBackend}
        currentMetadata={engine.currentMetadata}
        telemetry={engine.telemetry}
        junction={engine.junction}
        bufferMonitor={engine.bufferMonitor}
        history={engine.history}
        knownMetadata={engine.knownMetadata}
        allLinks={engine.allLinks}
        quality={engine.quality}
        isInitializing={engine.isInitializing}
        isLocating={engine.isLocating}
        error={engine.error}
        coverageNotice={engine.coverageNotice}
        quotaExceeded={engine.quotaExceeded}
        onSetInput={engine.setCarInput}
        onSetGear={engine.setGear}
        onSetPace={engine.setPace}
        onToggleReverse={engine.toggleReverse}
        onToggleCruise={engine.toggleCruise}
        onNavigateDirection={engine.navigateDirection}
        onNavigateToLink={engine.navigateToLink}
        onSelectLocation={engine.loadLocation}
        onAutocomplete={engine.handleAutocomplete}
        onSearchText={engine.handleSearchText}
        onSelectSuggestion={engine.handleSelectSuggestion}
        onSelectPlace={engine.handleSelectPlace}
        onLocateDevice={engine.locateCurrentDevice}
        onRecenter={engine.recenterHorizon}
        onChangeQuality={engine.changeQuality}
        onRetry={engine.retryConnection}
        onDismissError={engine.dismissError}
        onDismissNotice={engine.dismissNotice}
      />
    </main>
  );
};

export const StreetViewEngineMain: React.FC = () => {
  if (MAPS_JS_API_KEY) {
    return (
      <APIProvider
        apiKey={MAPS_JS_API_KEY}
        libraries={['streetView']}
        language="en"
        region="US"
      >
        <StreetViewEngineShell />
      </APIProvider>
    );
  }
  return <StreetViewEngineShell />;
};

export default StreetViewEngineMain;
