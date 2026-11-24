import { afterEach, describe, expect, it, vi } from 'vitest';
import { DATALINE_UID_TO_DEVICE } from '@weq/codec';
import type { AccountSession } from '@weq/account';
import { decode, encode, ReadedReport } from '@weqbot/protocol';
import { ReportRead } from '@weqbot/protocol';
import { UnreadInfoService } from '../src/account/unread_info';
import { ssoWorkState } from '../src/account/sso_lifecycle';

afterEach(() => vi.useRealTimers());

function setup() {
  let pid: number | null = 9;
  const nt = {
    hasSsoSession: vi.fn(async () => true),
    sendPacket: vi.fn(
      async (_pid: number, _cmd: string, _body: Buffer, _sign: boolean): Promise<Buffer> =>
        Buffer.alloc(0),
    ),
  };
  const acknowledged = vi.fn();
  const markRead = vi.fn(async () => true);
  const listFrom = vi.fn(async () => [
    { msgSeq: 50n, msgType: 2n, clientSeq: 999n, sendTime: 123n },
  ]);
  const calendarMessage = vi.fn(async (_partition: unknown, msgId: bigint) => [
    { msgId, msgSeq: 0n, sendTime: msgId },
  ]);
  const snapshot = (target: { chatType: number; uid: string }) => ({
    ...target,
    peer: `${target.chatType}_${target.uid}`,
    latestSeq: '100',
  });
  const getUnreadInfos = vi.fn(async (targets: Array<{ chatType: number; uid: string }>) =>
    targets.map(snapshot),
  );
  const countDeviceIncoming = vi.fn(async () => 0);
  const datalineMessage = vi.fn(async (_part: { uid: string }, _id: bigint) => [
    { senderUid: _part.uid, sendTime: 1700000000n, msgType: 2n },
  ]);
  const session = {
    selfUid: 'u_self',
    context: { uin: '10001' },
    unreadInfo: { markRead, getUnreadInfos, countDeviceIncoming },
    datalineMsgs: { calendarMessage: datalineMessage },
    uidMap: { sortNoByUid: () => 7n },
    c2cMsgs: { listBySeqsInPartition: listFrom, calendarMessage },
  } as unknown as AccountSession;
  const service = new UnreadInfoService(session, {
    nt,
    resolvePid: () => pid,
    onAcknowledged: acknowledged,
  });
  return {
    service,
    acknowledged,
    nt,
    markRead,
    listFrom,
    getUnreadInfos,
    calendarMessage,
    countDeviceIncoming,
    offline: () => {
      pid = null;
    },
  };
}

async function settled(service: UnreadInfoService, state = 'acknowledged') {
  await vi.waitFor(() => expect(service.getReadReportStatus().state).toBe(state));
}

describe('已读上报服务', () => {
  it('公众号按实际消息时间上报零序号，匹配的服务器响应确认后才通知代理', async () => {
    const f = setup();
    f.nt.sendPacket.mockResolvedValueOnce(
      Buffer.from(
        encode(ReadedReport.respSchema, {
          c2cList: [{ uid: 'u_mail' }],
        }),
      ),
    );
    expect(
      await f.service.reportOfficialRead('u_mail', '0:1700000000:1700000000', () => true),
    ).toMatchObject({ state: 'acknowledged' });
    expect(f.nt.sendPacket.mock.calls[0]![2].toString('hex')).toBe(
      '12101206755f6d61696c1880e2cfaa062000',
    );
    expect(f.acknowledged).toHaveBeenCalledWith({
      kind: 'official',
      targetUid: 'u_mail',
      sequence: 0,
      timestamp: 1700000000,
    });
    expect(f.markRead).not.toHaveBeenCalled();
    f.nt.sendPacket.mockResolvedValueOnce(
      Buffer.from(
        encode(ReadedReport.respSchema, {
          c2cList: [{ uid: 'u_other' }],
        }),
      ),
    );
    expect(
      await f.service.reportOfficialRead('u_mail', '0:1700000001:1700000001', () => true),
    ).toMatchObject({ state: 'unconfirmed' });
    expect(f.acknowledged).toHaveBeenCalledOnce();
  });

  it('公众号手动阅读会发起上报，失效的阅读观察停止发送与代理补投', async () => {
    const f = setup();
    f.nt.sendPacket.mockResolvedValue(
      Buffer.from(encode(ReadedReport.respSchema, { c2cList: [{ uid: 'u_mail' }] })),
    );
    const position = '0:1700000000:1700000000';
    expect(await f.service.reportOfficialRead('u_mail', position, () => true, true)).toMatchObject({
      state: 'acknowledged',
    });
    let current = true;
    let release: ((result: Buffer) => void) | undefined;
    f.nt.sendPacket.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = f.service.reportOfficialRead(
      'u_mail',
      '0:1700000001:1700000001',
      () => current,
      true,
    );
    await vi.waitFor(() => expect(release).toBeDefined());
    current = false;
    release!(Buffer.alloc(0));
    expect(await pending).toMatchObject({ state: 'unavailable' });
    expect(f.acknowledged).toHaveBeenCalledOnce();
  });

  it('公众号同会话零序号上报按最大时间合并', async () => {
    const f = setup();
    const response = Buffer.from(encode(ReadedReport.respSchema, { c2cList: [{ uid: 'u_mail' }] }));
    f.nt.sendPacket.mockResolvedValue(response);
    let release: ((result: Buffer) => void) | undefined;
    f.nt.sendPacket.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = f.service.reportOfficialRead('u_mail', '0:1700000000:1700000000', () => true);
    await vi.waitFor(() => expect(release).toBeDefined());
    const next = f.service.reportOfficialRead('u_mail', '0:1700000002:1700000002', () => true);
    await vi.waitFor(() => expect(f.calendarMessage).toHaveBeenCalledTimes(2));
    release!(response);
    await Promise.all([first, next]);
    expect(f.nt.sendPacket).toHaveBeenCalledTimes(2);
    expect(decode(ReportRead.reqSchema, f.nt.sendPacket.mock.calls[1]![2])).toMatchObject({
      c2c: { timestamp: 1700000002n, sequence: 0n },
    });
  });

  it('结构化回包达到本次水位后通知本机同步，落后的回包保持未确认', async () => {
    const f = setup();
    f.nt.sendPacket.mockResolvedValueOnce(
      Buffer.from(
        encode(ReadedReport.respSchema, {
          groupList: [{ groupUin: 100, resultCode: 0, readSeq: 50, latestSeq: 60 }],
        }),
      ),
    );
    await f.service.markReadAndReport(2, '100', '50');
    await settled(f.service);
    expect(f.acknowledged).toHaveBeenLastCalledWith({ kind: 'group', groupUin: 100, sequence: 50 });
    f.nt.sendPacket.mockResolvedValueOnce(
      Buffer.from(
        encode(ReadedReport.respSchema, {
          groupList: [{ groupUin: 100, resultCode: 0, readSeq: 50, latestSeq: 60 }],
        }),
      ),
    );
    await f.service.markReadAndReport(2, '100', '60');
    await settled(f.service, 'unconfirmed');
    expect(f.acknowledged).toHaveBeenCalledTimes(1);
  });

  it('手动上报会等待服务器确认且不重复写本地库', async () => {
    const f = setup();
    const options = { manual: true, write: false } as const;
    expect((await f.service.markReadAndReport(2, '100', '50', options)).report.state).toBe(
      'acknowledged',
    );
    expect(f.nt.sendPacket).toHaveBeenCalledTimes(1);
    expect(f.markRead).not.toHaveBeenCalled();
  });
  it('读取消息期间会话代次变化时不向新会话补发旧请求', async () => {
    const f = setup();
    let release: (() => void) | undefined;
    f.getUnreadInfos.mockImplementationOnce(
      (targets) =>
        new Promise((resolve) => {
          release = () =>
            resolve(
              targets.map((target) => ({
                ...target,
                peer: `${target.chatType}_${target.uid}`,
                latestSeq: '100',
              })),
            );
        }),
    );
    const pending = f.service.markReadAndReport(2, '100', '50');
    ssoWorkState(f.nt, 9).owner = {};
    release!();
    expect((await pending).report.state).toBe('unavailable');
    expect(f.nt.sendPacket).not.toHaveBeenCalled();
  });

  it('取消上报后旧请求结束不会清掉新请求', async () => {
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
    f.service.cancelReports();
    await f.service.markReadAndReport(2, '100', '60');
    release!(Buffer.alloc(0));
    await settled(f.service);
    expect(f.service.getReadReportStatus().sequence).toBe('60');
    expect(f.nt.sendPacket).toHaveBeenCalledTimes(2);
  });

  it('同序号灰条不替代原消息时间，时间冲突时跳过而不是猜测', async () => {
    const f = setup();
    f.listFrom.mockResolvedValueOnce([
      { msgSeq: 50n, msgType: 5n, clientSeq: 99n, sendTime: 999n },
      { msgSeq: 50n, msgType: 1n, clientSeq: 13n, sendTime: 998n },
      { msgSeq: 50n, msgType: 2n, clientSeq: 0n, sendTime: 123n },
    ]);
    await f.service.markReadAndReport(1, 'u_x', '50');
    await settled(f.service);
    expect(decode(ReportRead.reqSchema, f.nt.sendPacket.mock.calls[0]![2])).toMatchObject({
      c2c: { timestamp: 123n },
    });
    f.listFrom.mockResolvedValueOnce([
      { msgSeq: 60n, msgType: 2n, clientSeq: 12n, sendTime: 123n },
      { msgSeq: 60n, msgType: 2n, clientSeq: 0n, sendTime: 124n },
    ]);
    expect((await f.service.markReadAndReport(1, 'u_x', '60')).report.state).toBe('skipped');
    expect(f.nt.sendPacket).toHaveBeenCalledTimes(1);
  });

  it('同水位无本地写入也能补报，先返回待上报、确认后不再重复', async () => {
    const f = setup();
    f.markRead.mockResolvedValue(false);
    expect(await f.service.markReadAndReport(2, '100', '50')).toMatchObject({
      changed: false,
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

  it('离线或缺少原消息时保持本地结果，不发包', async () => {
    const offline = setup();
    offline.offline();
    expect((await offline.service.markReadAndReport(2, '100', '50')).report.state).toBe(
      'unavailable',
    );
    const missing = setup();
    missing.listFrom.mockResolvedValueOnce([]);
    expect((await missing.service.markReadAndReport(1, 'u_x', '50')).report.state).toBe('skipped');
    expect(offline.nt.sendPacket).not.toHaveBeenCalled();
    expect(missing.nt.sendPacket).not.toHaveBeenCalled();
    expect(offline.markRead).toHaveBeenCalled();
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

  it('取消上报、注销账号或替换 SSO 会话后停止退避重试', async () => {
    vi.useFakeTimers();
    for (const mode of ['cancel', 'dispose', 'replace'] as const) {
      const f = setup();
      f.nt.sendPacket.mockRejectedValue(new Error('暂时断网'));
      await f.service.markReadAndReport(2, '100', '50');
      await vi.advanceTimersByTimeAsync(0);
      expect(f.nt.sendPacket).toHaveBeenCalledTimes(1);
      if (mode === 'cancel') f.service.cancelReports();
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

it('设备阅读用本人 UID 和原发送时间，不写普通序号或送入私聊通知代理', async () => {
  const f = setup();
  const [uid] = Object.entries(DATALINE_UID_TO_DEVICE).find(([, name]) => name === 'pad')!;
  const device = {
    uid,
    chatType: 8,
    peer: `8_${uid}`,
    latestSeq: '0',
    deviceRead: '0:1699999999:15',
    deviceLatest: '0:1700000000:20',
  };
  f.getUnreadInfos.mockResolvedValue([device]);
  f.countDeviceIncoming.mockResolvedValueOnce(3).mockResolvedValueOnce(2);
  expect((await f.service.getUnreadInfos([{ chatType: 8, uid }]))[0]?.unreadCount).toBe(3);
  f.nt.sendPacket.mockResolvedValueOnce(
    Buffer.from(
      encode(ReadedReport.respSchema, {
        c2cList: [{ uid: 'u_self', readSeq: 10n }],
      }),
    ),
  );
  expect(
    await f.service.markReadAndReport(8, uid, undefined, {
      devicePosition: '0:1700000000:18',
    }),
  ).toMatchObject({ changed: true, report: { state: 'pending' } });
  await settled(f.service);
  expect(f.nt.sendPacket.mock.calls[0]![2].toString('hex')).toBe(
    '120e1206755f73656c661880e2cfaa06',
  );
  expect(f.markRead).not.toHaveBeenCalled();
  expect(f.acknowledged).not.toHaveBeenCalled();
  expect((await f.service.getUnreadInfos([{ chatType: 8, uid }]))[0]?.unreadCount).toBe(2);
  expect(f.countDeviceIncoming).toHaveBeenLastCalledWith(
    expect.objectContaining({ uid, chatType: 8 }),
    '0:1700000000:18',
    '0:1700000000:20',
  );
  const caughtUp = { ...device, deviceRead: device.deviceLatest };
  f.getUnreadInfos.mockResolvedValue([caughtUp]);
  await f.service.compareQqCounts();
  expect((await f.service.getUnreadInfos([{ chatType: 8, uid }]))[0]?.unreadCount).toBe(0);
});
