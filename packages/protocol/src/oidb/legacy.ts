import { decode, encode, message } from '../protobuf';
import { sendPacket, type TrpcNative } from '../transport';

export const legacyOidbEnvelope = message([
  { name: 'command', tag: 1, type: 'uint32' },
  { name: 'serviceType', tag: 2, type: 'uint32', force: true },
  { name: 'result', tag: 3, type: 'uint32', force: true },
  { name: 'body', tag: 4, type: 'bytes', force: true },
  { name: 'errorMessage', tag: 5, type: 'string' },
  { name: 'clientVersion', tag: 6, type: 'string' },
]);
export async function invokeLegacyOidb(
  nt: TrpcNative,
  pid: number,
  command: number,
  serviceType: number,
  sso: string,
  body: Uint8Array,
  clientVersion?: string,
) {
  const reply = await sendPacket(
    nt,
    pid,
    sso,
    encode(legacyOidbEnvelope, { command, serviceType, body, clientVersion }),
    false,
  );
  if (!reply.length || reply.length > 1024 * 1024) throw new Error('旧 OIDB 响应为空或超限');
  const response = decode(legacyOidbEnvelope, reply);
  if (
    response.command !== command ||
    (response.serviceType !== undefined && response.serviceType !== serviceType)
  )
    throw new Error('旧 OIDB 响应命令不匹配');
  if (response.result !== 0)
    throw new Error(`旧 OIDB 请求未成功：${String(response.result ?? '未知')}`);
  if (!(response.body instanceof Uint8Array)) throw new Error('旧 OIDB 响应缺少业务体');
  return response.body;
}
