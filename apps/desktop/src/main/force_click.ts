import type { BrowserWindow } from 'electron';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  FORCE_CLICK_CHANNEL,
  FORCE_CLICK_RESULT_CHANNEL,
  type ForceClickRequest,
} from '../shared/force_click';

type Observation = {
  finish(id: number, handled: boolean): void;
  stop(): void;
};

type ForceClickNative = {
  observe(handle: Buffer, notify: (x: number, y: number, id: number) => void): Observation;
};

const RESPONSE_TIMEOUT_MS = 250;

export function installMacForceClick(
  window: BrowserWindow,
  mainDirectory: string,
  reportError: (error: unknown) => void,
) {
  if (process.platform !== 'darwin') return;
  const contents = window.webContents;
  let observation: Observation;
  let pending: { id: number; timer: ReturnType<typeof setTimeout> } | undefined;

  const finish = (id: number, handled: boolean) => {
    if (!pending || pending.id !== id) return;
    clearTimeout(pending.timer);
    pending = undefined;
    observation.finish(id, handled);
  };

  try {
    const require = createRequire(import.meta.url);
    const native = require(join(mainDirectory, 'force-click.node')) as ForceClickNative;
    observation = native.observe(window.getNativeWindowHandle(), (x, y, id) => {
      if (pending) finish(pending.id, false);
      const zoom = contents.getZoomFactor();
      const request: ForceClickRequest = {
        id,
        x: x / zoom,
        y: y / zoom,
        deadline: Date.now() + RESPONSE_TIMEOUT_MS,
      };
      pending = { id, timer: setTimeout(() => finish(id, false), RESPONSE_TIMEOUT_MS) };
      contents.send(FORCE_CLICK_CHANNEL, request);
    });
  } catch (error) {
    reportError(error);
    return;
  }

  contents.ipc.on(FORCE_CLICK_RESULT_CHANNEL, (event, id: number, handled: boolean) => {
    if (event.senderFrame === contents.mainFrame) finish(id, handled === true);
  });
  window.once('closed', () => {
    if (pending) clearTimeout(pending.timer);
    observation.stop();
  });
}
