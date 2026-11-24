import React, { useEffect } from 'react';
import { APIProvider, useMapsLibrary } from '@vis.gl/react-google-maps';
import { Dashboard } from '../components/Dashboard/Dashboard';
import { MapsJsStreetViewBridge } from '../engine/MapsJsStreetViewBridge';
import { useDrivingSimulator } from '../hooks/useDrivingSimulator';
import type { PanoramaMetadata } from '../types/streetview';

const MAPS_JS_API_KEY = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '').trim();

interface MapsJsStreetViewMountProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  onBridgeReady: (bridge: MapsJsStreetViewBridge | null) => void;
  onPanoramaLoaded: (metadata: PanoramaMetadata, alignHeading: boolean) => void;
  onPovChanged: (heading: number, pitch: number) => void;
  onUserNavigatedPano: (metadata: PanoramaMetadata) => void;
}

const MapsJsStreetViewMount: React.FC<MapsJsStreetViewMountProps> = ({
  containerRef,
  onBridgeReady,
  onPanoramaLoaded,
  onPovChanged,
  onUserNavigatedPano,
}) => {
  const streetViewLib = useMapsLibrary('streetView');

  useEffect(() => {
    const container = containerRef.current;
    if (!streetViewLib || !container) return;

    const bridge = new MapsJsStreetViewBridge(container, streetViewLib, {
      onPanoramaLoaded,
      onPovChanged,
      onUserNavigatedPano,
    });
    onBridgeReady(bridge);

    return () => {
      onBridgeReady(null);
      bridge.dispose();
    };
  }, [
    containerRef,
    streetViewLib,
    onBridgeReady,
    onPanoramaLoaded,
    onPovChanged,
    onUserNavigatedPano,
  ]);

  return null;
};

const RealStreetViewDriveInner: React.FC = () => {
  const sim = useDrivingSimulator();
  const isMapsJsMode = sim.renderBackend === 'maps-js';

  return (
    <main
      className="relative w-screen h-screen overflow-hidden bg-[#0B0E14]"
      data-simulator-state={
        sim.error
          ? 'error'
          : sim.isInitializing
            ? 'initializing'
            : sim.transition.isTransitioning
              ? 'transitioning'
              : 'ready'
      }
      data-pano-id={sim.currentMetadata?.panoId || ''}
      data-render-backend={sim.renderBackend}
      data-vehicle-type={sim.vehicleType}
    >
      {/* Continuous GPU forward-rush & lateral swerve wrapper around real Street View */}
      <div
        ref={sim.viewportMotionRef}
        className="absolute inset-0 w-full h-full will-change-transform"
      >
        {/* Primary Three.js WebGL spherical tile renderer container */}
        <div
          ref={sim.canvasContainerRef}
          className={`absolute inset-0 w-full h-full cursor-grab active:cursor-grabbing ${
            isMapsJsMode ? 'hidden' : 'block'
          }`}
          data-testid="panorama-viewport"
        />

        {/* Official Google Maps JavaScript API StreetViewPanorama fallback container */}
        <div
          ref={sim.mapsJsContainerRef}
          className={`absolute inset-0 w-full h-full ${isMapsJsMode ? 'block' : 'hidden'}`}
          data-testid="maps-js-panorama-viewport"
        />
      </div>

      {/* Transparent Three.js 3D Sports Car / 3D Motorcycle Chase Overlay */}
      <div
        ref={sim.vehicleContainerRef}
        className="pointer-events-none absolute inset-0 z-[5] w-full h-full"
        data-testid="vehicle-overlay"
        data-vehicle-type={sim.vehicleType}
      />

      {isMapsJsMode && MAPS_JS_API_KEY.length > 0 && (
        <MapsJsStreetViewMount
          containerRef={sim.mapsJsContainerRef}
          onBridgeReady={sim.attachMapsJsBridge}
          onPanoramaLoaded={sim.handleMetadataLoaded}
          onPovChanged={sim.handleMapsJsPovChanged}
          onUserNavigatedPano={sim.handleMapsJsUserNavigated}
        />
      )}

      <Dashboard
        renderBackend={sim.renderBackend}
        vehicleType={sim.vehicleType}
        currentMetadata={sim.currentMetadata}
        telemetry={sim.telemetry}
        transition={sim.transition}
        rankedNeighbours={sim.rankedNeighbours}
        deadEndStatus={sim.deadEndStatus}
        history={sim.history}
        graphNodes={sim.graphNodes}
        graphEdges={sim.graphEdges}
        quality={sim.quality}
        isInitializing={sim.isInitializing}
        error={sim.error}
        coverageNotice={sim.coverageNotice}
        quotaExceeded={sim.quotaExceeded}
        onInputChange={sim.setDrivingInput}
        onChangeVehicleType={sim.setVehicleType}
        onSetGear={sim.setGear}
        onStepDirection={sim.stepDirection}
        onSelectEdge={sim.selectConnectedEdge}
        onLoadLocation={sim.loadLocation}
        onAutocomplete={sim.searchAutocomplete}
        onSearchText={sim.searchPlacesText}
        onSelectSuggestion={sim.selectPlaceSuggestion}
        onSelectPlace={sim.selectPlaceResult}
        onLocateDevice={sim.locateCurrentDevice}
        onRecenter={sim.recenterHorizon}
        onTogglePointerLock={sim.togglePointerLock}
        onChangeQuality={sim.changeQuality}
        onRetry={sim.retryConnection}
        onDismissError={sim.dismissError}
        onDismissNotice={sim.dismissNotice}
      />
    </main>
  );
};

export const RealStreetViewDriveApp: React.FC = () => {
  if (MAPS_JS_API_KEY.length > 0) {
    return (
      <APIProvider apiKey={MAPS_JS_API_KEY} language="en" region="US">
        <RealStreetViewDriveInner />
      </APIProvider>
    );
  }
  return <RealStreetViewDriveInner />;
};

export default RealStreetViewDriveApp;
