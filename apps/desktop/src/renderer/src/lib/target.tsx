/**
 * Build-target helpers.
 *
 * `VITE_WEQ_TARGET` is set by each app's vite config ('electron' | 'web').
 * Because it's a literal at build time, rollup drops the dead branch entirely —
 * so Electron-only UI (and the `window.electron` calls behind it) never reaches
 * the browser bundle.
 */

import type { ReactElement, ReactNode } from 'react';
import { IS_WEB } from './target.shared';

/**
 * Render `children` only in the Electron build. Use for anything that depends
 * on a native shell: window controls, tray, file-manager reveal, screenshots,
 * system auth, in-app updates.
 */
export function DesktopOnly({ children }: { children: ReactNode }): ReactElement | null {
  if (IS_WEB) return null;
  return <>{children}</>;
}
