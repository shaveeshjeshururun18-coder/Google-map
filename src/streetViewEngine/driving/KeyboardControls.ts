import type { CarInputState } from '../types';

export interface KeyboardControlHandlers {
  onInputChange: <K extends keyof CarInputState>(key: K, active: boolean) => void;
  onResetInputs: () => void;
  onToggleReverse: () => void;
  onToggleCruise: () => void;
  onSnapTurnLeft: () => void;
  onSnapTurnRight: () => void;
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * Attaches desktop WASD / Arrow / Space / R / C / Q / E driving shortcuts cleanly to `window`.
 * Returns an unsubscribe cleanup callback.
 */
export function attachKeyboardControls(handlers: KeyboardControlHandlers): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (isEditableElement(event.target)) return;

    switch (event.code) {
      case 'KeyW':
      case 'ArrowUp':
        event.preventDefault();
        handlers.onInputChange('accelerate', true);
        break;
      case 'KeyS':
      case 'ArrowDown':
        event.preventDefault();
        handlers.onInputChange('brake', true);
        break;
      case 'KeyA':
      case 'ArrowLeft':
        event.preventDefault();
        handlers.onInputChange('steerLeft', true);
        break;
      case 'KeyD':
      case 'ArrowRight':
        event.preventDefault();
        handlers.onInputChange('steerRight', true);
        break;
      case 'Space':
        event.preventDefault();
        handlers.onInputChange('handbrake', true);
        break;
      case 'KeyR':
        if (!event.repeat) {
          event.preventDefault();
          handlers.onToggleReverse();
        }
        break;
      case 'KeyC':
        if (!event.repeat) {
          event.preventDefault();
          handlers.onToggleCruise();
        }
        break;
      case 'KeyQ':
        if (!event.repeat) {
          event.preventDefault();
          handlers.onSnapTurnLeft();
        }
        break;
      case 'KeyE':
        if (!event.repeat) {
          event.preventDefault();
          handlers.onSnapTurnRight();
        }
        break;
    }
  };

  const onKeyUp = (event: KeyboardEvent) => {
    switch (event.code) {
      case 'KeyW':
      case 'ArrowUp':
        handlers.onInputChange('accelerate', false);
        break;
      case 'KeyS':
      case 'ArrowDown':
        handlers.onInputChange('brake', false);
        break;
      case 'KeyA':
      case 'ArrowLeft':
        handlers.onInputChange('steerLeft', false);
        break;
      case 'KeyD':
      case 'ArrowRight':
        handlers.onInputChange('steerRight', false);
        break;
      case 'Space':
        handlers.onInputChange('handbrake', false);
        break;
    }
  };

  const onWindowBlur = () => {
    handlers.onResetInputs();
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onWindowBlur);

  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onWindowBlur);
  };
}
