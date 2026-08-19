/**
 * Electron-free seam for the linux ptrace-hint dialog.
 *
 * `inject_elevation` (shared with the web app via `app_context`, which must
 * stay electron-free) asks the renderer to guide the user through disabling
 * yama ptrace protection when the first unprivileged inject is refused. The
 * actual dialog lives in the desktop renderer, so `index.ts` injects the real
 * implementation here at startup. On the headless web server nothing is
 * injected, and the prompt degrades to 'skip' (straight to pkexec).
 */

import type { PtraceHintChoice } from '@weq/service';

export type PtraceHintPrompt = () => Promise<PtraceHintChoice>;

let current: PtraceHintPrompt | null = null;

/** Register the desktop implementation (see `ptrace_hint_ipc.ts`). */
export function setPtraceHintPrompt(prompt: PtraceHintPrompt | null): void {
  current = prompt;
}

/** The registered implementation, or null on headless hosts. */
export function getPtraceHintPrompt(): PtraceHintPrompt | null {
  return current;
}
