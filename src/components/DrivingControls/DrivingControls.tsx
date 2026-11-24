import React from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CornerUpLeft,
  CornerUpRight,
  OctagonX,
  RotateCcw,
} from 'lucide-react';
import {
  formatHeading,
  getRelativeDirectionLabel,
} from '../../navigation/DirectionCalculator';
import type {
  DrivingInputState,
  DrivingTelemetry,
  GearMode,
  PanoramaEdge,
  RankedNeighbour,
} from '../../types/streetview';

interface DrivingControlsProps {
  telemetry: DrivingTelemetry;
  rankedNeighbours: RankedNeighbour[];
  onInputChange: <K extends keyof DrivingInputState>(key: K, active: boolean) => void;
  onSetGear: (gear: GearMode) => void;
  onStepDirection: (direction: 'forward' | 'left' | 'right' | 'reverse') => void;
  onSelectEdge: (edge: PanoramaEdge) => void;
  disabled?: boolean;
}

export const DrivingControls: React.FC<DrivingControlsProps> = ({
  telemetry,
  rankedNeighbours,
  onInputChange,
  onSetGear,
  onStepDirection,
  onSelectEdge,
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

  return (
    <div className="flex flex-col gap-3 w-full">
      {/* Connected Real Street Directions Row */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span className="font-instrument text-slate-100 text-sm font-semibold">
            {formatHeading(telemetry.heading)}
          </span>
          <span aria-hidden="true">·</span>
          <span>
            {rankedNeighbours.length === 0
              ? 'No linked roads'
              : `${rankedNeighbours.length} connected ${
                  rankedNeighbours.length === 1 ? 'path' : 'paths'
                }`}
          </span>
        </div>

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
      </div>

      {/* Primary Steering, Gear, and Pedal Controls (Desktop + Touch friendly >=44px) */}
      <div className="flex items-center justify-between gap-2 flex-wrap sm:flex-nowrap">
        {/* Left: Steering + Intersection Turns */}
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
        </div>

        {/* Center: Drive / Reverse Gear Selector */}
        <div
          className="flex items-center p-1 bg-white/5 border border-white/10 rounded-lg shrink-0"
          role="group"
          aria-label="Transmission gear selector"
        >
          <button
            type="button"
            disabled={disabled}
            onClick={() => onSetGear('D')}
            aria-pressed={telemetry.gear === 'D'}
            className={`min-w-[44px] h-9 px-3 rounded-md text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
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
            className={`min-w-[44px] h-9 px-3 rounded-md text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
              telemetry.gear === 'R'
                ? 'bg-sky-400 text-slate-950'
                : 'text-slate-300 hover:text-white'
            }`}
          >
            Reverse
          </button>
        </div>

        {/* Right: Stop, Brake, Accelerate Pedals */}
        <div className="flex items-center gap-1.5" role="group" aria-label="Throttle and brake pedals">
          <button
            type="button"
            disabled={disabled}
            {...holdProps('handbrake')}
            aria-label="Emergency stop (Space)"
            title="Stop (Space)"
            className="min-w-[44px] h-11 px-3 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 active:bg-rose-500/40 border border-rose-500/35 text-rose-200 flex items-center justify-center gap-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 disabled:opacity-40"
          >
            <OctagonX className="w-4 h-4" aria-hidden="true" />
            <span className="hidden sm:inline">Stop</span>
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
            <span>Brake</span>
          </button>

          <button
            type="button"
            disabled={disabled}
            {...holdProps('accelerate')}
            aria-label="Accelerate (Hold W or Up Arrow)"
            title="Accelerate (W / Up)"
            className="min-w-[54px] h-11 px-4 rounded-lg bg-amber-500 hover:bg-amber-400 active:bg-amber-300 text-slate-950 flex items-center justify-center gap-1.5 text-xs font-bold transition-colors whitespace-nowrap shrink-0 disabled:opacity-40"
          >
            <ArrowUp className="w-4 h-4" aria-hidden="true" />
            <span>{telemetry.gear === 'R' ? 'Back' : 'Drive'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
