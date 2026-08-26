/**
 * Desktop implementation of the linux ptrace-hint bridge.
 *
 * `inject_elevation` hits a permission-denied ptrace inject → calls the
 * registered prompt → we send `ptrace:confirm-hint` to the main window and
 * wait for `ptrace:respond-hint` carrying `{ choice, password }` (`retry` /
 * `no-remind` / `skip` / `cancel`, plus the password typed into the dialog
 * for the sudo escalate paths). Only the desktop registers this; the headless
 * web server never prompts.
 *
 * Concurrency: `injectInflight` coalesces per pid, but two pids could prompt
 * at once — they join the same in-flight dialog and share the one answer.
 */

import { ipcMain } from 'electron';
import { getLogger, type PtraceHintAnswer, type PtraceHintChoice } from '@weq/service';
import { setPtraceHintPrompt } from './ptrace_hint';
import { getMainWindow } from './main_window';

const logger = getLogger().child({ scope: 'ptrace-hint' });

const CONFIRM_CHANNEL = 'ptrace:confirm-hint';
const RESPOND_CHANNEL = 'ptrace:respond-hint';

/** The dialog may sit open while the user reads the instructions — give it room. */
const PROMPT_TIMEOUT_MS = 10 * 60 * 1000;

let pendingResolve: ((answer: PtraceHintAnswer) => void) | null = null;
let pending: Promise<PtraceHintAnswer> | null = null;
let pendingToken = 0;
let pendingTimer: NodeJS.Timeout | null = null;

/** Register the IPC listener and wire the prompt into `ptrace_hint`. */
export function registerPtraceHintIpc(): void {
  ipcMain.on(RESPOND_CHANNEL, (_event, raw: unknown) => {
    const payload = (raw ?? {}) as { choice?: unknown; password?: unknown };
    const choice: PtraceHintChoice =
      payload.choice === 'retry' ||
      payload.choice === 'no-remind' ||
      payload.choice === 'skip' ||
      payload.choice === 'cancel'
        ? payload.choice
        : 'skip';
    const password = typeof payload.password === 'string' ? payload.password : '';
    logger.info('ptrace hint answered', { event: 'ptrace-hint-answered', choice });
    pendingResolve?.({ choice, password });
  });

  setPtraceHintPrompt(() => promptImpl());
}

function promptImpl(): Promise<PtraceHintAnswer> {
  const win = getMainWindow();
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
    // Headless / window gone — fall back to the original escalate flow.
    return Promise.resolve({ choice: 'skip', password: '' });
  }
  if (pending) return pending;

  const token = ++pendingToken;
  pending = new Promise<PtraceHintAnswer>((resolve) => {
    const finish = (answer: PtraceHintAnswer): void => {
      if (pendingToken !== token) return; // stale timeout/close from an older prompt
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = null;
      pendingResolve = null;
      pending = null;
      resolve(answer);
    };
    pendingResolve = finish;
    pendingTimer = setTimeout(() => {
      logger.warn('ptrace hint dialog timed out; proceeding to escalate', {
        event: 'ptrace-hint-timeout',
      });
      finish({ choice: 'skip', password: '' });
    }, PROMPT_TIMEOUT_MS);
    win.once('closed', () => {
      logger.info('main window closed while ptrace hint pending; proceeding to escalate', {
        event: 'ptrace-hint-window-closed',
      });
      finish({ choice: 'skip', password: '' });
    });
    win.webContents.send(CONFIRM_CHANNEL);
    logger.info('asked renderer to show ptrace hint dialog', {
      event: 'ptrace-hint-requested',
    });
  });
  return pending;
}
