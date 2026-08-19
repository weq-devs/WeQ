/**
 * Desktop implementation of the linux ptrace-hint bridge.
 *
 * `inject_elevation` hits a permission-denied ptrace inject → calls the
 * registered prompt → we send `ptrace:confirm-hint` to the main window and
 * wait for `ptrace:respond-hint` (`retry` / `no-remind` / `skip`). Only the
 * desktop registers this; the headless web server never prompts.
 *
 * Concurrency: `injectInflight` coalesces per pid, but two pids could prompt
 * at once — they join the same in-flight dialog and share the one answer.
 */

import { ipcMain } from 'electron';
import { getLogger, type PtraceHintChoice } from '@weq/service';
import { setPtraceHintPrompt } from './ptrace_hint';
import { getMainWindow } from './main_window';

const logger = getLogger().child({ scope: 'ptrace-hint' });

const CONFIRM_CHANNEL = 'ptrace:confirm-hint';
const RESPOND_CHANNEL = 'ptrace:respond-hint';

/** The dialog may sit open while the user reads the instructions — give it room. */
const PROMPT_TIMEOUT_MS = 10 * 60 * 1000;

let pendingResolve: ((choice: PtraceHintChoice) => void) | null = null;
let pending: Promise<PtraceHintChoice> | null = null;
let pendingToken = 0;
let pendingTimer: NodeJS.Timeout | null = null;

/** Register the IPC listener and wire the prompt into `ptrace_hint`. */
export function registerPtraceHintIpc(): void {
  ipcMain.on(RESPOND_CHANNEL, (_event, raw: unknown) => {
    const choice = raw === 'retry' || raw === 'no-remind' || raw === 'skip' ? raw : 'skip';
    logger.info('ptrace hint answered', { event: 'ptrace-hint-answered', choice });
    pendingResolve?.(choice);
  });

  setPtraceHintPrompt(() => promptImpl());
}

function promptImpl(): Promise<PtraceHintChoice> {
  const win = getMainWindow();
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
    // Headless / window gone — fall back to the original escalate flow.
    return Promise.resolve('skip');
  }
  if (pending) return pending;

  const token = ++pendingToken;
  pending = new Promise<PtraceHintChoice>((resolve) => {
    const finish = (choice: PtraceHintChoice): void => {
      if (pendingToken !== token) return; // stale timeout/close from an older prompt
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = null;
      pendingResolve = null;
      pending = null;
      resolve(choice);
    };
    pendingResolve = finish;
    pendingTimer = setTimeout(() => {
      logger.warn('ptrace hint dialog timed out; proceeding to escalate', {
        event: 'ptrace-hint-timeout',
      });
      finish('skip');
    }, PROMPT_TIMEOUT_MS);
    win.once('closed', () => {
      logger.info('main window closed while ptrace hint pending; proceeding to escalate', {
        event: 'ptrace-hint-window-closed',
      });
      finish('skip');
    });
    win.webContents.send(CONFIRM_CHANNEL);
    logger.info('asked renderer to show ptrace hint dialog', {
      event: 'ptrace-hint-requested',
    });
  });
  return pending;
}
