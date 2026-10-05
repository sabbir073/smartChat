import { useSyncExternalStore } from 'react';
import type { CallController, CallSnapshot } from './call-controller.js';

/**
 * The call bar's view of the controller.
 *
 * The controller is a plain object with its own subscribers, so the hook is one line: React
 * re-renders whoever called it whenever the snapshot is replaced, and nothing about calls has to
 * be rebuilt as effects to be testable.
 */
export function useCall(controller: CallController): CallSnapshot {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}
