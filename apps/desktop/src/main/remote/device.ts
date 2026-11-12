import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import {
  remoteDeviceInfoSchema,
  type RemoteDeviceInfo,
  type RemoteConnectionInfo,
} from '../../shared/remote_device';

export interface RemoteObservation {
  deviceInfo?: RemoteDeviceInfo;
  lastConnection?: RemoteConnectionInfo;
}

export function observeRemoteRequest(req: IncomingMessage): RemoteObservation {
  let deviceInfo: RemoteDeviceInfo | undefined;
  const header = req.headers['x-weq-device'];
  if (
    typeof header === 'string' &&
    header.length <= 2048 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(header)
  ) {
    try {
      const parsed = remoteDeviceInfoSchema.safeParse(
        JSON.parse(Buffer.from(header, 'base64').toString('utf8')),
      );
      if (parsed.success) deviceInfo = parsed.data;
    } catch {
      /* 旧客户端或无效资料不影响现有鉴权。 */
    }
  }
  const peer = req.socket.remoteAddress?.replace(/^::ffff:/, '');
  // 网络助手的 ReverseProxy 追加实际来源；只读取回环代理链的最后一项。
  const forwarded = req.headers['x-forwarded-for'];
  const candidate =
    (peer === '127.0.0.1' || peer === '::1') && typeof forwarded === 'string'
      ? forwarded.split(',').at(-1)?.trim()
      : peer;
  if (!candidate || !isIP(candidate)) return { deviceInfo };
  const ip = candidate.replace(/^::ffff:/, '');
  const [a = -1, b = -1] = ip.split('.').map(Number);
  const tailscale =
    (a === 100 && b >= 64 && b <= 127) || ip.toLowerCase().startsWith('fd7a:115c:a1e0:');
  const lan = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  return {
    deviceInfo,
    lastConnection: { ip, route: tailscale ? 'tailscale' : lan ? 'lan' : 'unknown' },
  };
}
