import React from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CornerUpLeft,
  CornerUpRight,
  Eye,
  Flame,
  Gauge,
  OctagonX,
  RotateCcw,
} from 'lucide-react';
import {
  formatHeading,
  getRelativeDirectionLabel,
} from '../../navigation/DirectionCalculator';
import type {
  DriveMode,
  DrivingInputState,
  DrivingTelemetry,
  GearMode,
  PanoramaEdge,
  RankedNeighbour,
} from '../../types/streetview';

interface DrivingControlsProps {
  driveMode?: DriveMode;
  telemetry: DrivingTelemetry;
  rankedNeighbours: RankedNeighbour[];
  onInputChange: <K extends keyof DrivingInputState>(key: K, active: boolean) => void;
  onSetGear: (gear: GearMode) => void;
  onToggleCruise: () => void;
  onStepDirection: (direction: 'forward' | 'left' | 'right' | 'reverse') => void;
  onSelectEdge: (edge: PanoramaEdge) => void;
  onSwitchToStreetView?: () => void;
  disabled?: boolean;
}

export const DrivingControls: React.FC<DrivingControlsProps> = ({
  driveMode = 'street-view',
  telemetry,
  rankedNeighbours,
  onInputChange,
  onSetGear,
  onToggleCruise,
  onStepDirection,
  onSelectEdge,
  onSwitchToStreetView,
  disabled = false,
}) => {
  const holdProps = <K extends keyof DrivingInputState>(key: K) => ({
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      if (!disabled) onInputChange(key, true);
    },
    onPointerUp: () => onInputChange(key, false),
    onPointerLeave: () => onInputChange(key, false),
    onPointerCancel: () => onInputChange(key, false),
  });

  const activeTargetId = telemetry.targetEdge?.destinationPanoId ?? null;
  const is3DWorld = driveMode === '3d-world';

  return (
    <div className="flex flex-col gap-2.5 w-full">
      {/* Top Status / Connected Street Directions Row */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span className="font-instrument text-slate-100 text-sm font-semibold">
            {formatHeading(telemetry.heading)}
          </span>
          <span aria-hidden="true">·</span>
          <span>
            {is3DWorld
              ? 'Continuous 3D World · Zero Transitions'
              : rankedNeighbours.length === 0
                ? 'No linked roads'
                : `${rankedNeighbours.length} connected ${
                    rankedNeighbours.length === 1 ? 'path' : 'paths'
                  }`}
          </span>
        </div>

        {is3DWorld ? (
          onSwitchToStreetView && (
            <button
              type="button"
              onClick={onSwitchToStreetView}
              className="px-2.5 py-1 rounded-md text-xs font-medium bg-white/6 hover:bg-white/14 border border-white/12 text-slate-200 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
              title="Drop into Street View at current GPS coordinates (G)"
            >
              <Eye className="w-3.5 h-3.5 text-amber-300" aria-hidden="true" />
              <span>Drop into Street View</span>
            </button>
          )
        ) : (
          <div
            className="flex items-center gap-1.5 overflow-x-auto max-w-full pb-0.5"
            role="group"
            aria-label="Available connected street directions"
          >
            {rankedNeighbours.slice(0, 4).map((item) => {
              const isSelected = item.edge.destinationPanoId === activeTargetId;
              return (
                <button
                  key={item.edge.destinationPanoId}
                  type="button"
                  disabled={disabled}
                  onClick={() => onSelectEdge(item.edge)}
                  aria-label={`Drive ${getRelativeDirectionLabel(item.direction)} toward ${item.edge.text} at ${Math.round(item.edge.heading)} degrees`}
                  className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 border ${
                    isSelected
                      ? 'bg-amber-500/20 border-amber-400/70 text-amber-200'
                      : 'bg-white/5 border-white/10 text-slate-200 hover:bg-white/12'
                  } disabled:opacity-40`}
                >
                  {item.direction === 'left' || item.direction === 'slight-left' ? (
                    <CornerUpLeft className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  ) : item.direction === 'right' || item.direction === 'slight-right' ? (
                    <CornerUpRight className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  ) : item.direction === 'reverse' ? (
                    <RotateCcw className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  ) : (
                    <ArrowUp className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  )}
                  <span className="max-w-[130px] truncate">
                    {getRelativeDirectionLabel(item.direction)} · {item.edge.text}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Primary Steering, Gear, Cruise, and Pedal Controls (Desktop + Touch friendly >=44px) */}
      <div className="flex items-center justify-between gap-2 flex-wrap sm:flex-nowrap">
        {/* Left: Steering + Street View Intersection Turns */}
        <div className="flex items-center gap-1.5" role="group" aria-label="Steering controls">
          <button
            type="button"
            disabled={disabled}
            {...holdProps('steerLeft')}
            aria-label="Steer left (Hold A or Left Arrow)"
            title="Steer Left (A / Left)"
            className="min-w-[44px] h-11 px-3 rounded-lg bg-white/6 hover:bg-white/14 active:bg-amber-500/30 border border-white/12 text-slate-100 flex items-center justify-center gap-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 disabled:opacity-40"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden="true" />
            <span className="hidden md:inline">Left</span>
          </button>

          <button
            type="button"
            disabled={disabled}
            {...holdProps('steerRight')}
            aria-label="Steer right (Hold D or Right Arrow)"
            title="Steer Right (D / Right)"
            className="min-w-[44px] h-11 px-3 rounded-lg bg-white/6 hover:bg-white/14 active:bg-amber-500/30 border border-white/12 text-slate-100 flex items-center justify-center gap-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 disabled:opacity-40"
          >
            <span className="hidden md:inline">Right</span>
            <ArrowRight className="w-4 h-4" aria-hidden="true" />
          </button>

          {!is3DWorld && (
            <>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onStepDirection('left')}
                aria-label="Take connected left turn"
                title="Snap to left street"
                className="hidden lg:flex h-11 px-2.5 rounded-lg bg-white/4 hover:bg-white/12 border border-white/10 text-slate-300 items-center justify-center gap-1 text-xs whitespace-nowrap shrink-0 disabled:opacity-40"
              >
                <CornerUpLeft className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Turn L</span>
              </button>

              <button
                type="button"
                disabled={disabled}
                onClick={() => onStepDirection('right')}
                aria-label="Take connected right turn"
                title="Snap to right street"
                className="hidden lg:flex h-11 px-2.5 rounded-lg bg-white/4 hover:bg-white/12 border border-white/10 text-slate-300 items-center justify-center gap-1 text-xs whitespace-nowrap shrink-0 disabled:opacity-40"
              >
                <span>Turn R</span>
                <CornerUpRight className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </>
          )}
        </div>

        {/* Center: Drive / Reverse Gear + Cruise Toggle */}
        <div
          className="flex items-center gap-1.5 shrink-0"
          role="group"
          aria-label="Transmission gear and cruise selector"
        >
          <div className="flex items-center p-1 bg-white/5 border border-white/10 rounded-lg shrink-0">
            <button
              type="button"
              disabled={disabled}
              onClick={() => onSetGear('D')}
              aria-pressed={telemetry.gear === 'D'}
              className={`min-w-[44px] h-9 px-2.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                telemetry.gear === 'D'
                  ? 'bg-amber-500 text-slate-950'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              Drive
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onSetGear('R')}
              aria-pressed={telemetry.gear === 'R'}
              className={`min-w-[44px] h-9 px-2.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                telemetry.gear === 'R'
                  ? 'bg-sky-400 text-slate-950'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              Rev
            </button>
          </div>

          <button
            type="button"
            disabled={disabled}
            onClick={onToggleCruise}
            aria-pressed={telemetry.cruiseEnabled}
            aria-label={telemetry.cruiseEnabled ? 'Disable Cruise Control (C)' : 'Enable Cruise Control (C)'}
            title="Auto-Cruise (C)"
            data-testid="cruise-toggle"
            className={`min-w-[44px] h-11 px-2.5 rounded-lg border text-xs font-semibold flex items-center justify-center gap-1 transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 ${
              telemetry.cruiseEnabled
                ? 'bg-emerald-500/25 border-emerald-400/70 text-emerald-200'
                : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/12 hover:text-white'
            }`}
          >
            <Gauge className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">Cruise</span>
          </button>
        </div>

        {/* Right: Stop, Brake, Drive, Turbo Pedals */}
        <div className="flex items-center gap-1.5" role="group" aria-label="Throttle and brake pedals">
          <button
            type="button"
            disabled={disabled}
            {...holdProps('handbrake')}
            aria-label="Handbrake / Drift Stop (Space)"
            title="Handbrake / Drift (Space)"
            className="min-w-[44px] h-11 px-2.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 active:bg-rose-500/40 border border-rose-500/35 text-rose-200 flex items-center justify-center gap-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 disabled:opacity-40"
          >
            <OctagonX className="w-4 h-4" aria-hidden="true" />
            <span className="hidden lg:inline">Drift</span>
          </button>

          <button
            type="button"
            disabled={disabled}
            {...holdProps('brake')}
            aria-label="Brake (Hold S or Down Arrow)"
            title="Brake (S / Down)"
            className="min-w-[44px] h-11 px-3 rounded-lg bg-white/6 hover:bg-white/14 active:bg-rose-500/30 border border-white/12 text-slate-100 flex items-center justify-center gap-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 disabled:opacity-40"
          >
            <ArrowDown className="w-4 h-4" aria-hidden="true" />
            <span className="hidden sm:inline">Brake</span>
          </button>

          <button
            type="button"
            disabled={disabled}
            {...holdProps('accelerate')}
            aria-label="Accelerate (Hold W or Up Arrow)"
            title="Accelerate (W / Up)"
            className="min-w-[54px] h-11 px-3.5 rounded-lg bg-amber-500 hover:bg-amber-400 active:bg-amber-300 text-slate-950 flex items-center justify-center gap-1.5 text-xs font-bold transition-colors whitespace-nowrap shrink-0 disabled:opacity-40"
          >
            <ArrowUp className="w-4 h-4" aria-hidden="true" />
            <span>{telemetry.gear === 'R' ? 'Back' : 'Drive'}</span>
          </button>

          <button
            type="button"
            disabled={disabled || telemetry.gear === 'R'}
            {...holdProps('boost')}
            aria-label="Turbo Boost (Hold Shift)"
            title="Turbo Boost up to 320 km/h (Shift)"
            data-testid="turbo-button"
            className={`min-w-[48px] h-11 px-3 rounded-lg border flex items-center justify-center gap-1.5 text-xs font-bold transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 ${
              telemetry.isBoosting
                ? 'bg-cyan-400 border-cyan-300 text-slate-950 shadow-lg shadow-cyan-400/25'
                : 'bg-cyan-500/18 hover:bg-cyan-500/28 border-cyan-400/45 text-cyan-200'
            }`}
          >
            <Flame className="w-4 h-4" aria-hidden="true" />
            <span>Turbo</span>
          </button>
        </div>
      </div>
    </div>
  );
};
