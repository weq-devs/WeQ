import type { AccountSession } from '@weq/account';
import { UidMap, type HiddenSession } from '@weq/db';
import { expect, it, vi } from 'vitest';
import { HiddenSessionService } from '../src/account/hidden_session';

const uid = 'u_hidden_peer_12345678901234567890';
const preview = { kind: 'text' as const, textContent: '合成隐藏会话正文' };
const latest = { sendTime: 123n, senderUid: 'u_sender', elements: [preview] };
function row(targetUid = uid, chatType = 'KCHATTYPEC2C'): HiddenSession {
  return {
    storageKey: `hidden:${targetUid}`,
    chatType,
    targetUid,
    targetUin: '10001',
    flags: { f49702: false, f49703: false, f49704: false, f49705: false },
  };
}
function fixture(uidMap: UidMap, rows = [row()], inRecent = new Set(rows.map((r) => r.targetUid))) {
  const c2c = vi.fn().mockResolvedValue([latest]);
  const group = vi.fn().mockResolvedValue([latest]);
  const exists = vi.fn().mockResolvedValue(inRecent);
  const capped = vi.fn(() => {
    throw Error('不应读取限额目录');
  });
  const session = {
    uidMap,
    hiddenSessions: { listHiddenSessions: vi.fn().mockResolvedValue(rows) },
    recentContacts: { hasTargetUids: exists, getRecentContact: capped },
    c2cMsgs: { listLatest: c2c },
    groupMsgs: { listLatest: group },
  } as unknown as AccountSession;
  return { service: new HiddenSessionService(session), c2c, group, exists, capped };
}

it.each([0n, 42n, 9007199254740993n])(
  '隐藏私聊使用已有 sortNo=%s，完整保留摘要与身份',
  async (sortNo) => {
    const f = fixture(UidMap.from([{ uid, sortNo, uin: 10001n }]));
    expect(await f.service.listHiddenSessions()).toEqual([
      {
        storageKey: `hidden:${uid}`,
        chatType: 'KCHATTYPEC2C',
        targetUid: uid,
        targetUin: '10001',
        resolvable: true,
        sendTime: 123n,
        senderUid: 'u_sender',
        preview,
      },
    ]);
    expect(f.c2c.mock.calls).toEqual([[{ sortNo }, 1]]);
    expect(f.exists.mock.calls).toEqual([[[uid]]]);
    expect(f.capped).not.toHaveBeenCalled();
  },
);

it('新增映射补查后复用账号常驻结果', async () => {
  const lookup = vi.fn().mockResolvedValue({ uid, sortNo: 77n, uin: 10001n });
  const f = fixture(UidMap.from([], lookup));
  await f.service.listHiddenSessions();
  await f.service.listHiddenSessions();
  expect(lookup.mock.calls).toEqual([[uid]]);
  expect(f.c2c.mock.calls.map(([partition]) => partition)).toEqual([
    { sortNo: 77n },
    { sortNo: 77n },
  ]);
});

it.each(['missing', 'failed'])('隐藏私聊映射 %s 仍按 UID 完整读取', async (kind) => {
  const lookup =
    kind === 'missing'
      ? vi.fn().mockResolvedValue(undefined)
      : vi.fn().mockRejectedValue(new Error('合成映射错误'));
  const f = fixture(UidMap.from([], lookup));
  expect((await f.service.listHiddenSessions())[0]?.preview).toEqual(preview);
  expect(f.c2c.mock.calls).toEqual([[{ uid }, 1]]);
});

it('补查取消后不再启动未索引读取', async () => {
  const error = new DOMException('合成取消', 'AbortError');
  const f = fixture(UidMap.from([], vi.fn().mockRejectedValue(error)));
  await expect(f.service.listHiddenSessions()).rejects.toBe(error);
  expect(f.c2c).not.toHaveBeenCalled();
});

it('隐藏目录次序、群读取和精确存在条件不变，失效行不查消息或映射', async () => {
  const lookup = vi.fn();
  const absent = 'u_absent_peer_12345678901234567890';
  const rows = [row('70001', 'KCHATTYPEGROUP'), row(absent), row(), row('unknown', 'unknown')];
  const f = fixture(
    UidMap.from([{ uid, sortNo: 42n, uin: 10001n }], lookup),
    rows,
    new Set(['70001', uid, 'unknown']),
  );
  const results = await f.service.listHiddenSessions();
  expect(results.map((r) => [r.targetUid, r.resolvable])).toEqual([
    ['70001', true],
    [absent, false],
    [uid, true],
    ['unknown', false],
  ]);
  expect(f.group.mock.calls).toEqual([['70001', 1]]);
  expect(f.c2c.mock.calls).toEqual([[{ sortNo: 42n }, 1]]);
  expect(lookup).not.toHaveBeenCalled();
  expect(f.exists.mock.calls).toEqual([[rows.map((r) => r.targetUid)]]);
  expect(f.capped).not.toHaveBeenCalled();
});

it('有效但没有消息的隐藏私聊仍返回可解析空摘要', async () => {
  const f = fixture(UidMap.from([{ uid, sortNo: 42n, uin: 10001n }]));
  f.c2c.mockResolvedValue([]);
  expect((await f.service.listHiddenSessions())[0]).toMatchObject({
    resolvable: true,
    sendTime: 0n,
    senderUid: '',
    preview: null,
  });
});
