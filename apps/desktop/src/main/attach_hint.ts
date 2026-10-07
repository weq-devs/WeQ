/**
 * Electron-free seam for the linux attach-hint dialog.
 *
 * `attach_elevation` (shared with the web app via `app_context`, which must
 * stay electron-free) asks the renderer to guide the user through disabling
 * yama ptrace protection when the first unprivileged inject is refused. The
 * actual dialog lives in the desktop renderer, so `index.ts` injects the real
 * implementation here at startup. On the headless web server nothing is
 * injected, and the prompt degrades to an immediate sudo escalation — which
 * then hits `sudo_prompt`'s headless guard (no password dialog available) and
 * surfaces a clear "run as root" error instead.
 */

import type { AttachHintAnswer } from '@weq/service';

export type AttachHintPrompt = () => Promise<AttachHintAnswer>;

let current: AttachHintPrompt | null = null;

/** Register the desktop implementation (see `attach_hint_ipc.ts`). */
export function setAttachHintPrompt(prompt: AttachHintPrompt | null): void {
  current = prompt;
}

/** The registered implementation, or null on headless hosts. */
export function getAttachHintPrompt(): AttachHintPrompt | null {
  return current;
}
