/**
 * Desktop implementation of the linux attach-hint bridge.
 *
 * `attach_elevation` hits a permission-denied ptrace attach → calls the
 * registered prompt → we send `attach:confirm-hint` to the main window and
 * wait for `attach:respond-hint` carrying `{ choice, password }` (`retry` /
 * `no-remind` / `skip` / `cancel`, plus the password typed into the dialog
 * for the sudo escalate paths). Only the desktop registers this; the headless
 * web server never prompts.
 *
 * Concurrency: in-flight prompts coalesce per pid, but two pids could prompt
 * at once — they join the same in-flight dialog and share the one answer.
 */

import { ipcMain } from 'electron';
import { getLogger, type AttachHintAnswer, type AttachHintChoice } from '@weq/service';
import { setAttachHintPrompt } from './attach_hint';
import { getMainWindow } from './main_window';

const logger = getLogger().child({ scope: 'attach-hint' });

const CONFIRM_CHANNEL = 'attach:confirm-hint';
const RESPOND_CHANNEL = 'attach:respond-hint';

/** The dialog may sit open while the user reads the instructions — give it room. */
const PROMPT_TIMEOUT_MS = 10 * 60 * 1000;

let pendingResolve: ((answer: AttachHintAnswer) => void) | null = null;
let pending: Promise<AttachHintAnswer> | null = null;
let pendingToken = 0;
let pendingTimer: NodeJS.Timeout | null = null;

/** Register the IPC listener and wire the prompt into `attach_hint`. */
export function registerAttachHintIpc(): void {
  ipcMain.on(RESPOND_CHANNEL, (_event, raw: unknown) => {
    const payload = (raw ?? {}) as { choice?: unknown; password?: unknown };
    const choice: AttachHintChoice =
      payload.choice === 'retry' ||
      payload.choice === 'no-remind' ||
      payload.choice === 'skip' ||
      payload.choice === 'cancel'
        ? payload.choice
        : 'skip';
    const password = typeof payload.password === 'string' ? payload.password : '';
    logger.info('ptrace hint answered', { event: 'attach-hint-answered', choice });
    pendingResolve?.({ choice, password });
  });

  setAttachHintPrompt(() => promptImpl());
}

function promptImpl(): Promise<AttachHintAnswer> {
  const win = getMainWindow();
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
    // Headless / window gone — fall back to the original escalate flow.
    return Promise.resolve({ choice: 'skip', password: '' });
  }
  if (pending) return pending;

  const token = ++pendingToken;
  pending = new Promise<AttachHintAnswer>((resolve) => {
    const finish = (answer: AttachHintAnswer): void => {
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
        event: 'attach-hint-timeout',
      });
      finish({ choice: 'skip', password: '' });
    }, PROMPT_TIMEOUT_MS);
    win.once('closed', () => {
      logger.info('main window closed while ptrace hint pending; proceeding to escalate', {
        event: 'attach-hint-window-closed',
      });
      finish({ choice: 'skip', password: '' });
    });
    win.webContents.send(CONFIRM_CHANNEL);
    logger.info('asked renderer to show ptrace hint dialog', {
      event: 'attach-hint-requested',
    });
  });
  return pending;
}
