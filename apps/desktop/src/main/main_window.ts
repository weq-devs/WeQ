/**
 * Primary-window registry.
 *
 * `index.ts` owns the window lifecycle; service modules (e.g. the attach-hint
 * bridge) need to reach it without importing `index.ts` back (a module cycle).
 * Keeping the reference here breaks that cycle.
 */

import type { BrowserWindow } from 'electron';
import { accountRuntimeState } from './context/account_runtime';

const state = accountRuntimeState(() => ({ window: null as BrowserWindow | null }));

export function setMainWindow(win: BrowserWindow | null): void {
  state().window = win;
}

export function getMainWindow(): BrowserWindow | null {
  return state().window;
}
