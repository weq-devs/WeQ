import { describe, expect, it } from 'vitest';
import { invokeLegacyOidb } from '../src/oidb/legacy';

const call = (hex: string, allowEmptyBody = false) =>
  invokeLegacyOidb(
    { sendPacket: async () => Buffer.from(hex, 'hex') },
    1,
    0x8bb,
    9,
    'OidbSvc.0x8bb_9',
    new Uint8Array(),
    { strict: true, allowEmptyBody },
  );

describe('通用旧 OIDB 保存 ACK', () => {
  it('默认仍要求业务体，仅显式开启时接受无业务体成功 ACK', async () => {
    await expect(call('08bb1110091800')).rejects.toThrow('业务体');
    await expect(call('08bb1110091800', true)).resolves.toHaveLength(0);
    await expect(call('08bb11100918002200')).resolves.toHaveLength(0);
  });
  it.each([
    ['缺结果', '08bb111009'],
    ['业务拒绝 65', '08bb1110091841'],
    ['业务拒绝 66', '08bb1110091842'],
    ['错命令', '08ba1110091800'],
    ['错子命令', '08bb1110021800'],
    ['截断业务体', '08bb11100918002205'],
  ])('允许空业务体不放宽其余校验：%s', async (_label, hex) => {
    await expect(call(hex, true)).rejects.toThrow();
  });
});
