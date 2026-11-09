import { describe, expect, it } from 'vitest';
import { oidbCommand, resolveSign, SIGN_RULES } from '../src/index';

describe('oidbCommand', () => {
  it('和线上 / 抓包的命令串逐字一致（小写 hex、无前导零）', () => {
    expect(oidbCommand(0x6d6, 2)).toBe('OidbSvcTrpcTcp.0x6d6_2');
    expect(oidbCommand(0x102a, 0)).toBe('OidbSvcTrpcTcp.0x102a_0');
    expect(oidbCommand(0x9082, 1)).toBe('OidbSvcTrpcTcp.0x9082_1');
  });
});

describe('resolveSign', () => {
  it('未登记的命令按「不签名 + 精简签名」处理', () => {
    for (const platform of ['linux', 'win32', 'darwin'] as const) {
      expect(resolveSign('OidbSvcTrpcTcp.0xdead_1', platform)).toEqual({
        needSign: false,
        mode: 3,
      });
    }
  });

  it("sign: 'all' 三端都签", () => {
    const cmd = 'OidbSvcTrpcTcp.0x102a_0';
    for (const platform of ['linux', 'win32', 'darwin'] as const) {
      expect(resolveSign(cmd, platform).needSign).toBe(true);
    }
  });

  it("sign: 'non-linux' 只有 Linux 不签", () => {
    const cmd = 'OidbSvcTrpcTcp.0x6d6_2';
    expect(resolveSign(cmd, 'linux').needSign).toBe(false);
    expect(resolveSign(cmd, 'win32').needSign).toBe(true);
    expect(resolveSign(cmd, 'darwin').needSign).toBe(true);
  });

  it("sign: 'not-darwin' 只有 macOS 不签（0x9082 贴表情）", () => {
    for (const cmd of ['OidbSvcTrpcTcp.0x9082_1', 'OidbSvcTrpcTcp.0x9082_2']) {
      expect(resolveSign(cmd, 'linux').needSign).toBe(true);
      expect(resolveSign(cmd, 'win32').needSign).toBe(true);
      expect(resolveSign(cmd, 'darwin').needSign).toBe(false);
    }
  });

  it('mode2 只在 macOS / Windows 生效，Linux 恒为 3', () => {
    const cmd = 'MessageSvc.PbSendMsg';
    expect(resolveSign(cmd, 'linux').mode).toBe(3);
    expect(resolveSign(cmd, 'win32').mode).toBe(2);
    expect(resolveSign(cmd, 'darwin').mode).toBe(2);
  });

  it('精简签名的命令三端 mode 都是 3', () => {
    const cmd = 'OidbSvcTrpcTcp.0x102a_0';
    for (const platform of ['linux', 'win32', 'darwin'] as const) {
      expect(resolveSign(cmd, platform).mode).toBe(3);
    }
  });
});

describe('SIGN_RULES', () => {
  it('每一条都能在三个平台上解析出确定的 (needSign, mode)', () => {
    for (const cmd of Object.keys(SIGN_RULES)) {
      for (const platform of ['linux', 'win32', 'darwin'] as const) {
        const { needSign, mode } = resolveSign(cmd, platform);
        expect(typeof needSign).toBe('boolean');
        expect([2, 3]).toContain(mode);
      }
    }
  });

  it('三端都不签的命令不应出现在表里（false 是缺省，不用登记）', () => {
    for (const cmd of Object.keys(SIGN_RULES)) {
      const signed = (['linux', 'win32', 'darwin'] as const).some(
        (p) => resolveSign(cmd, p).needSign,
      );
      expect(signed, `${cmd} 三端都不签，应该从表里删掉`).toBe(true);
    }
  });

  it('OIDB 键统一用 OidbSvcTrpcTcp.<小写 hex>_<sub> 形式', () => {
    for (const cmd of Object.keys(SIGN_RULES)) {
      if (!cmd.startsWith('OidbSvcTrpcTcp.')) continue;
      expect(cmd).toMatch(/^OidbSvcTrpcTcp\.0x[0-9a-f]+_\d+$/);
    }
  });
});

describe('issue #126：三端签名差异', () => {
  it('Linux 不签、Windows / macOS 签的 18 条命令全部登记为 non-linux', () => {
    const expected = [
      '0x10c0_1',
      '0x10c0_2',
      '0x11e9_200',
      '0x11ea_200',
      '0x126d_200',
      '0x126e_200',
      '0x6d6_2',
      '0x6d6_3',
      '0x8fc_3',
      '0x902e_1',
      '0xa80_1',
      '0xe37_1200',
      '0xe37_1700',
      '0xe37_800',
      '0xfd4_1',
      '0xfe1_2',
      '0xfe5_2',
      '0xfe7_3',
    ];
    for (const key of expected) {
      const cmd = `OidbSvcTrpcTcp.${key}`;
      expect(SIGN_RULES[cmd as keyof typeof SIGN_RULES], cmd).toMatchObject({
        sign: 'non-linux',
      });
    }
  });

  it('macOS 实测不签的 0x9082_1/2 单独声明，不跟随 Windows', () => {
    expect(resolveSign('OidbSvcTrpcTcp.0x9082_1', 'darwin').needSign).toBe(false);
    expect(resolveSign('OidbSvcTrpcTcp.0x9082_2', 'darwin').needSign).toBe(false);
  });

  it('mode=2 的 13 条三端交集命令都标了 mode2', () => {
    const fullSign = [
      'MessageSvc.PbSendMsg',
      'OidbSvcTrpcTcp.0x6d9_4',
      'OidbSvcTrpcTcp.0x89a_15',
      'OidbSvcTrpcTcp.0x93d7_1',
      'OidbSvcTrpcTcp.0x10c8_1',
      'OidbSvcTrpcTcp.0x10c8_2',
      'OidbSvcTrpcTcp.0x112a_2',
      'OidbSvcTrpcTcp.0x112e_1',
      'OidbSvcTrpcTcp.0x11ec_1',
      'trpc.msg.msg_svc.MsgService.SsoReadedReport',
      'trpc.msg.msg_svc.MsgService.SsoC2CRecallMsg',
      'trpc.group.long_msg_interface.MsgService.SsoSendLongMsg',
      'trpc.qqhb.qqhb_proxy.Handler.sso_handle',
    ];
    for (const cmd of fullSign) {
      expect(SIGN_RULES[cmd as keyof typeof SIGN_RULES], cmd).toMatchObject({ mode2: true });
    }
  });
});

/**
 * 防漂移：`scripts/probe-sign.ts` 内置的命令表必须覆盖签名表里的每一条 OIDB
 * 命令，否则「新加一条签名策略」就没法在当前平台复测，等于没有证据。
 */
describe('probe-sign.ts 命令表与签名表对齐', () => {
  it('签名表里的 OIDB 命令都能在探测脚本里找到', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../../scripts/probe-sign.ts', import.meta.url), 'utf8');
    const cases = new Set<string>();
    for (const m of src.matchAll(/^\s*'([0-9a-f]+_[0-9]+)',$/gm)) cases.add(m[1]!);

    for (const cmd of Object.keys(SIGN_RULES)) {
      if (!cmd.startsWith('OidbSvcTrpcTcp.')) continue;
      const key = cmd.slice('OidbSvcTrpcTcp.0x'.length);
      expect(cases.has(key), `probe-sign.ts 缺 ${key}`).toBe(true);
    }
  });
});
