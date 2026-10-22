import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DeletedMsgStore } from '../src/account/deleted_msgs';
import { MsgService } from '../src/account/msg';
import type { GapFetchedMessage } from '../src/account/gap_history';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const message: GapFetchedMessage = {
  kind: 'group',
  conv: '777',
  msgId: '1234',
  msgSeq: '2',
  senderUid: 'u_self',
  senderUin: '10001',
  sendTime: '1792544400',
  elements: [],
  sourceFormat: 'protocol',
  localSent: true,
};
it('自己的缓存消息可删除和恢复，标记持久化并按会话隔离，不读取或改写 QQ 原库', () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-sent-delete-'));
  roots.push(root);
  const path = join(root, 'deleted.json');
  const session = new Proxy(
    {},
    {
      get() {
        throw new Error('缓存删除不能读取 QQ 原库');
      },
    },
  ) as never;
  const service = new MsgService(session, new DeletedMsgStore(path));
  const id = 'roaming:protocol:2:1234';
  expect(service.deleteCachedSentMessage(message)).toBe(true);
  expect(service.deleteCachedSentMessage({ ...message, conv: '888' })).toBe(true);
  const reopened = new MsgService(session, new DeletedMsgStore(path));
  expect(reopened.getDeletedMsgIds('group', '777')).toEqual([id]);
  expect(reopened.getDeletedMsgIds('group', '888')).toEqual([id]);
  expect(reopened.restoreCachedSentMessage(id, 'c2c', '777')).toBe(false);
  expect(reopened.restoreCachedSentMessage(id, 'group', '777')).toBe(true);
  expect(reopened.getDeletedMsgIds('group', '777')).toEqual([]);
  expect(reopened.getDeletedMsgIds('group', '888')).toEqual([id]);
  expect(
    new MsgService(session, new DeletedMsgStore(path)).getDeletedMsgIds('group', '777'),
  ).toEqual([]);
});
it('普通漫游与各来源均可删除，隐藏标记持久化且可恢复', () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-sent-delete-'));
  roots.push(root);
  const service = new MsgService({} as never, new DeletedMsgStore(join(root, 'deleted.json')));
  const store = new DeletedMsgStore(join(root, 'deleted.json'));
  const cached = new MsgService({} as never, store);
  for (const sourceFormat of [undefined, 'native', 'protocol'] as const) {
    const row = { ...message, sourceFormat, localSent: false };
    const id = `roaming:${sourceFormat ? `${sourceFormat}:` : ''}2:1234`;
    expect(cached.deleteCachedSentMessage(row, true)).toBe(true);
    expect(store.listHiddenIds('group', '777')).toContain(id);
    expect(new DeletedMsgStore(join(root, 'deleted.json')).listHiddenIds('group', '777')).toContain(
      id,
    );
    expect(cached.restoreCachedSentMessage(id, 'group', '888')).toBe(false);
    expect(cached.restoreCachedSentMessage(id, 'group', '777')).toBe(true);
    expect(store.listHiddenIds('group', '777')).not.toContain(id);
  }
  for (const row of [
    { ...message, kind: 'c2c' as const, ntSeqVerified: false },
    { ...message, msgSeq: '0' },
    { ...message, msgSeq: '4294967296' },
    { ...message, msgId: 'invalid' },
  ])
    expect(service.deleteCachedSentMessage(row)).toBe(false);
  expect(service.getDeletedMsgIds('group', '777')).toEqual([]);
});

it('补拉只解除已实际收到的隐藏记录，不误恢复其他会话、序号或未隐藏记录', () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-sent-delete-'));
  roots.push(root);
  const path = join(root, 'deleted.json');
  const store = new DeletedMsgStore(path);
  const service = new MsgService({} as never, store);
  service.deleteCachedSentMessage(message, true);
  service.deleteCachedSentMessage({ ...message, conv: '888' }, true);
  service.deleteCachedSentMessage({ ...message, msgSeq: '3' }, true);
  service.deleteCachedSentMessage({ ...message, msgId: '5678' }, false);
  store.restoreFetched([{ ...message, sourceFormat: 'native' }]);
  const reopened = new MsgService({} as never, new DeletedMsgStore(path));
  expect(reopened.getDeletedMsgIds('group', '777')).toEqual([
    'roaming:protocol:3:1234',
    'roaming:protocol:2:5678',
  ]);
  expect(reopened.getHiddenDeletedMsgIds('group', '777')).toEqual(['roaming:protocol:3:1234']);
  expect(reopened.getHiddenDeletedMsgIds('group', '888')).toEqual(['roaming:protocol:2:1234']);
});

it('删除后格式更新仍隐藏同一精确消息，旧窗口的格式身份也可恢复且不跨会话', () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-delete-format-'));
  roots.push(root);
  const store = new DeletedMsgStore(join(root, 'deleted.json'));
  const service = new MsgService({} as never, store);
  for (const cachedFormat of [undefined, 'native', 'protocol'] as const) {
    const row = { ...message, sourceFormat: cachedFormat, localSent: false };
    for (const displayFormat of [undefined, 'native', 'protocol'] as const) {
      expect(service.deleteCachedSentMessage(row, true)).toBe(true);
      expect(store.isHiddenCached({ ...row, sourceFormat: displayFormat })).toBe(true);
      expect(store.isHiddenCached({ ...row, sourceFormat: displayFormat, conv: '888' })).toBe(
        false,
      );
      expect(store.isHiddenCached({ ...row, sourceFormat: displayFormat, msgId: '5678' })).toBe(
        false,
      );
      const id = `roaming:${displayFormat ? `${displayFormat}:` : ''}${row.msgSeq}:${row.msgId}`;
      expect(service.restoreCachedSentMessage(id, 'group', '777')).toBe(true);
      expect(store.listHiddenIds('group', '777')).toEqual([]);
    }
  }
});

it('原库重复删除切换隐藏选项不覆盖原始类型，恢复后仍回到删除前类型', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-delete-toggle-'));
  roots.push(root);
  const store = new DeletedMsgStore(join(root, 'deleted.json'));
  let type = { msgType: 9n, subType: 16n };
  const db = {
    readMsgType: async () => type,
    writeMsgType: async (_id: bigint, msgType: bigint, subType: bigint) => {
      type = { msgType, subType };
      return 1;
    },
  };
  const service = new MsgService({ c2cMsgs: db } as never, store);
  expect(await service.deleteMessage(123n, 'c2c', 'u_peer')).toBe(true);
  expect(await service.deleteMessage(123n, 'c2c', 'u_peer', true)).toBe(true);
  expect(store.listHiddenIds('c2c', 'u_peer')).toEqual(['123']);
  expect(await service.deleteMessage(123n, 'c2c', 'u_other', false)).toBe(false);
  expect(await service.restoreMessage(123n)).toBe(true);
  expect(type).toEqual({ msgType: 9n, subType: 16n });
  expect(store.listHiddenIds('c2c', 'u_peer')).toEqual([]);
});
