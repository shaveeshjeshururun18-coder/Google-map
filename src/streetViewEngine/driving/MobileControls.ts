import type React from 'react';
import type { CarInputState } from '../types';

export interface TouchHoldProps {
  onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
}

/**
 * Generates responsive pointer/touch hold handlers for mobile & tablet steering,
 * throttle, brake, and handbrake controls without triggering scroll or text selection.
 */
export function createTouchHoldProps<K extends keyof CarInputState>(
  key: K,
  disabled: boolean,
  onInputChange: (k: K, active: boolean) => void,
): TouchHoldProps {
  return {
    onPointerDown: (e) => {
      e.preventDefault();
      if (!disabled) {
        onInputChange(key, true);
      }
    },
    onPointerUp: () => onInputChange(key, false),
    onPointerLeave: () => onInputChange(key, false),
    onPointerCancel: () => onInputChange(key, false),
  };
}
