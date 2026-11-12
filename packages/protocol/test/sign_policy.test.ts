import { describe, expect, it, vi } from 'vitest';
import * as protocol from '../src/index';
import { oidbCommand, resolveSign, SIGN_RULES, UNCONFIRMED_SIGN_COMMANDS } from '../src/index';
import { DEFAULT_OIDB_CASES, DEFAULT_RAW_CASES } from '../../../scripts/sign-probe-commands';

describe('oidbCommand', () => {
  it('和线上 / 抓包的命令串逐字一致（小写 hex、无前导零）', () => {
    expect(oidbCommand(0x6d6, 2)).toBe('OidbSvcTrpcTcp.0x6d6_2');
    expect(oidbCommand(0x102a, 0)).toBe('OidbSvcTrpcTcp.0x102a_0');
    expect(oidbCommand(0x9082, 1)).toBe('OidbSvcTrpcTcp.0x9082_1');
  });
});

describe('resolveSign', () => {
  it.each([
    'OidbSvcTrpcTcp.0x9474_0',
    'OidbSvcTrpcTcp.0xfe1_3',
    'OidbSvcTrpcTcp.0x9067_202',
    'OidbSvcTrpcTcp.0xcd4_1',
    'OidbSvcTrpcTcp.0x6d6_4',
    'OidbSvc.0xcf4',
    'trpc.qqrtc.mav_appsvr.MavAppsvr.SsoQueryRoom',
  ])('已登记的不签名命令 %s 三端保持原参数且不报警', (cmd) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      for (const platform of ['linux', 'win32', 'darwin'] as const) {
        expect(resolveSign(cmd, platform)).toEqual({ needSign: false, mode: 3 });
      }
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('真正未登记的命令仍报警，同一命令只提醒一次', () => {
    const cmd = 'test.sign-policy.unknown-once';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      for (const platform of ['linux', 'win32', 'darwin'] as const) {
        expect(resolveSign(cmd, platform)).toEqual({ needSign: false, mode: 3 });
      }
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`未登记的命令 ${cmd}`));
      resolveSign('test.sign-policy.another-unknown');
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

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

  it('显式不签名策略与真正未登记的命令分开', () => {
    for (const cmd of [
      'OidbSvcTrpcTcp.0x9474_0',
      'OidbSvcTrpcTcp.0xfe1_3',
      'OidbSvcTrpcTcp.0x9067_202',
      'OidbSvc.0xcf4',
    ]) {
      expect(SIGN_RULES).toHaveProperty([cmd], { sign: 'none' });
      expect(UNCONFIRMED_SIGN_COMMANDS).not.toHaveProperty([cmd]);
    }
    for (const cmd of Object.keys(SIGN_RULES)) {
      const rule = SIGN_RULES[cmd as keyof typeof SIGN_RULES];
      const signed = (['linux', 'win32', 'darwin'] as const).some(
        (p) => resolveSign(cmd, p).needSign,
      );
      expect(signed, cmd).toBe(rule.sign !== 'none');
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
  it.each(['HttpConn.0x6ff_501', 'OidbSvc.0x480_9_IMCore', 'OidbSvc.0x42d_4'])(
    '文档已记录的 raw 命令 %s 也必须登记平台差异',
    (cmd) => {
      expect(resolveSign(cmd, 'linux')).toEqual({ needSign: false, mode: 3 });
      expect(resolveSign(cmd, 'win32')).toEqual({ needSign: true, mode: 3 });
      expect(resolveSign(cmd, 'darwin')).toEqual({ needSign: true, mode: 3 });
    },
  );
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
 * 防漂移：真实入口与探测数据都必须有策略或待确认原因，不能只检查表内条目。
 */
describe('协议入口、探测清单与策略双向覆盖', () => {
  const cases = new Set([
    ...DEFAULT_OIDB_CASES.map((cmd) => `OidbSvcTrpcTcp.0x${cmd}`),
    ...DEFAULT_RAW_CASES,
  ]);
  const registered = new Set(Object.keys(SIGN_RULES));
  const accounted = new Set([...registered, ...Object.keys(UNCONFIRMED_SIGN_COMMANDS)]);
  const assertAccounted = (cmd: string) => {
    expect(accounted.has(cmd), `${cmd} 必须登记策略或明确列为待确认`).toBe(true);
    expect(cases.has(cmd), `${cmd} 缺少探测入口`).toBe(true);
  };

  it('OIDB 和 raw 清单双向覆盖，待确认清单不冒充签名策略', () => {
    expect(cases.size).toBe(DEFAULT_OIDB_CASES.length + DEFAULT_RAW_CASES.length);
    for (const cmd of cases) assertAccounted(cmd);
    for (const cmd of accounted) expect(cases.has(cmd), `${cmd} 缺少探测入口`).toBe(true);
    for (const [cmd, reason] of Object.entries(UNCONFIRMED_SIGN_COMMANDS)) {
      expect(registered.has(cmd), `${cmd} 不能同时是已登记和待确认`).toBe(false);
      expect(reason.trim().length).toBeGreaterThan(0);
    }
  });

  it('真实导出的静态 spec 与动态子命令不能漏登记', () => {
    const dynamic = new Map<object, Record<string, unknown>[]>([
      [protocol.SetPeerPin, [{ target: { kind: 'group' } }, { target: { kind: 'c2c' } }]],
      [protocol.GroupTodo, ['set', 'complete', 'cancel'].map((action) => ({ action }))],
      [protocol.SetGroupEssence, [{ enable: true }, { enable: false }]],
      [protocol.SetReaction, [{ isSet: true }, { isSet: false }]],
      [protocol.FetchGroupRequests, [{ filtered: true }, { filtered: false }]],
      [protocol.SetGroupRequest, [{ filtered: true }, { filtered: false }]],
    ]);
    for (const [name, value] of Object.entries({ ...protocol, ...protocol.groupCall })) {
      if (!value || typeof value !== 'object' || !('reqSchema' in value)) continue;
      if (value === protocol.PttTrans) continue; // 两种命令在下一个用例按真实选择器检查。
      const spec = value as Record<string, unknown>;
      if (typeof spec.command === 'string') {
        assertAccounted(spec.command); // 红包的 cmd 是子命令，wire 命令在 command。
      } else if (typeof spec.cmd === 'string') {
        assertAccounted(spec.cmd);
      } else {
        expect(typeof spec.command, name).toBe('number');
        if (typeof spec.resolveSubCommand === 'function') {
          const params = dynamic.get(value);
          expect(params, `${name} 必须补动态分支样本`).toBeDefined();
          for (const param of params ?? []) {
            assertAccounted(oidbCommand(Number(spec.command), spec.resolveSubCommand(param)));
          }
        } else {
          expect(typeof spec.subCommand, name).toBe('number');
          assertAccounted(oidbCommand(Number(spec.command), Number(spec.subCommand)));
        }
      }
    }
  });

  it('动态上传、语音转写、旧 OIDB、直发 raw 命令也在清单中', () => {
    for (const command of [
      protocol.IMAGE_OIDB_C2C,
      protocol.IMAGE_OIDB_GROUP,
      protocol.PTT_OIDB_C2C,
      protocol.PTT_OIDB_GROUP,
      protocol.VIDEO_OIDB_C2C,
      protocol.VIDEO_OIDB_GROUP,
    ])
      assertAccounted(oidbCommand(command, 100));
    for (const cmd of [
      protocol.pttTransCmd(true),
      protocol.pttTransCmd(false),
      protocol.FRIEND_CLUE_COMMAND,
      protocol.HIGHWAY_SESSION_CMD,
      'OidbSvc.0x480_9_IMCore',
      'OidbSvc.0x4ff_9_IMCore',
      'OidbSvc.0x42d_4',
      'OidbSvc.0xcf4',
      'scupdate.handle',
      'LongConn.OffPicUp',
      'ImgStore.BDHExpressionRoam',
    ])
      assertAccounted(cmd);
  });

  it('全部显式不签名命令三端保持 false / mode 3 且无警告', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      for (const [cmd, rule] of Object.entries(SIGN_RULES)) {
        if (rule.sign !== 'none') continue;
        for (const platform of ['linux', 'win32', 'darwin'] as const) {
          expect(resolveSign(cmd, platform), `${cmd} ${platform}`).toEqual({
            needSign: false,
            mode: 3,
          });
        }
      }
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it.each(Object.entries(UNCONFIRMED_SIGN_COMMANDS))(
    '待确认命令 %s 保留默认参数并提醒原因',
    (cmd, reason) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        for (const platform of ['linux', 'win32', 'darwin'] as const) {
          expect(resolveSign(cmd, platform)).toEqual({ needSign: false, mode: 3 });
        }
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(reason));
      } finally {
        warn.mockRestore();
      }
    },
  );
});

describe('不签名的命令不报告 mode', () => {
  it('0x9082_1/2：macOS 不签名，模式未知，resolved mode 必须是 3', () => {
    // #126 只测出 macOS 对贴表情不签名，没有任何 mode 实测依据。
    for (const cmd of ['OidbSvcTrpcTcp.0x9082_1', 'OidbSvcTrpcTcp.0x9082_2']) {
      const darwin = resolveSign(cmd, 'darwin');
      expect(darwin.needSign).toBe(false);
      expect(darwin.mode).toBe(3);
      // Windows / Linux 仍签，mode 各自正确。
      expect(resolveSign(cmd, 'win32')).toEqual({ needSign: true, mode: 2 });
      expect(resolveSign(cmd, 'linux')).toEqual({ needSign: true, mode: 3 });
    }
  });

  it('表里所有在某个平台不签名的命令，该平台解析出的 mode 都是 3', () => {
    for (const cmd of Object.keys(SIGN_RULES)) {
      for (const platform of ['linux', 'win32', 'darwin'] as const) {
        const { needSign, mode } = resolveSign(cmd, platform);
        if (!needSign) expect(mode, `${cmd}@${platform}`).toBe(3);
      }
    }
  });
});
