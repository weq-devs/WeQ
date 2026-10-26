import type { NtHelperBinding } from '@weq/native';
import { toCaptureFrameWire } from '../capture_protocol';
import type { CaptureWorkerRequest } from '../capture_protocol';

/** 临时提权与长期助手共用 native 映射，避免维护第二套抓包协议。 */
export async function dispatchCaptureOperation(
  addon: Pick<NtHelperBinding, 'startCapture' | 'takeFrames' | 'stopCapture'>,
  request: Omit<CaptureWorkerRequest, 'id'>,
): Promise<unknown> {
  switch (request.op) {
    case 'start':
      return addon.startCapture(request.pid, {
        iface: request.iface,
        port: request.port,
        d2Key: request.d2key,
      });
    case 'take': {
      const batch = await addon.takeFrames(request.pid, {
        cursor: request.cursor,
        waitMs: request.waitMs,
      });
      return { ...batch, frames: batch.frames.map(toCaptureFrameWire) };
    }
    case 'stop':
      return addon.stopCapture(request.pid);
  }
}
