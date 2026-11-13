import { describe, expect, it } from 'vitest';
import {
  buildOidbEnvelope,
  parseCase,
  parseRequestCases,
  validateControlSocketPath,
} from '../../../scripts/sign-probe-requests';

describe('探测请求', () => {
  it('Unix socket 长度按 UTF-8 字节检查，保留末尾 NUL 空间', () => {
    expect(validateControlSocketPath('/' + 'x'.repeat(102), 'darwin')).toHaveLength(103);
    expect(() => validateControlSocketPath('/' + 'x'.repeat(103), 'darwin')).toThrow('103');
    expect(validateControlSocketPath('/' + '测'.repeat(34), 'darwin')).toBeTruthy();
    expect(() => validateControlSocketPath('/' + '测'.repeat(35), 'darwin')).toThrow('103');
    expect(validateControlSocketPath('/' + 'x'.repeat(106), 'linux')).toHaveLength(107);
    expect(() => validateControlSocketPath('/' + 'x'.repeat(107), 'linux')).toThrow('107');
    expect(() => validateControlSocketPath('relative.sock', 'darwin')).toThrow('绝对路径');
  });
  it('OIDB 信封与 prost 契约一致：UIN-form 为 tag 12，不写无关的 tag 6', () => {
    expect(buildOidbEnvelope(1, 2, Buffer.from([0xaa]), true).toString('hex')).toBe(
      '080110022201aa6001',
    );
    expect(buildOidbEnvelope(1, 2, Buffer.from([0xaa])).toString('hex')).toBe('080110022201aa');
  });
  it.each(['89a_15', '0x89a_15', 'OidbSvcTrpcTcp.0x89a_15'])(
    '%s 保持十六进制主命令、十进制子命令且不重复套壳',
    (value) => {
      expect(parseCase(value, Buffer.from([1]), true)).toEqual({
        wire: 'OidbSvcTrpcTcp.0x89a_15',
        body: buildOidbEnvelope(0x89a, 15, Buffer.from([1]), true),
        bodySource: 'explicit',
      });
    },
  );
  it('显式空业务正文不被替换为占位包', () => {
    expect(parseRequestCases([{ cmd: 'raw.command', bodyHex: '' }])[0]).toEqual({
      wire: 'raw.command',
      body: Buffer.alloc(0),
      bodySource: 'explicit',
    });
    expect(parseCase('raw.command').bodySource).toBe('placeholder');
  });
  it.each(
    [
      [],
      {},
      [{ cmd: '', bodyHex: '' }],
      [{ cmd: 'raw.command', bodyHex: 'a' }],
      [{ cmd: 'raw.command', bodyHex: 'zz' }],
      [{ cmd: 'raw.command', bodyHex: '', isUid: true }],
      [{ cmd: 'raw.command', bodyHex: '', isUid: 'true' }],
      [{ cmd: 'raw.command', bodyHex: '', body: 'typo' }],
      [{ cmd: '0x100000000_1', bodyHex: '' }],
      [{ cmd: '0x1_4294967296', bodyHex: '' }],
    ].map((value) => ({ value })),
  )('无效输入 %# 在加载 native 或发包前拒绝', ({ value }) => {
    expect(() => parseRequestCases(value)).toThrow();
  });
});
