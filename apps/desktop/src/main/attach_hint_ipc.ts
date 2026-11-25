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

import { accountRuntimeState } from './context/account_runtime';
import { accountIpc } from './window_account_runtime';
import {
  getLogger,
  SharedPrompt,
  type AttachHintAnswer,
  type AttachHintChoice,
} from '@weq/service';
import { setAttachHintPrompt } from './attach_hint';
import { getMainWindow } from './main_window';

const logger = getLogger().child({ scope: 'attach-hint' });

const CONFIRM_CHANNEL = 'attach:confirm-hint';
const RESPOND_CHANNEL = 'attach:respond-hint';

/** The dialog may sit open while the user reads the instructions — give it room. */
const PROMPT_TIMEOUT_MS = 10 * 60 * 1000;

const state = accountRuntimeState(() => ({
  pendingResolve: null as ((answer: AttachHintAnswer) => void) | null,
  prompt: new SharedPrompt<AttachHintAnswer>({ choice: 'cancel', password: '' }),
  pendingToken: 0,
}));

/** Register the IPC listener and wire the prompt into `attach_hint`. */
export function registerAttachHintIpc(): void {
  accountIpc.on(RESPOND_CHANNEL, (event, raw: unknown) => {
    if (event.sender !== getMainWindow()?.webContents || !state().pendingResolve) return;
    const payload = (raw ?? {}) as { token?: unknown; choice?: unknown; password?: unknown };
    if (payload.token !== state().pendingToken) return;
    const choice: AttachHintChoice =
      payload.choice === 'retry' ||
      payload.choice === 'no-remind' ||
      payload.choice === 'skip' ||
      payload.choice === 'cancel'
        ? payload.choice
        : 'cancel';
    const password = typeof payload.password === 'string' ? payload.password : '';
    logger.info('ptrace hint answered', { event: 'attach-hint-answered', choice });
    state().pendingResolve?.({ choice, password });
  });

  setAttachHintPrompt((signal) => promptImpl(signal));
}

function promptImpl(signal?: AbortSignal): Promise<AttachHintAnswer> {
  const request = state();
  return request.prompt.request((finish) => {
    const token = ++request.pendingToken;
    const win = getMainWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
      finish({ choice: 'cancel', password: '' });
      return () => {};
    }
    request.pendingResolve = finish;
    const cancel = (): void => finish({ choice: 'cancel', password: '' });
    const timer = setTimeout(cancel, PROMPT_TIMEOUT_MS);
    win.once('closed', cancel);
    win.webContents.send(CONFIRM_CHANNEL, { token });
    return () => {
      clearTimeout(timer);
      win.removeListener('closed', cancel);
      if (request.pendingToken === token) request.pendingResolve = null;
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('attach:cancel-hint', { token });
      }
    };
  }, signal);
}
