/**
 * Primary-window registry.
 *
 * `index.ts` owns the window lifecycle; service modules (e.g. the ptrace-hint
 * bridge) need to reach it without importing `index.ts` back (a module cycle).
 * Keeping the reference here breaks that cycle.
 */

import type { BrowserWindow } from 'electron';

let mainWindow: BrowserWindow | null = null;

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
