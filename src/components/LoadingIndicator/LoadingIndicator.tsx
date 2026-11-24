import React from 'react';
import { Loader2 } from 'lucide-react';
import type { TransitionState } from '../../types/streetview';

interface LoadingIndicatorProps {
  transition: TransitionState;
  isInitializing: boolean;
  hasLoadedPanorama?: boolean;
}

export const LoadingIndicator: React.FC<LoadingIndicatorProps> = ({
  transition,
  isInitializing,
  hasLoadedPanorama = false,
}) => {
  // Never interrupt rapid driving transitions with a loading bar once driving has started
  if (!isInitializing && (hasLoadedPanorama || !transition.isTransitioning)) {
    return null;
  }

  const pct =
    transition.tilesTotal > 0
      ? Math.min(100, Math.round((transition.tilesLoaded / transition.tilesTotal) * 100))
      : null;

  const label = isInitializing
    ? 'Connecting to Google Street View...'
    : transition.message || 'Loading panorama tiles...';

  return (
    <div
      className="pointer-events-none flex items-center gap-2.5 bg-[#0B0E14]/90 border border-white/12 rounded-lg px-3.5 py-2 text-xs text-slate-200 shadow-lg"
      role="status"
      aria-live="polite"
      data-testid="loading-indicator"
    >
      <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin shrink-0" aria-hidden="true" />
      <span className="whitespace-nowrap truncate max-w-[220px]">{label}</span>
      {pct !== null && (
        <>
          <span className="text-slate-600" aria-hidden="true">·</span>
          <span className="font-telemetry text-amber-300 shrink-0">{pct}%</span>
        </>
      )}
    </div>
  );
};
