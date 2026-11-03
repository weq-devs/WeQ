/** Electron-only setup for UDP capture storage. */

import { app } from 'electron';
import { join } from 'node:path';
import { setUdpCaptureDirectory } from './udp_capture_session';

export function registerUdpCaptureStorage(): void {
  setUdpCaptureDirectory(join(app.getPath('userData'), 'udp-captures'));
}
