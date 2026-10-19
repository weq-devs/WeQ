import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import { decode } from '@weq/protocol';
import { ReportRead } from '@weq/protocol';
import { UnreadInfoService } from '../src/account/unread_info';
import { ssoWorkState } from '../src/account/sso_lifecycle';

afterEach(() => vi.useRealTimers());

function setup() {
  let enabled = true;
  let pid: number | null = 9;
  const nt = {
    hasSsoSession: vi.fn(async () => true),
    sendPacket: vi.fn(
      async (_pid: number, _cmd: string, _body: Buffer, _sign: boolean): Promise<Buffer> =>
        Buffer.alloc(0),
    ),
  };
  const markRead = vi.fn(async () => true);
  const listFrom = vi.fn(async () => [{ msgSeq: 50n, clientSeq: 999n, sendTime: 123n }]);
  const getUnreadInfos = vi.fn(async () => [{ latestSeq: '100' }]);
  const session = {
    unreadInfo: { markRead, getUnreadInfos },
    uidMap: { sortNoByUid: () => 7n },
    c2cMsgs: { listBySeqsInPartition: listFrom },
  } as unknown as AccountSession;
  const service = new UnreadInfoService(session, {
    nt,
    enabled: () => enabled,
    resolvePid: () => pid,
  });
  return {
    service,
    nt,
    markRead,
    listFrom,
    getUnreadInfos,
    disable: () => {
      enabled = false;
      service.cancelReports();
    },
    enable: () => {
      enabled = true;
    },
    offline: () => {
      pid = null;
    },
  };
}

async function settled(service: UnreadInfoService, state = 'acknowledged') {
  await vi.waitFor(() => expect(service.getReadReportStatus().state).toBe(state));
}

describe('已读上报服务', () => {
  it('读取消息期间会话代次变化时不向新会话补发旧请求', async () => {
    const f = setup();
    let release: (() => void) | undefined;
    f.getUnreadInfos.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([{ latestSeq: '100' }]);
        }),
    );
    const pending = f.service.markReadAndReport(2, '100', '50');
    ssoWorkState(f.nt, 9).owner = {};
    release!();
    expect((await pending).report.state).toBe('unavailable');
    expect(f.nt.sendPacket).not.toHaveBeenCalled();
  });

  it('关闭后重新开启不会复活旧请求，旧请求结束也不能清掉新请求', async () => {
    const f = setup();
    let release: ((value: Buffer) => void) | undefined;
    f.nt.sendPacket.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await f.service.markReadAndReport(2, '100', '50');
    await vi.waitFor(() => expect(release).toBeDefined());
    f.disable();
    f.enable();
    await f.service.markReadAndReport(2, '100', '60');
    release!(Buffer.alloc(0));
    await settled(f.service);
    expect(f.service.getReadReportStatus().sequence).toBe('60');
    expect(f.nt.sendPacket).toHaveBeenCalledTimes(2);
  });

  it('同序号灰条不替代原消息时间，时间冲突时跳过而不是猜测', async () => {
    const f = setup();
    f.listFrom.mockResolvedValueOnce([
      { msgSeq: 50n, clientSeq: 0n, sendTime: 999n },
      { msgSeq: 50n, clientSeq: 12n, sendTime: 123n },
    ]);
    await f.service.markReadAndReport(1, 'u_x', '50');
    await settled(f.service);
    expect(decode(ReportRead.reqSchema, f.nt.sendPacket.mock.calls[0]![2])).toMatchObject({
      c2c: { timestamp: 123n },
    });
    f.listFrom.mockResolvedValueOnce([
      { msgSeq: 60n, clientSeq: 12n, sendTime: 123n },
      { msgSeq: 60n, clientSeq: 13n, sendTime: 124n },
    ]);
    expect((await f.service.markReadAndReport(1, 'u_x', '60')).report.state).toBe('skipped');
    expect(f.nt.sendPacket).toHaveBeenCalledTimes(1);
  });

  it('本地结果先返回，上报应答后记录状态；同水位已读无写入也能补报且只上报一次', async () => {
    const f = setup();
    f.markRead.mockResolvedValue(false);
    expect(await f.service.markReadAndReport(2, '100', '50')).toMatchObject({
      changed: true,
      report: { state: 'pending' },
    });
    await settled(f.service);
    expect((await f.service.markReadAndReport(2, '100', '50')).changed).toBe(false);
    await settled(f.service);
    expect(f.nt.sendPacket).toHaveBeenCalledTimes(1);
  });

  it('私聊只使用本地目标消息的 NT 序号和时间，不能取 clientSeq 或当前时间', async () => {
    const f = setup();
    await f.service.markReadAndReport(1, 'u_x', '50');
    await settled(f.service);
    expect(f.listFrom).toHaveBeenCalledWith({ sortNo: 7n }, [50n]);
    expect(decode(ReportRead.reqSchema, f.nt.sendPacket.mock.calls[0]![2])).toMatchObject({
      c2c: { targetUid: 'u_x', sequence: 50n, timestamp: 123n },
    });
  });

  it('开关关闭、离线或缺少原消息时保持本地结果，不发包', async () => {
    const disabled = setup();
    disabled.disable();
    expect((await disabled.service.markReadAndReport(2, '100', '50')).report.state).toBe(
      'disabled',
    );
    const offline = setup();
    offline.offline();
    expect((await offline.service.markReadAndReport(2, '100', '50')).report.state).toBe(
      'unavailable',
    );
    const missing = setup();
    missing.listFrom.mockResolvedValueOnce([]);
    expect((await missing.service.markReadAndReport(1, 'u_x', '50')).report.state).toBe('skipped');
    expect(disabled.nt.sendPacket).not.toHaveBeenCalled();
    expect(offline.nt.sendPacket).not.toHaveBeenCalled();
    expect(missing.nt.sendPacket).not.toHaveBeenCalled();
    expect(disabled.markRead).toHaveBeenCalled();
  });

  it('不把超出本地会话水位、设备伪 UID 或无效序号上报', async () => {
    const f = setup();
    for (const [chatType, uid, sequence] of [
      [2, '100', '101'],
      [1, 'device', '50'],
      [2, '100', '0'],
    ] as const)
      expect((await f.service.markReadAndReport(chatType, uid, sequence)).report.state).toBe(
        'skipped',
      );
    expect(f.nt.sendPacket).not.toHaveBeenCalled();
  });

  it('发送失败有限重试，耗尽后不把本地成功改成失败', async () => {
    vi.useFakeTimers();
    const f = setup();
    f.nt.sendPacket.mockRejectedValue(new Error('暂时断网'));
    const result = await f.service.markReadAndReport(2, '100', '50');
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.nt.sendPacket).toHaveBeenCalledTimes(3);
    expect(result.changed).toBe(true);
    expect(f.service.getReadReportStatus().state).toBe('failed');
  });

  it('关闭开关或注销账号后，停止退避重试；SSO 会话被替换也不再发包', async () => {
    vi.useFakeTimers();
    for (const mode of ['disable', 'dispose', 'replace'] as const) {
      const f = setup();
      f.nt.sendPacket.mockRejectedValue(new Error('暂时断网'));
      await f.service.markReadAndReport(2, '100', '50');
      await vi.advanceTimersByTimeAsync(0);
      expect(f.nt.sendPacket).toHaveBeenCalledTimes(1);
      if (mode === 'disable') f.disable();
      else if (mode === 'dispose') f.service.dispose();
      else ssoWorkState(f.nt, 9).owner = {};
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.nt.sendPacket).toHaveBeenCalledTimes(1);
    }
  });

  it('同一会话重复请求合并，新水位等待在途请求后发送，未知应答不记成成功', async () => {
    const f = setup();
    let release: ((value: Buffer) => void) | undefined;
    f.nt.sendPacket.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await f.service.markReadAndReport(2, '100', '50');
    await vi.waitFor(() => expect(release).toBeDefined());
    await f.service.markReadAndReport(2, '100', '50');
    await f.service.markReadAndReport(2, '100', '60');
    await f.service.markReadAndReport(2, '100', '55');
    expect(f.nt.sendPacket).toHaveBeenCalledTimes(1);
    release!(Buffer.alloc(0));
    await settled(f.service);
    expect(f.nt.sendPacket).toHaveBeenCalledTimes(2);
    expect(f.service.getReadReportStatus().sequence).toBe('60');
    f.nt.sendPacket.mockResolvedValueOnce(Buffer.from([8, 1]));
    await f.service.markReadAndReport(2, '100', '70');
    await settled(f.service, 'unconfirmed');
    expect(f.nt.sendPacket).toHaveBeenCalledTimes(3);
  });
});
