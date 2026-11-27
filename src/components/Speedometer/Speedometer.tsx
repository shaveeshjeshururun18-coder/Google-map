import React from 'react';
import type { DriveMode, DrivingTelemetry } from '../../types/streetview';

interface SpeedometerProps {
  telemetry: DrivingTelemetry;
  driveMode?: DriveMode;
}

export const Speedometer: React.FC<SpeedometerProps> = ({
  telemetry,
  driveMode = 'street-view',
}) => {
  const speedRounded = Math.round(telemetry.speedKmh);
  const ratio = Math.max(0, Math.min(1, telemetry.speedKmh / Math.max(1, telemetry.maxSpeedKmh)));

  // Semi-circular precision gauge arc math
  const radius = 38;
  const circumference = Math.PI * radius; // 180-degree arc
  const dashOffset = circumference * (1 - ratio);

  const progressPct = Math.round(
    (driveMode === '3d-world' ? telemetry.rpm : telemetry.progressToNext) * 100,
  );
  const totalKm = (telemetry.totalDistanceMeters / 1000).toFixed(2);
  const gearLabel =
    telemetry.gear === 'R'
      ? 'Rev'
      : telemetry.gear === 'N'
        ? 'N'
        : telemetry.isMoving
          ? `D${telemetry.virtualGear}`
          : 'Drive';

  return (
    <div
      className="flex items-center gap-4 min-w-[210px]"
      aria-label={`Speed ${speedRounded} kilometers per hour, gear ${gearLabel}`}
    >
      <div className="relative w-24 h-16 shrink-0 flex items-end justify-center">
        <svg
          viewBox="0 0 100 58"
          className="w-full h-full overflow-visible"
          aria-hidden="true"
        >
          <path
            d="M 12 50 A 38 38 0 0 1 88 50"
            fill="none"
            stroke="rgba(255,255,255,0.12)"
            strokeWidth="6"
            strokeLinecap="round"
          />
          <path
            d="M 12 50 A 38 38 0 0 1 88 50"
            fill="none"
            stroke={
              telemetry.isBraking
                ? '#EF4444'
                : telemetry.isBoosting
                  ? '#22D3EE'
                  : telemetry.gear === 'R'
                    ? '#38BDF8'
                    : telemetry.rpm > 0.86
                      ? '#FB7185'
                      : '#F59E0B'
            }
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
          />
        </svg>

        <div className="absolute bottom-0 inset-x-0 flex flex-col items-center leading-none">
          <span
            className={`font-instrument text-2xl font-bold tracking-tight ${
              telemetry.isBoosting ? 'text-cyan-300' : 'text-slate-50'
            }`}
            data-testid="speed-value"
          >
            {speedRounded}
          </span>
          <span className="text-[10px] text-slate-400 mt-0.5 tracking-wide">
            km/h
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-1.5 min-w-[122px]">
        <div className="flex items-center gap-2 text-xs">
          <span
            className={`font-instrument font-bold text-sm ${
              telemetry.isBoosting
                ? 'text-cyan-300'
                : telemetry.gear === 'R'
                  ? 'text-sky-400'
                  : telemetry.gear === 'D'
                    ? 'text-amber-400'
                    : 'text-slate-400'
            }`}
            data-testid="gear-value"
          >
            {gearLabel}
          </span>
          {telemetry.isBoosting ? (
            <span className="font-instrument text-[10px] font-bold tracking-wider uppercase text-cyan-300">
              TURBO
            </span>
          ) : (
            <>
              <span className="text-slate-600" aria-hidden="true">·</span>
              <span className="font-telemetry text-slate-300 text-[11px]">{totalKm} km</span>
            </>
          )}
        </div>

        {/* Engine RPM bar in 3D World mode; next panorama progress in Street View mode */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-[11px] text-slate-400">
            <span className="whitespace-nowrap">
              {driveMode === '3d-world' ? 'Engine RPM' : 'Next view'}
            </span>
            <span className="font-telemetry text-slate-300 whitespace-nowrap">
              {driveMode === '3d-world'
                ? telemetry.isBoosting
                  ? '320 MAX'
                  : `${progressPct}%`
                : telemetry.targetEdge
                  ? `${Math.round(telemetry.segmentDistanceMeters)}m${
                      telemetry.segmentDistanceEstimated ? ' est.' : ''
                    }`
                  : 'Blocked'}
            </span>
          </div>
          <div
            className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden"
            role="progressbar"
            aria-label={
              driveMode === '3d-world'
                ? 'Engine RPM output'
                : 'Virtual progress to next Street View panorama'
            }
            aria-valuenow={progressPct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className={`h-full transition-[width] duration-75 ${
                telemetry.isBoosting
                  ? 'bg-cyan-400'
                  : telemetry.gear === 'R'
                    ? 'bg-sky-400'
                    : telemetry.rpm > 0.86 && driveMode === '3d-world'
                      ? 'bg-rose-400'
                      : 'bg-amber-400'
              }`}
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
